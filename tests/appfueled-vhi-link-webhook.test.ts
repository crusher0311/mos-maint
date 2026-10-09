import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { parseVhiLink, receiveVhiLink } from "../lib/external-api/vhi-link-webhook";
const payload = { shopId: 42, vin: "1HGCM82633A004352", deliveryId: "report-1", vhiUrl: "https://reports.example.test/r/1" };
const context: any = { isPartner: true, partnerId: "appfueled", requestId: "fixture" };
const request = (body: any) => new NextRequest("https://fixture.test/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("validates shop, VIN and URL without fetching", () => {
  assert.ok(parseVhiLink(payload));
  for (const vhiUrl of ["javascript:alert(1)", "http://example.com", "https://a:b@example.com", "https://127.0.0.1", "https://localhost", "https://x.internal"]) assert.equal(parseVhiLink({ ...payload, vhiUrl }), null);
  for (const shopId of [0, -1, "42bad", 1.1]) assert.equal(parseVhiLink({ ...payload, shopId }), null);
  assert.equal(parseVhiLink({ ...payload, vin: "bad" }), null);
});

test("incoming delivery is authorized, scoped, persisted and retry-safe", async () => {
  const docs = new Map<string, any>();
  const deps: any = {
    shopExists: async (id: number) => id === 42 || id === 43,
    canUseVhi: async () => true,
    getDb: async () => ({ collection: () => ({
      insertOne: async (doc: any) => { if (docs.has(doc._id)) throw Object.assign(new Error("duplicate"), { code: 11000 }); docs.set(doc._id, doc); },
      findOne: async ({ _id }: any) => docs.get(_id),
    }) }),
  };
  assert.equal((await receiveVhiLink(request(payload), { ...context, partnerId: "other" }, deps)).status, 403);
  assert.equal((await receiveVhiLink(request(payload), { ...context, isPartner: false }, deps)).status, 403);
  assert.equal((await receiveVhiLink(request({ ...payload, shopId: 99 }), context, deps)).status, 404);
  assert.equal((await receiveVhiLink(request(payload), context, { ...deps, canUseVhi: async () => false })).status, 403);
  assert.equal(docs.size, 0);
  assert.equal((await receiveVhiLink(request({ ...payload, padding: "a".repeat(9000) }), context, deps)).status, 413);
  assert.equal((await receiveVhiLink(request(payload), context, deps)).status, 200);
  assert.equal(docs.size, 1);
  assert.equal((await (await receiveVhiLink(request(payload), context, deps)).json()).duplicate, true);
  assert.equal((await receiveVhiLink(request({ ...payload, vhiUrl: "https://reports.example.test/other" }), context, deps)).status, 409);
  assert.equal((await receiveVhiLink(request({ ...payload, shopId: 43 }), context, deps)).status, 200);
  assert.equal(docs.size, 2);
  await assert.rejects(receiveVhiLink(request(payload), context, { ...deps, getDb: async () => { throw new Error("DB failure"); } }), /DB failure/);
});
