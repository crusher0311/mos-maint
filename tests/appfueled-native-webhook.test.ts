import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAppFueledLinkEndpoint } from "../lib/external-api/appfueled-native-webhook";
import { connectionDigest, encryptCredentials, parseCredentials } from "../lib/external-api/appfueled-credentials";
import { createExternalEndpoint, __deps } from "../lib/external-api/middleware";
import { receiveVhiLink } from "../lib/external-api/vhi-link-webhook";

const sample = { data: { event_name: "vhi_url", connection_id: "conn_HSw0db9BqKmG", mos_shop_id: 29, vin: "1FTYR14U15PA88986", vhi_url: "https://shop.example.com/v/xyz789" } };
const request = (body: unknown, headers = {}) => new NextRequest("https://fixture.test/api/external/v1/vhi/links", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
function fixture(overrides = {}) {
  const docs = new Map<string, any>();
  let legacyCalls = 0;
  const deps: any = {
    resolveConnection: async (id: string) => id === sample.data.connection_id ? { shopId: 29, connectionHash: connectionDigest(id) } : null,
    admit: async () => true, shopExists: async () => true, canUseVhi: async () => true,
    getDb: async () => ({ collection: () => ({
      insertOne: async (doc: any, options: any) => {
        assert.equal(options.writeConcern.w, "majority");
        if (docs.has(doc._id)) throw { code: 11000 };
        docs.set(doc._id, doc);
      },
      findOne: async ({ _id }: any) => docs.get(_id),
    }) }), ...overrides,
  };
  return { docs, deps, legacyCalls: () => legacyCalls, handle: createAppFueledLinkEndpoint(async () => {
    legacyCalls++; return NextResponse.json({ legacy: true });
  }, deps) };
}

test("exact native contract, concurrent duplicates and changed links are durably scoped", async () => {
  const f = fixture();
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.handle(request(sample))));
  assert.ok(responses.every(r => r.status === 200));
  const bodies = await Promise.all(responses.map(r => r.json()));
  assert.equal(bodies.filter(b => !b.duplicate).length, 1);
  assert.equal(f.docs.size, 1);
  const doc = [...f.docs.values()][0];
  assert.equal(doc.source, "appfueled_native");
  assert.ok(doc.receivedAt instanceof Date);
  assert.ok(!JSON.stringify(doc).includes(sample.data.connection_id));
  assert.equal((await f.handle(request({ data: { ...sample.data, vhi_url: "https://shop.example.com/v/new" } }))).status, 200);
  assert.equal(f.docs.size, 2);
  assert.equal(f.legacyCalls(), 0);
});

test("unknown/disabled connections, mismatch, missing shop, entitlement and persistence denial", async () => {
  for (const [overrides, status] of [
    [{ resolveConnection: async () => null }, 401],
    [{ resolveConnection: async () => ({ shopId: 30, connectionHash: "hash" }) }, 403],
    [{ shopExists: async () => false }, 404],
    [{ canUseVhi: async () => false }, 403],
    [{ getDb: async () => { throw new Error("private URL and credential"); } }, 503],
    [{ admit: async () => false }, 429],
  ] as const) {
    const f = fixture(overrides);
    const res = await f.handle(request(sample));
    assert.equal(res.status, status);
    assert.equal(f.docs.size, 0);
    assert.equal(f.legacyCalls(), 0);
    assert.ok(!(await res.text()).includes("private"));
    assert.ok(res.headers.get("x-request-id"));
  }
});

test("strict envelope, malformed, oversized and unsafe input cannot fall back", async () => {
  const f = fixture();
  for (const body of [
    { data: null }, { data: [] }, { ...sample, shopId: 29 }, sample.data,
    { data: { ...sample.data, event_name: "other" } },
    { data: { ...sample.data, mos_shop_id: "29" } },
    { data: { ...sample.data, vin: "bad" } },
    { data: { ...sample.data, connection_id: "" } },
    ...["http://example.com", "https://127.0.0.1", "https://[::1]", "https://a:b@example.com", "https://a.internal", "javascript:alert(1)"]
      .map(vhi_url => ({ data: { ...sample.data, vhi_url } })),
  ]) assert.equal((await f.handle(request(body, { "X-API-Key": "even-a-valid-key" }))).status, 400);
  assert.equal((await f.handle(request({ data: "a".repeat(9000) }))).status, 413);
  assert.equal((await f.handle(new NextRequest("https://fixture.test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }))).status, 400);
  assert.equal((await f.handle(request(sample, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal(f.legacyCalls(), 0);
  assert.equal(f.docs.size, 0);
});

test("credential encryption is randomized, authenticated, shop-bound and contains no plaintext", () => {
  const input = parseCredentials({ shopId: 29, apiKey: "fixture-api-key", apiSecret: "fixture-secret", connectionId: "fixture-connection" });
  const key = "a1".repeat(32);
  const encrypted = encryptCredentials(input, key);
  assert.notEqual(encrypted, encryptCredentials(input, key));
  assert.ok(!encrypted.includes(input.apiSecret));
  const [, iv, tag, data] = encrypted.split(".");
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(iv, "base64"));
  cipher.setAAD(Buffer.from("appfueled:v1:29")); cipher.setAuthTag(Buffer.from(tag, "base64"));
  assert.deepEqual(JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, "base64")), cipher.final()]).toString()), { apiKey: input.apiKey, apiSecret: input.apiSecret });
  assert.throws(() => encryptCredentials(input, undefined));
  for (const body of [{ ...input, shopId: -1 }, { ...input, apiSecret: "" }, { ...input, connectionId: "has space" }]) assert.throws(() => parseCredentials(body));
});

test("legacy flat clients still require AppFueled partner permission; native never invokes key auth", async () => {
  const saved = { ...__deps };
  try {
    const key: any = { shopId: 0, isPartner: true, partnerId: "appfueled", keyHash: "fixture", rateLimit: 100, permissions: ["vhi:write"] };
    Object.assign(__deps, {
      validateApiKey: async (raw: string) => ({ valid: raw === "fixture", apiKey: key }),
      checkPermission: async (k: any, permission: string) => k.permissions.includes(permission),
      checkRateLimit: async () => ({ allowed: true, remaining: 99, resetAt: new Date() }),
      updateApiKeyUsage: async () => {}, logApiUsage: async () => {},
    });
    const f = fixture();
    const handle = createAppFueledLinkEndpoint(createExternalEndpoint("vhi:write", (req, context) => receiveVhiLink(req, context, f.deps)), f.deps);
    const flat = { shopId: 29, vin: sample.data.vin, vhiUrl: sample.data.vhi_url, deliveryId: "legacy" };
    assert.equal((await handle(request(flat))).status, 401);
    assert.equal((await handle(request(flat, { "X-API-Key": "bad" }))).status, 401);
    assert.equal((await handle(request(flat, { "X-API-Key": "fixture" }))).status, 200);
    key.permissions = ["carfax:write"];
    assert.equal((await handle(request(flat, { "X-API-Key": "fixture" }))).status, 403);
    assert.equal((await handle(request(sample))).status, 200);
    assert.equal((await handle(request({ data: { ...sample.data, connection_id: "unknown" } }, { "X-API-Key": "fixture" }))).status, 401);
  } finally { Object.assign(__deps, saved); }
});
