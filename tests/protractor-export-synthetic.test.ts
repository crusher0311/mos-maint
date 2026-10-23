import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { COVERAGE } from "../lib/protractor-exports/contract";
import { signature, destinationUrl } from "../lib/protractor-exports/transport";

// This file doubles as the operator-facing synthetic sender. It accepts no URL,
// shop, body, secret or database arguments. All traffic is explicit loopback.
test("synthetic signed delivery, durable restart and controlled failures", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mos-export-synthetic-"));
  const secret = randomBytes(32).toString("hex");
  let child: ReturnType<typeof fork> | undefined;
  let port = 0;
  async function start() {
    child = fork("scripts/protractor-export-synthetic/receiver.mjs", [], {
      execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: { NODE_ENV: "test", PATH: process.env.PATH, NODE_OPTIONS: "--require ./tests/helpers/deny-network-egress.cjs" },
    });
    const ready = once(child, "message");
    child.send({ directory, secret });
    let timer: NodeJS.Timeout | undefined;
    try {
      const [message] = await Promise.race([ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("synthetic_receiver_start_timeout")), 3000);
      })]);
      port = message.port;
    } finally { if (timer) clearTimeout(timer); }
  }
  async function stop() {
    if (!child) return;
    const ended = once(child, "exit");
    child.kill("SIGKILL");
    await ended; child = undefined;
  }
  const id = randomUUID();
  const body = JSON.stringify({
    schemaVersion: "mos.protractor.snapshots.v1", deliveryId: id,
    enterpriseId: "synthetic-enterprise", shopId: 999999, provider: "protractor",
    window: { date: "2026-10-22", timeZone: "UTC", startedAt: "2026-10-22T00:00:00Z", previousCompletedDate: null },
    kind: "snapshots",
    coverage: { ...COVERAGE, scanned: 1, missing: 0, oversized: 0, mode: "collected",
      incomplete: false, initialSnapshot: true, baselineOnly: false,
      cutoffSemantics: "latest available at collection time; not a historical point-in-time snapshot",
      omittedProviderFields: "DVI and inspection subdocuments" },
    records: [{ shopId: 999999, entityType: "invoice", providerId: "fictional-invoice",
      observedAt: "2026-10-22T00:00:00Z", source: "mongo.protractor_invoices",
      payload: { ID: "fictional-invoice", InvoiceNumber: "SYNTHETIC-ONLY", Total: 12.34 } }],
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  async function send(path = "/accept", options: { timestamp?: string; body?: string; id?: string; secret?: string; signedBody?: string } = {}) {
    const sentId = options.id ?? id, sentBody = options.body ?? body, ts = options.timestamp ?? timestamp;
    return new Promise<{ status: number; acknowledged: boolean }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, method: "POST", agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(sentBody),
          "x-mos-delivery-id": sentId, "x-mos-timestamp": ts,
          "x-mos-signature": `v1=${signature(options.secret ?? secret, ts, sentId, options.signedBody ?? sentBody)}` },
      }, res => {
        res.resume();
        resolve({ status: res.statusCode!, acknowledged: res.statusCode! >= 200 &&
          res.statusCode! < 300 && res.headers["x-mos-acknowledgment"] === sentId });
      });
      req.setTimeout(3000, () => req.destroy(new Error("timeout")));
      req.on("error", reject); req.end(sentBody);
    });
  }
  try {
    await start();
    assert.equal((await send("/accept", { secret: "wrong" })).status, 401);
    assert.equal((await send("/accept", { timestamp: String(+timestamp - 301) })).status, 401);
    assert.equal((await send("/accept", { timestamp: String(+timestamp + 601) })).status, 401);
    assert.equal((await send("/accept", { body: body + " ", signedBody: body })).status, 401);
    assert.equal((await send("/accept", { id: randomUUID() })).status, 400);
    assert.equal((await readdir(directory)).length, 0);
    assert.deepEqual(await send(), { status: 202, acknowledged: true });
    assert.deepEqual(await send(), { status: 200, acknowledged: true });
    assert.equal((await send("/accept", { body: body.replace("12.34", "99.99") })).status, 409);
    assert.equal((await send("/missing")).acknowledged, false);
    assert.equal((await send("/mismatch")).acknowledged, false);
    // New batch: commit, lose acknowledgment, kill process, retry unchanged bytes/ID.
    const lostId = randomUUID(), lostBody = body.replace(id, lostId);
    await assert.rejects(send("/lost", { id: lostId, body: lostBody }));
    await stop(); await start();
    const fresh = String(+timestamp + 1);
    assert.notEqual(signature(secret, timestamp, lostId, lostBody), signature(secret, fresh, lostId, lostBody));
    assert.deepEqual(await send("/accept", { id: lostId, body: lostBody, timestamp: fresh }), { status: 200, acknowledged: true });
    assert.deepEqual(await send(), { status: 200, acknowledged: true });
    assert.equal((await readdir(directory)).filter(f => f.endsWith(".json")).length, 2);
    assert.equal(JSON.parse(await readFile(join(directory, `${lostId}.json`), "utf8")).body, lostBody);
    assert.throws(() => destinationUrl(`http://127.0.0.1:${port}`)); // No production bypass.
    // Fail storage, not authentication: no acknowledgment may escape a failed commit.
    await rm(directory, { recursive: true, force: true });
    const storageId = randomUUID();
    assert.deepEqual(await send("/accept", { id: storageId, body: body.replace(id, storageId) }),
      { status: 503, acknowledged: false });
    console.log("PASS: signed acceptance; exact bytes; freshness; identity; duplicate; missing/mismatched ACK; durable restart; lost ACK retry.");
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
});
