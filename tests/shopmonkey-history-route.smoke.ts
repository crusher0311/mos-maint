import assert from "node:assert/strict";
import Module from "node:module";
import { NextRequest } from "next/server";

const loader = Module as unknown as { _load: (id: string, ...args: any[]) => any };
const original = loader._load;
const vin = "1HGCM82633A004352";
const history = {
  _id: "sm-history", shopId: 195, sourceSystem: "shopmonkey",
  workOrderId: "fixture-ro", workOrderNumber: 12,
  title: "Replace engine oil and filter", closedDate: "2026-10-01", mileage: 50000,
  vehicle: { vin, year: 2003, make: "Honda", model: "Accord" },
  hours: 1, laborTotal: 100, partsTotal: 50, total: 150,
  lines: [],
};
let lookupCount = 0;
let historyReads = 0;
const db = { collection(name: string) {
  if (name === "normalized_work_orders") return { find(query: any) {
    lookupCount++;
    assert.deepEqual(query.shopId.$in, [195, "195"]);
    assert.equal(query["provenance.sourceIds.system"], "shopmonkey");
    return { limit() { return { async toArray() { return [{ vehicle: history.vehicle }]; } }; } };
  } };
  if (name === "shops") return {
    async findOne() { return { shopId: 195, integrationProvider: "shopmonkey" }; },
    find() { return { async toArray() { return [{ shopId: 195, name: "Fixture shop" }]; } }; },
  };
  throw new Error(`Unexpected collection ${name}`);
} };
const stubs: Record<string, any> = {
  "@/lib/mongo": { getDb: async () => db },
  "@/lib/extension-route-wrapper": { withExtensionErrorMarker: (fn: any) => fn },
  "@/lib/extension-auth": {
    validateExtensionToken: async () => ({ authorized: true, user: { shopId: "195", role: "advisor" } }),
    getUserShopIds: () => ["195"],
    requireExtensionPrincipalScope: () => null,
  },
  "@/lib/extension-route-guard": { checkShopFeatureGate: async () => null },
  "@/lib/extension-shop-lookup": { findShopBySmsId: async () => ({ mosShopId: 195, provider: "shopmonkey" }) },
  "@/lib/enterprise": { getEnterpriseByShopId: async () => null },
  "@/lib/job-search-combined": { searchJobsCombined: async (_db: any, ids: number[], _tokens: any, opts: any) => {
    assert.deepEqual(ids, [195]);
    assert.equal(opts.make, "Honda");
    return { jobs: [history], supabaseCount: 0, mongoCount: 1, source: "mongo" };
  } },
  "@/lib/integrations/dataone-local": {},
  "@/lib/job-search-specs": { resolveJobSearchSpecs: async () => ({ targetSpecs: null, jobSpecsMap: new Map() }) },
  "@/lib/data/repositories/tekmetric-work-orders": {
    findTekmetricWorkOrderByWorkOrderId: () => { throw new Error("Shopmonkey must not read Tekmetric ROs"); },
  },
  "@/lib/data/repositories/job-index": { listRecentJobIndexForVehicle: async (shopId: number, conditions: any[]) => {
    historyReads++;
    assert.equal(shopId, 195);
    assert.equal(conditions[0]["vehicle.vin"], vin);
    return [history];
  } },
  "@/lib/job-index": { isDeclinedJobIndexRow: () => false },
  "@/lib/integrations/carfax": {
    getCachedCarfaxServiceRecords: async () => [],
    estimateMileageFromCarfax: async () => ({ estimated: false }),
  },
};
loader._load = function(id, ...args) {
  if (id in stubs) return stubs[id];
  return original.call(this, id, ...args);
};
async function main() {
  try {
    const { GET } = require("../app/api/extension/jobs/search/route");
    const response = await GET(new NextRequest("http://fixture/api/extension/jobs/search?q=oil&shopId=fixture&provider=shopmonkey&roId=fixture-ro"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(lookupCount, 1);
    assert.equal(body.jobs[0].source, "shopmonkey");
    assert.equal(body.jobs[0].totals.totalAmount, 150);
    assert.equal(body.jobs[0].totals.laborHours, 1);
    const { getLastPerformedBatch } = require("../lib/last-performed");
    const matches = await getLastPerformedBatch({ shopId: 195, vin, names: [history.title], currentMiles: 52000 });
    assert.equal(historyReads, 1);
    assert.equal(matches[0].source, "shop");
    assert.equal(matches[0].miles, 50000);
    console.log("Shopmonkey extension route and last-performed loader checks passed");
  } finally { loader._load = original; }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
