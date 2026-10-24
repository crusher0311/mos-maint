import assert from "node:assert/strict";
import { carfaxSettingsRequest, loadCarfaxSettings } from "../lib/carfax-settings-client";

const Module = require("module");
const original = Module._load;
let session: any = { shopId: 123, isPlatformAdmin: true, isImpersonation: true };
let enabled = false, passwordRequired = false, dbFailure = false, cacheFailure = false;
let reads = 0, writes = 0, invalidations = 0;
const shops = new Map<number, any>([[123, { shopId: 123 }], [456, { shopId: 456, carfaxLocationId: "OTHER" }]]);
const db = { collection(name: string) {
  assert.equal(name, "shops");
  return {
    async findOne(q: any) { reads++; if (dbFailure) throw Error("private database details"); return shops.get(q.shopId); },
    async updateOne(q: any, u: any) {
      writes++; const shop = shops.get(q.shopId) || { shopId: q.shopId };
      Object.assign(shop, u.$set);
      for (const key of Object.keys(u.$unset || {})) delete shop[key];
      shops.set(q.shopId, shop);
    },
  };
}};
class PasswordError extends Error {}
Module._load = function(name: string, ...args: any[]) {
  if (name === "server-only") return {};
  if (name === "@/lib/auth") return {
    getSession: async () => { if (passwordRequired) throw new PasswordError(); return session; },
    isPasswordChangeRequiredError: (e: unknown) => e instanceof PasswordError,
  };
  if (name === "@/lib/mongo") return { getDb: async () => db };
  if (name === "@/lib/featureResolver") return { getFeatureEntitlements: async (id: number) => {
    assert.equal(id, session.shopId); return { canUseFeature: () => enabled };
  }};
  if (name === "@/lib/plan-cache") return { invalidateShopPlanCache: async (_db: any, id: number) => {
    assert.equal(id, 123); invalidations++;
    if (cacheFailure) throw Error("private cache details");
    return { cachedPlans: 1, analysisCache: 1 };
  }};
  if (name === "@/lib/api-usage-tracker") return { trackApiRequest: () => { throw Error("Paid call forbidden"); } };
  return original.call(this, name, ...args);
};
const route = require("../app/api/settings/carfax/route");
Module._load = original;
const post = (body: any) => route.POST(new Request("http://fixture.invalid/api/settings/carfax", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
}));

async function main() {
  // Demonstrate the exact old failure: plain text denial throws during JSON parsing.
  await assert.rejects(new Response("Feature not enabled", { status: 403 }).json());
  for (const ghost of [false, true]) {
    session = { shopId: 123, isPlatformAdmin: ghost, isImpersonation: ghost };
    for (enabled of [false, true]) {
      const res = await post({ locationId: ` LOC-${ghost}-${enabled} `, shopId: 456 });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).maintenanceEnabled, enabled);
      const loaded = await (await route.GET()).json();
      assert.equal(loaded.locationId, `LOC-${ghost}-${enabled}`);
      assert.equal(loaded.maintenanceEnabled, enabled);
    }
  }
  assert.equal(shops.get(456).carfaxLocationId, "OTHER");
  const before = invalidations;
  await post({ locationId: shops.get(123).carfaxLocationId });
  assert.equal(invalidations, before, "same ID retains cache");
  await route.DELETE(); assert.equal(invalidations, before + 1);
  assert.equal((await (await route.GET()).json()).locationId, "");
  for (const body of ["{", {}, { locationId: {} }, { locationId: "" }, { locationId: "x".repeat(257) }]) {
    assert.equal((await post(body)).status, 400);
  }
  const untouched = [reads, writes];
  session = null;
  for (const call of [() => route.GET(), () => post({ locationId: "x" }), () => route.DELETE()]) {
    const r = await call(); assert.equal(r.status, 401); assert.equal((await r.json()).code, "SESSION_REQUIRED");
  }
  session = { shopId: 0 }; assert.equal((await route.GET()).status, 403);
  session = { shopId: 123 }; passwordRequired = true;
  assert.equal((await route.GET()).status, 403); passwordRequired = false;
  assert.deepEqual([reads, writes], untouched);
  dbFailure = true;
  let r = await route.GET(); assert.equal(r.status, 500); assert.doesNotMatch(await r.text(), /private/);
  dbFailure = false; cacheFailure = true;
  r = await post({ locationId: "CACHE-FAIL" }); assert.equal(r.status, 500); assert.doesNotMatch(await r.text(), /private/);
  cacheFailure = false;
  assert.equal((await (await route.GET()).json()).locationId, "CACHE-FAIL", "failure may occur after persistence");

  const realFetch = globalThis.fetch;
  for (const [status, body, expected] of [
    [403, "Feature not enabled", "permission"],
    [401, "<html>private login</html>", "Sign in"],
    [502, "<html>private gateway</html>", "could not be confirmed"],
    [400, JSON.stringify({ code: "INVALID_LOCATION_ID", error: "private" }), "Enter a CARFAX"],
    [500, JSON.stringify({ error: "private database" }), "could not be confirmed"],
    [200, "<html>private login</html>", "unexpected response"],
  ] as const) {
    globalThis.fetch = async () => new Response(body, { status });
    for (const method of ["GET", "POST", "DELETE"]) {
      await assert.rejects(carfaxSettingsRequest(method, "KEEP"), (e: any) => {
        assert.match(e.message, new RegExp(expected)); assert.doesNotMatch(e.message, /private|<html>/); return true;
      });
    }
    assert.notEqual((await loadCarfaxSettings()).state, "ready");
  }
  globalThis.fetch = async () => { throw Error("private network"); };
  assert.match((await loadCarfaxSettings()).error!, /connection/);
  globalThis.fetch = realFetch;
  console.log("CARFAX route/client tests passed (isolated stores, no external requests).");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
