/**
 * Smoke test for the empty-snapshot short TTL in `lib/integrations/carfax.ts`
 * (Task #959: JTHBW1GG8E2070579's CARFAX report cached ok:true with zero
 * usable serviceRecords and sat "fresh" for the full 7-day window, removing
 * the CARFAX tier of the mileage waterfall).
 *
 * Run: `npx tsx tests/carfax-empty-snapshot-ttl.smoke.ts`
 *
 * Guards:
 * 1. An ok:true fetch with EMPTY serviceRecords and no prior good content is
 *    persisted with `lastEmptyFetchAt` stamped (observability).
 * 2. `fetchCarfaxWithCache` treats such an empty-ok snapshot as fresh only
 *    within the short CARFAX_EMPTY_TTL_MS window, not the full 7-day TTL —
 *    once the short window passes, a live re-fetch fires and a now-healthy
 *    upstream repopulates the snapshot with real records.
 * 3. A NON-empty ok snapshot keeps the full 7-day freshness (no refetch churn).
 * 4. `fetchCarfaxStaleWhileRevalidate` also kicks a background refresh for an
 *    empty-ok snapshot older than the short TTL.
 */

import type {
  fetchCarfaxWithCache as FetchCarfaxWithCache,
  fetchCarfaxStaleWhileRevalidate as FetchCarfaxSWR,
} from "../lib/integrations/carfax";

// Stub `server-only` before importing carfax (which imports it).
const serverOnlyPath = require.resolve("server-only");
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {},
} as any;

let fetchCarfaxWithCache: typeof FetchCarfaxWithCache;
let fetchCarfaxStaleWhileRevalidate: typeof FetchCarfaxSWR;

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

// ----------------- in-memory Mongo fake -----------------
type Doc = Record<string, any>;

function matchesQuery(doc: Doc, query: any): boolean {
  for (const [k, v] of Object.entries(query)) {
    if (doc[k] !== v) return false;
  }
  return true;
}

function makeFakeCollection() {
  const docs: Doc[] = [];
  return {
    docs,
    findOne: async (q: any, _opts?: any) =>
      docs.find((d) => matchesQuery(d, q)) ?? null,
    updateOne: async (
      filter: any,
      update: any,
      options?: { upsert?: boolean }
    ) => {
      const idx = docs.findIndex((d) => matchesQuery(d, filter));
      if (idx >= 0) {
        if (update.$set) Object.assign(docs[idx], update.$set);
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (options?.upsert) {
        docs.push({
          ...filter,
          ...(update.$set ?? {}),
          ...(update.$setOnInsert ?? {}),
        });
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },
  };
}

let activeColl: ReturnType<typeof makeFakeCollection> | null = null;

function installMongoStub(coll: ReturnType<typeof makeFakeCollection>) {
  activeColl = coll;
  const mongoPath = require.resolve("../lib/mongo");
  if (!require.cache[mongoPath]) {
    const fakeDb = { collection: (_name: string) => activeColl as any };
    require.cache[mongoPath] = {
      id: mongoPath,
      filename: mongoPath,
      loaded: true,
      children: [],
      paths: [],
      exports: { getDb: async () => fakeDb },
    } as any;
  }
}

const emptyPayload = () =>
  new Response(
    JSON.stringify({
      vin: "JTHBW1GG8E2070579",
      serviceHistory: { displayRecords: [] },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

const healthyPayload = () =>
  new Response(
    JSON.stringify({
      vin: "JTHBW1GG8E2070579",
      serviceHistory: {
        displayRecords: [
          {
            type: "service",
            displayDate: "2026-05-01",
            odometer: 82258,
            text: ["Oil change"],
          },
          {
            type: "service",
            displayDate: "2025-11-01",
            odometer: 76000,
            text: ["Tire rotation"],
          },
        ],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

async function main() {
  console.log("CARFAX empty-snapshot short-TTL smoke checks");

  const initialColl = makeFakeCollection();
  installMongoStub(initialColl);
  const carfaxMod = await import("../lib/integrations/carfax");
  fetchCarfaxWithCache = carfaxMod.fetchCarfaxWithCache;
  fetchCarfaxStaleWhileRevalidate = carfaxMod.fetchCarfaxStaleWhileRevalidate;

  process.env.CARFAX_POST_URL = "https://servicesocket.carfax.test/data/1";
  process.env.CARFAX_PDI = "TEST_PDI";
  const VIN = "JTHBW1GG8E2070579";
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  // ---------- 1 + 2. Empty ok snapshot: stamped + short-TTL, then heals ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);
    fakeColl.docs.push({ shopId: 32, carfaxLocationId: "LOC32" });

    let liveCalls = 0;
    let upstreamHealthy = false;
    const spyFetch: any = async () => {
      liveCalls += 1;
      return upstreamHealthy ? healthyPayload() : emptyPayload();
    };

    // First-ever fetch during a CARFAX degradation → ok:true, zero records.
    const first = await fetchCarfaxWithCache(32, VIN, SEVEN_DAYS, spyFetch);
    ok("first fetch fires live and returns ok:true", liveCalls === 1 && first.ok === true);
    ok(
      "empty ok result has no service records",
      !first.serviceRecords || first.serviceRecords.length === 0
    );

    const stored = fakeColl.docs.find((d) => d.shopId === 32 && d.vin === VIN)!;
    ok(
      "empty ok snapshot is stamped with lastEmptyFetchAt",
      stored.lastEmptyFetchAt instanceof Date,
      `lastEmptyFetchAt=${stored.lastEmptyFetchAt}`
    );
    ok("empty ok snapshot persisted with ok:true", stored.ok === true);

    // Immediately after: within the short empty TTL → served from cache.
    await fetchCarfaxWithCache(32, VIN, SEVEN_DAYS, spyFetch);
    ok(
      "within the empty TTL no live re-fetch fires",
      liveCalls === 1,
      `liveCalls=${liveCalls}`
    );

    // Age the snapshot past the short empty TTL but well inside 7 days.
    stored.fetchedAt = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12h ago
    upstreamHealthy = true;

    const healed = await fetchCarfaxWithCache(32, VIN, SEVEN_DAYS, spyFetch);
    ok(
      "past the empty TTL (but <7d) a live re-fetch fires",
      liveCalls === 2,
      `liveCalls=${liveCalls}`
    );
    ok(
      "recovered fetch returns real service records",
      Array.isArray(healed.serviceRecords) && healed.serviceRecords.length === 2
    );
    ok(
      "snapshot is repopulated with the real records",
      Array.isArray(stored.serviceRecords) && stored.serviceRecords.length === 2
    );
  }

  // ---------- 3. Non-empty snapshot keeps full 7-day freshness ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);
    fakeColl.docs.push({ shopId: 32, carfaxLocationId: "LOC32" });
    fakeColl.docs.push({
      shopId: 32,
      vin: VIN,
      ok: true,
      serviceRecords: [{ date: "2026-05-01", odometer: 82258, description: "Oil change" }],
      fetchedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2d ago
    });

    let liveCalls = 0;
    const spyFetch: any = async () => {
      liveCalls += 1;
      return healthyPayload();
    };

    const result = await fetchCarfaxWithCache(32, VIN, SEVEN_DAYS, spyFetch);
    ok(
      "healthy 2-day-old snapshot is still fresh (no refetch churn)",
      liveCalls === 0,
      `liveCalls=${liveCalls}`
    );
    ok("healthy snapshot served from cache", result.ok === true);
  }

  // ---------- 4. SWR path: empty snapshot past short TTL triggers refresh ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);
    fakeColl.docs.push({ shopId: 32, carfaxLocationId: "LOC32" });
    fakeColl.docs.push({
      shopId: 32,
      vin: VIN,
      ok: true,
      serviceRecords: [],
      fetchedAt: new Date(Date.now() - 12 * 60 * 60 * 1000), // 12h ago, <7d
      lastEmptyFetchAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
    });

    let liveCalls = 0;
    const spyFetch: any = async () => {
      liveCalls += 1;
      return healthyPayload();
    };

    const served = await fetchCarfaxStaleWhileRevalidate(32, VIN, SEVEN_DAYS, spyFetch);
    ok("SWR serves the (empty) snapshot instantly", served.ok === true);

    // Give the fire-and-forget refresh a beat to run.
    await new Promise((r) => setTimeout(r, 50));
    ok(
      "SWR background refresh fires for a stale-empty snapshot",
      liveCalls === 1,
      `liveCalls=${liveCalls}`
    );
    const stored = fakeColl.docs.find((d) => d.shopId === 32 && d.vin === VIN)!;
    ok(
      "SWR refresh repopulated the snapshot with real records",
      Array.isArray(stored.serviceRecords) && stored.serviceRecords.length === 2
    );
  }

  if (failed === 0) {
    console.log("\nAll CARFAX empty-snapshot TTL smoke checks passed.");
    process.exit(0);
  } else {
    console.error(`\n${failed} CARFAX empty-snapshot TTL smoke check(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\ncarfax-empty-snapshot-ttl smoke crashed:", err);
  process.exit(1);
});
