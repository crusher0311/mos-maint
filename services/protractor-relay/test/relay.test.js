import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createRelayServer } from "../src/app.js";

const servers = [];
const journalDirs = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  for (const directory of journalDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(handler, overrides = {}) {
  const upstream = http.createServer(handler);
  const upstreamUrl = await listen(upstream);
  const journalDir = mkdtempSync(join(tmpdir(), "protractor-relay-"));
  journalDirs.push(journalDir);
  const config = {
    secret: "test-secret-with-at-least-thirty-two-bytes",
    upstream: new URL(upstreamUrl),
    requestBodyLimit: 4096,
    responseBodyLimit: 4096,
    timeoutMs: 100,
    requestTimeoutMs: 1000,
    upstreamMinIntervalMs: 0,
    maxCallerDeadlineMs: 180_000,
    clockSkewSeconds: 60,
    replayTtlSeconds: 120,
    replayMaxEntries: 1000,
    replayJournalPath: join(journalDir, "replay.journal"),
    ...overrides
  };
  const relay = createRelayServer(config);
  return { url: await listen(relay), config };
}

function auth(body, secret, changes = {}) {
  const timestamp = changes["x-relay-timestamp"] || String(Math.floor(Date.now() / 1000));
  const nonce = changes["x-relay-nonce"] || `nonce_${crypto.randomUUID().replaceAll("-", "")}`;
  const requestId = changes["x-relay-request-id"] || `request-${crypto.randomUUID()}`;
  const hash = createHash("sha256").update(body).digest("hex");
  const canonical = [timestamp, nonce, requestId, "POST", "/relay", hash].join("\n");
  const signature = changes["x-relay-signature"] ||
    `sha256=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
  return {
    "content-type": "application/json",
    "x-relay-timestamp": timestamp,
    "x-relay-nonce": nonce,
    "x-relay-request-id": requestId,
    ...changes,
    "x-relay-signature": signature
  };
}

async function relayFetch(url, config, value, changes = {}) {
  const withDeadline = typeof value === "string" || value.deadlineAtMs !== undefined
    ? value
    : { ...value, deadlineAtMs: Date.now() + 30_000 };
  const body = typeof withDeadline === "string" ? withDeadline : JSON.stringify(withDeadline);
  return fetch(`${url}/relay`, {
    method: "POST",
    headers: auth(body, config.secret, changes),
    body,
    redirect: "manual"
  });
}

test("health endpoint is public and minimal", async () => {
  const { url } = await fixture((_req, res) => res.end());
  const response = await fetch(`${url}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(response.headers.get("x-relay-contract-version"), "2");
});

test("rejects missing, invalid, and stale authentication", async () => {
  const { url, config } = await fixture((_req, res) => res.end());
  const value = { type: "rest", method: "GET", path: "/IntegrationServices/1.0/Customers" };
  const body = JSON.stringify(value);
  assert.equal((await fetch(`${url}/relay`, {
    method: "POST", headers: { "content-type": "application/json" }, body
  })).status, 401);
  assert.equal((await relayFetch(url, config, value, { "x-relay-signature": "sha256=" + "0".repeat(64) })).status, 401);
  assert.equal((await relayFetch(url, config, value, {
    "x-relay-timestamp": String(Math.floor(Date.now() / 1000) - 120)
  })).status, 401);
});

test("marks relay-generated errors without marking provider responses", async () => {
  const { url, config } = await fixture((_req, res) => {
    res.setHeader("X-Relay-Error-Code", "provider-forged-marker");
    res.end("provider");
  });
  const invalid = await fetch(`${url}/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get("x-relay-error-code"), "invalid_auth");
  const provider = await relayFetch(url, config, {
    type: "rest", method: "GET", path: "/IntegrationServices/1.0/provider"
  });
  assert.equal(provider.status, 200);
  assert.equal(provider.headers.get("x-relay-error-code"), null);
});

test("blocks a replay of a valid nonce and request id", async () => {
  const { url, config } = await fixture((_req, res) => res.end("ok"));
  const body = JSON.stringify({
    type: "rest",
    method: "GET",
    path: "/IntegrationServices/1.0/Customers",
    deadlineAtMs: Date.now() + 30_000,
  });
  const headers = auth(body, config.secret);
  const send = () => fetch(`${url}/relay`, { method: "POST", headers, body });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 409);
});

test("rejects reuse of either a nonce or request id", async () => {
  const { url, config } = await fixture((_req, res) => res.end("ok"));
  const body = JSON.stringify({
    type: "rest",
    method: "GET",
    path: "/IntegrationServices/1.0/Customers",
    deadlineAtMs: Date.now() + 30_000,
  });
  const first = auth(body, config.secret);
  assert.equal((await fetch(`${url}/relay`, { method: "POST", headers: first, body })).status, 200);
  const reusedNonce = auth(body, config.secret, { "x-relay-nonce": first["x-relay-nonce"] });
  assert.equal((await fetch(`${url}/relay`, { method: "POST", headers: reusedNonce, body })).status, 409);
  const reusedId = auth(body, config.secret, { "x-relay-request-id": first["x-relay-request-id"] });
  assert.equal((await fetch(`${url}/relay`, { method: "POST", headers: reusedId, body })).status, 409);
});

test("loads replay reservations after a relay restart", async () => {
  const body = JSON.stringify({
    type: "rest",
    method: "GET",
    path: "/IntegrationServices/1.0/Customers",
    deadlineAtMs: Date.now() + 30_000,
  });
  const secret = "test-secret-with-at-least-thirty-two-bytes";
  const firstUpstream = http.createServer((_req, res) => res.end("ok"));
  const upstreamUrl = await listen(firstUpstream);
  const directory = mkdtempSync(join(tmpdir(), "protractor-relay-restart-"));
  journalDirs.push(directory);
  const config = {
    secret, upstream: new URL(upstreamUrl), requestBodyLimit: 4096,
    responseBodyLimit: 4096, timeoutMs: 100, requestTimeoutMs: 1000,
    upstreamMinIntervalMs: 0, maxCallerDeadlineMs: 180_000,
    replayMaxEntries: 1000, replayTtlSeconds: 120, clockSkewSeconds: 60,
    replayJournalPath: join(directory, "replay.journal")
  };
  const relayOne = createRelayServer(config);
  const url = await listen(relayOne);
  const headers = auth(body, secret);
  assert.equal((await fetch(`${url}/relay`, { method: "POST", headers, body })).status, 200);
  await new Promise(resolve => relayOne.close(resolve));
  servers.splice(servers.indexOf(relayOne), 1);
  const relayTwo = createRelayServer(config);
  const urlTwo = await listen(relayTwo);
  assert.equal((await fetch(`${urlTwo}/relay`, { method: "POST", headers, body })).status, 409);
});

test("allows only normalized relative IntegrationServices 1.0 and 2.0 paths", async () => {
  const { url, config } = await fixture((_req, res) => res.end("ok"));
  for (const path of [
    "https://evil.example/IntegrationServices/1.0/x",
    "/Other/IntegrationServices/1.0/x",
    "/IntegrationServices/3.0/x",
    "/IntegrationServices/1.0/../private",
    "//evil.example/IntegrationServices/1.0/x",
    "/IntegrationServices/1.0/x%2Fy",
    "/IntegrationServices/1.0/%2e%2e/private",
    "/IntegrationServices/1.0/%252e%252e/private",
    "/IntegrationServices/1.0/.%2e/private",
    "/IntegrationServices/1.0/%2e./private",
    "/IntegrationServices/1.0/%252fprivate"
  ]) {
    const response = await relayFetch(url, config, { type: "rest", method: "GET", path });
    assert.equal(response.status, 400, path);
  }
  assert.equal((await relayFetch(url, config, {
    type: "rest", method: "GET", path: "/IntegrationServices/2.0/RepairOrders?id=7"
  })).status, 200);
});

test("compacts the durable replay journal and fails before exceeding its bound", async () => {
  const journalDir = mkdtempSync(join(tmpdir(), "protractor-relay-compact-"));
  journalDirs.push(journalDir);
  const upstream = http.createServer((_req, res) => res.end("ok"));
  const upstreamUrl = await listen(upstream);
  const config = {
    secret: "test-secret-with-at-least-thirty-two-bytes",
    upstream: new URL(upstreamUrl), requestBodyLimit: 4096, responseBodyLimit: 4096,
    timeoutMs: 1000, requestTimeoutMs: 1000, replayMaxEntries: 1000,
    upstreamMinIntervalMs: 0, maxCallerDeadlineMs: 180_000,
    replayJournalMaxBytes: 65_536, replayTtlSeconds: 120, clockSkewSeconds: 60,
    replayJournalPath: join(journalDir, "replay.journal")
  };
  const relay = createRelayServer(config);
  const url = await listen(relay);
  for (let i = 0; i < 140; i++) {
    const body = JSON.stringify({
      type: "rest",
      method: "GET",
      path: "/IntegrationServices/1.0/x",
      deadlineAtMs: Date.now() + 30_000,
    });
    const response = await fetch(`${url}/relay`, {
      method: "POST", headers: auth(body, config.secret), body
    });
    assert.equal(response.status, 200);
  }
  assert.ok(statSync(config.replayJournalPath).size <= config.replayJournalMaxBytes);
});

test("enforces outer and typed upstream methods", async () => {
  const { url, config } = await fixture((_req, res) => res.end("ok"));
  assert.equal((await fetch(`${url}/relay`)).status, 405);
  assert.equal((await relayFetch(url, config, {
    type: "soap", method: "GET", path: "/IntegrationServices/1.0/Service"
  })).status, 400);
  assert.equal((await relayFetch(url, config, {
    type: "rest", method: "OPTIONS", path: "/IntegrationServices/1.0/x"
  })).status, 400);
});

test("preserves application and Protractor auth headers but strips hop-by-hop headers", async () => {
  let received;
  const { url, config } = await fixture((req, res) => {
    received = req.headers;
    res.setHeader("connection", "close");
    res.setHeader("x-upstream", "yes");
    res.end("ok");
  });
  const rejected = await relayFetch(url, config, {
    type: "rest",
    method: "GET",
    path: "/IntegrationServices/1.0/x",
    headers: {
      Authorization: "Basic protractor-credential",
      "X-Protractor-PartnerKey": "partner",
      Accept: "application/json",
      Connection: "x-remove",
      "X-Remove": "secret",
      Host: "evil.example",
      "Transfer-Encoding": "chunked"
    }
  });
  assert.equal(rejected.status, 400);
  const response = await relayFetch(url, config, {
    type: "rest",
    method: "GET",
    path: "/IntegrationServices/1.0/x",
    headers: {
      Authorization: "Basic protractor-credential",
      "X-Protractor-PartnerKey": "partner",
      Accept: "application/json",
      Host: "evil.example",
      "Keep-Alive": "secret"
    }
  });
  assert.equal(response.status, 200);
  assert.equal(received.authorization, "Basic protractor-credential");
  assert.equal(received["x-protractor-partnerkey"], "partner");
  assert.equal(received.accept, "application/json");
  assert.notEqual(received.host, "evil.example");
  assert.equal(response.headers.get("x-upstream"), "yes");
});

test("preserves REST and SOAP request bodies byte-for-byte", async () => {
  const captured = [];
  const { url, config } = await fixture((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      captured.push({ method: req.method, type: req.headers["content-type"], body: Buffer.concat(chunks) });
      res.end("accepted");
    });
  });
  const jsonBody = Buffer.from('{"unicode":"café"}');
  assert.equal((await relayFetch(url, config, {
    type: "rest", method: "PATCH", path: "/IntegrationServices/2.0/x",
    headers: { "content-type": "application/json" },
    body: jsonBody.toString("base64"), bodyEncoding: "base64"
  })).status, 200);
  const soap = "<soap:Envelope><token>abc</token></soap:Envelope>";
  assert.equal((await relayFetch(url, config, {
    type: "soap", method: "POST", path: "/IntegrationServices/1.0/Service",
    headers: { "content-type": "text/xml; charset=utf-8", SOAPAction: "GetRepairOrders" },
    body: soap
  })).status, 200);
  assert.deepEqual(captured[0].body, jsonBody);
  assert.equal(captured[1].body.toString(), soap);
  assert.equal(captured[1].type, "text/xml; charset=utf-8");
});

test("enforces inbound, decoded outbound, and upstream response limits", async () => {
  const { url, config } = await fixture((_req, res) => res.end("x".repeat(200)), {
    requestBodyLimit: 180,
    responseBodyLimit: 100
  });
  const oversized = JSON.stringify({
    type: "rest", method: "POST", path: "/IntegrationServices/1.0/x", body: "x".repeat(200)
  });
  await assert.rejects(() => fetch(`${url}/relay`, {
    method: "POST", headers: auth(oversized, config.secret), body: oversized
  }));

  const compact = { type: "rest", method: "GET", path: "/IntegrationServices/1.0/x" };
  const response = await relayFetch(url, config, compact);
  assert.equal(response.status, 502);
});

test("returns a deadline error when upstream stalls", async () => {
  const { url, config } = await fixture(() => {}, { timeoutMs: 30 });
  const response = await relayFetch(url, config, {
    type: "rest", method: "GET", path: "/IntegrationServices/1.0/x"
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error, "upstream_timeout");
});

test("enforces the signed caller deadline during an active upstream response", async () => {
  let calls = 0;
  const { url, config } = await fixture((_req, res) => {
    calls++;
    setTimeout(() => res.end("late"), 80);
  });
  const response = await relayFetch(url, config, {
    type: "rest",
    method: "GET",
    path: "/IntegrationServices/1.0/x",
    deadlineAtMs: Date.now() + 30,
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error, "caller_deadline_expired");
  assert.equal(calls, 1);
});

test("serializes actual upstream dispatches and cools down after completion", async () => {
  const starts = [];
  let active = 0;
  let overlap = false;
  const { url, config } = await fixture((_req, res) => {
    starts.push(Date.now());
    active++;
    if (active > 1) overlap = true;
    setTimeout(() => {
      active--;
      res.end("ok");
    }, 5);
  }, {
    upstreamMinIntervalMs: 20,
    maxConcurrentUpstreams: 8,
  });
  const values = Array.from({ length: 5 }, (_, index) => ({
    type: index % 2 ? "soap" : "rest",
    method: index % 2 ? "POST" : "GET",
    path: index % 2
      ? "/IntegrationServices/1.0/WorkOrderServices.asmx"
      : `/IntegrationServices/2.0/Invoice/${index}`,
    deadlineAtMs: Date.now() + 5_000,
  }));
  const responses = await Promise.all(values.map(value => relayFetch(url, config, value)));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(overlap, false);
  assert.equal(starts.length, values.length);
  const gaps = starts.slice(1).map((value, index) => value - starts[index]);
  assert.ok(gaps.every(gap => gap >= 20), `physical gaps: ${gaps.join(",")}`);
});

test("drops queued work whose signed caller deadline expires before dispatch", async () => {
  let calls = 0;
  const { url, config } = await fixture((_req, res) => {
    calls++;
    setTimeout(() => res.end("ok"), 40);
  }, {
    upstreamMinIntervalMs: 20,
    maxConcurrentUpstreams: 8,
  });
  const first = relayFetch(url, config, {
    type: "rest",
    method: "GET",
    path: "/IntegrationServices/2.0/Invoice/first",
    deadlineAtMs: Date.now() + 1_000,
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = relayFetch(url, config, {
    type: "soap",
    method: "POST",
    path: "/IntegrationServices/1.0/WorkOrderServices.asmx",
    deadlineAtMs: Date.now() + 15,
  });
  assert.equal((await first).status, 200);
  const expired = await second;
  assert.equal(expired.status, 504);
  assert.equal((await expired.json()).error, "caller_deadline_expired");
  assert.equal(calls, 1, "expired queued work must never create an upstream socket");
});

test("drops queued work when its caller disconnects before dispatch", async () => {
  let calls = 0;
  const { url, config } = await fixture((_req, res) => {
    calls++;
    setTimeout(() => res.end("ok"), 40);
  }, {
    upstreamMinIntervalMs: 20,
    maxConcurrentUpstreams: 8,
  });
  const first = relayFetch(url, config, {
    type: "rest",
    method: "GET",
    path: "/IntegrationServices/2.0/Invoice/first",
    deadlineAtMs: Date.now() + 1_000,
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const controller = new AbortController();
  const value = {
    type: "rest",
    method: "GET",
    path: "/IntegrationServices/2.0/Invoice/disconnected",
    deadlineAtMs: Date.now() + 1_000,
  };
  const body = JSON.stringify(value);
  const disconnected = fetch(`${url}/relay`, {
    method: "POST",
    headers: auth(body, config.secret),
    body,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(disconnected, /abort/i);
  assert.equal((await first).status, 200);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1, "disconnected queued work must never create an upstream socket");
});

test("requires bounded signed caller deadlines", async () => {
  const { url, config } = await fixture((_req, res) => res.end("ok"));
  const missing = await relayFetch(url, config, JSON.stringify({
    type: "rest",
    method: "GET",
    path: "/IntegrationServices/2.0/Invoice/missing",
  }));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "invalid_deadline");
  const tooFar = await relayFetch(url, config, {
    type: "rest",
    method: "GET",
    path: "/IntegrationServices/2.0/Invoice/future",
    deadlineAtMs: Date.now() + config.maxCallerDeadlineMs + 10_000,
  });
  assert.equal(tooFar.status, 400);
  assert.equal((await tooFar.json()).error, "invalid_deadline");
});

test("admits only the configured number of ingress requests", async () => {
  const { url, config } = await fixture(() => {}, {
    timeoutMs: 80,
    maxConcurrentIngress: 1,
    maxConcurrentUpstreams: 1
  });
  const value = { type: "rest", method: "GET", path: "/IntegrationServices/1.0/x" };
  const first = relayFetch(url, config, value);
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = await relayFetch(url, config, value);
  assert.equal(second.status, 503);
  assert.equal((await first).status, 504);
});

test("does not follow upstream redirects", async () => {
  let calls = 0;
  const { url, config } = await fixture((_req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(302, { location: "/IntegrationServices/1.0/second" });
      res.end();
    } else res.end("followed");
  });
  const response = await relayFetch(url, config, {
    type: "rest", method: "GET", path: "/IntegrationServices/1.0/first"
  });
  assert.equal(response.status, 302);
  assert.equal(calls, 1);
});

test("structured logs do not contain credentials or request bodies", async () => {
  const writes = [];
  const { url, config } = await fixture((_req, res) => res.end("ok"), {
    logger: (level, event, fields) => writes.push(JSON.stringify({ level, event, ...fields }))
  });
  const response = await relayFetch(url, config, {
    type: "soap", method: "POST", path: "/IntegrationServices/1.0/private?token=querysecret",
    headers: { Authorization: "Bearer headersecret" }, body: "<password>bodysecret</password>"
  });
  assert.equal(response.status, 200);
  const bareResponse = await relayFetch(url, config, {
    type: "rest", method: "GET", path: "/IntegrationServices/1.0?token=barequerysecret"
  });
  assert.equal(bareResponse.status, 200);
  const output = writes.join("");
  assert.doesNotMatch(output, /headersecret|bodysecret|querysecret|barequerysecret|Authorization/i);
  assert.ok(writes.every(line => JSON.parse(line).apiVersion === "1.0"));
  for (const line of writes) assert.doesNotThrow(() => JSON.parse(line));
});

test("compose grants SOAP requests enough shutdown grace", () => {
  const compose = readFileSync(new URL("../compose.example.yml", import.meta.url), "utf8");
  const configSource = readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
  assert.match(compose, /protractor-relay:[\s\S]*?container_name:\s*protractor-relay/);
  assert.match(compose, /protractor-relay:[\s\S]*?stop_grace_period:\s*140s/);
  assert.match(compose, /caddy:[\s\S]*?stop_grace_period:\s*145s/);
  assert.match(configSource, /UPSTREAM_MIN_INTERVAL_MS", 1000, 1000,/);
});