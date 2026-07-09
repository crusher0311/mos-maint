/**
 * Smoke test for the CARFAX live-fetch timeout + dashboard negative cache
 * added in `lib/integrations/carfax.ts`.
 *
 * Run: `npx tsx tests/carfax-timeout-negative-cache.smoke.ts`
 *
 * Guards two regressions:
 *
 * 1. `fetchCarfaxLive` must not hang forever on a stalled CARFAX upstream.
 *    It wraps the POST in an AbortController + timeout and returns
 *    `ok:false` with a timeout error instead of pinning the request.
 *
 * 2. `fetchCarfaxWithCache` (the dashboard read path) must NOT re-fire a
 *    live CARFAX call on every load after a recent failure. A short-TTL
 *    negative cache (keyed per shop+vin via the snapshot's `lastErrorAt`)
 *    suppresses re-fetching within the window and serves whatever snapshot
 *    exists (previously-good data when it was preserved, otherwise the
 *    recorded failure).
 */

import type {
  fetchCarfaxLive as FetchCarfaxLive,
  fetchCarfaxWithCache as FetchCarfaxWithCache,
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

let fetchCarfaxLive: typeof FetchCarfaxLive;
let fetchCarfaxWithCache: typeof FetchCarfaxWithCache;

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

async function main() {
  console.log("CARFAX timeout + negative-cache smoke checks");

  const initialColl = makeFakeCollection();
  installMongoStub(initialColl);
  const carfaxMod = await import("../lib/integrations/carfax");
  fetchCarfaxLive = carfaxMod.fetchCarfaxLive;
  fetchCarfaxWithCache = carfaxMod.fetchCarfaxWithCache;

  process.env.CARFAX_POST_URL = "https://servicesocket.carfax.test/data/1";
  process.env.CARFAX_PDI = "TEST_PDI";

  // ---------- 1. fetchCarfaxLive: stalled upstream aborts on timeout ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);
    fakeColl.docs.push({ shopId: 999, carfaxLocationId: "LOC123" });

    process.env.CARFAX_TIMEOUT_MS = "60";

    // A fetch that never resolves unless aborted — mimics a hung upstream.
    const stalledFetch: any = (_url: string, opts: any) =>
      new Promise((_resolve, reject) => {
        const signal: AbortSignal | undefined = opts?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const e = new Error("The operation was aborted");
            (e as any).name = "AbortError";
            reject(e);
          });
        }
      });

    const started = Date.now();
    const result = await fetchCarfaxLive(999, "1GYS4MKJ4GR434503", stalledFetch);
    const elapsed = Date.now() - started;

    ok(
      "stalled upstream returns ok:false (does not hang)",
      result.ok === false,
      `got ok=${result.ok}`
    );
    ok(
      "timeout error message mentions timed out",
      typeof result.error === "string" && /timed out/i.test(result.error),
      result.error
    );
    ok(
      "aborts near the configured timeout (< 2s), not hanging",
      elapsed < 2000,
      `elapsed=${elapsed}ms`
    );

    delete process.env.CARFAX_TIMEOUT_MS;
  }

  // ---------- 2. fetchCarfaxWithCache: recent failure is negative-cached ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);
    // Shop config doc (same collection is shared for shops + carfax_reports).
    fakeColl.docs.push({ shopId: 63, carfaxLocationId: "LOC123" });

    const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30d ago
    // A previously-good snapshot that later failed a live fetch just now:
    // fetchedAt is stale (not fresh), but lastErrorAt is recent.
    fakeColl.docs.push({
      shopId: 63,
      vin: "1GYS4MKJ4GR434503",
      ok: true,
      serviceRecords: [
        { date: "2025-08-12", odometer: 80120, description: "Oil change" },
      ],
      lastReportedMileage: 80120,
      fetchedAt: staleDate,
      lastFetchAttemptAt: new Date(),
      lastErrorAt: new Date(), // failed just now → within negative window
    });

    let liveCalls = 0;
    const spyFetch: any = async () => {
      liveCalls += 1;
      return new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await fetchCarfaxWithCache(
      63,
      "1GYS4MKJ4GR434503",
      7 * 24 * 60 * 60 * 1000,
      spyFetch
    );

    ok(
      "recent failure suppresses the live fetch (negative cache honored)",
      liveCalls === 0,
      `liveCalls=${liveCalls}`
    );
    ok(
      "negative-cached read still serves previously-good data (ok:true)",
      result.ok === true,
      `got ok=${result.ok}`
    );
    ok(
      "negative-cached read returns the preserved serviceRecords",
      Array.isArray(result.serviceRecords) &&
        result.serviceRecords.length === 1,
    );
  }

  // ---------- 3. fetchCarfaxWithCache: expired negative window re-fetches ----------
  {
    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);
    fakeColl.docs.push({ shopId: 63, carfaxLocationId: "LOC123" });

    const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const oldError = new Date(Date.now() - 60 * 60 * 1000); // 1h ago (> 15m TTL)
    fakeColl.docs.push({
      shopId: 63,
      vin: "1GYS4MKJ4GR434503",
      ok: true,
      serviceRecords: [
        { date: "2025-08-12", odometer: 80120, description: "Oil change" },
      ],
      fetchedAt: staleDate,
      lastErrorAt: oldError,
    });

    let liveCalls = 0;
    const spyFetch: any = async () => {
      liveCalls += 1;
      return new Response(
        JSON.stringify({
          vin: "1GYS4MKJ4GR434503",
          serviceHistory: {
            displayRecords: [
              {
                type: "service",
                displayDate: "2026-05-01",
                odometer: 92000,
                text: ["Tire rotation"],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    await fetchCarfaxWithCache(
      63,
      "1GYS4MKJ4GR434503",
      7 * 24 * 60 * 60 * 1000,
      spyFetch
    );

    ok(
      "expired negative window allows a live re-fetch",
      liveCalls === 1,
      `liveCalls=${liveCalls}`
    );
  }

  // ---------- 4. first-ever failure: suppressed within TTL, retried after ----------
  {
    process.env.CARFAX_NEGATIVE_CACHE_MS = "60000"; // 1 min window

    const fakeColl = makeFakeCollection();
    installMongoStub(fakeColl);
    fakeColl.docs.push({ shopId: 77, carfaxLocationId: "LOC777" });

    // No prior snapshot at all; upstream fails with an in-band 107.
    let liveCalls = 0;
    const failingFetch: any = async () => {
      liveCalls += 1;
      return new Response(
        JSON.stringify({
          errorMessages: { errors: [{ code: 107, message: "VIN not valid" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    // First load: no doc → live fetch happens and fails, persisting ok:false
    // with fetchedAt=now (first-ever failure canonical path).
    const first = await fetchCarfaxWithCache(
      77,
      "FIRSTEVERFAILVIN01",
      7 * 24 * 60 * 60 * 1000,
      failingFetch
    );
    ok("first-ever load performs the live fetch", liveCalls === 1);
    ok("first-ever failure returns ok:false", first.ok === false);

    // Second load immediately after: must be suppressed by the negative cache,
    // NOT treated as fresh for 7 days.
    const second = await fetchCarfaxWithCache(
      77,
      "FIRSTEVERFAILVIN01",
      7 * 24 * 60 * 60 * 1000,
      failingFetch
    );
    ok(
      "first-ever failure is negative-cached (no immediate re-fetch)",
      liveCalls === 1,
      `liveCalls=${liveCalls}`
    );
    ok("negative-cached first-ever failure still returns ok:false", second.ok === false);

    // Now expire the negative window by backdating lastErrorAt past the TTL.
    const stored = fakeColl.docs.find(
      (d) => d.shopId === 77 && d.vin === "FIRSTEVERFAILVIN01"
    )!;
    stored.lastErrorAt = new Date(Date.now() - 5 * 60 * 1000); // 5m ago
    // fetchedAt is still "recent" but ok:false must not count as fresh.

    await fetchCarfaxWithCache(
      77,
      "FIRSTEVERFAILVIN01",
      7 * 24 * 60 * 60 * 1000,
      failingFetch
    );
    ok(
      "after negative TTL expires, a failed snapshot is retried (not fresh-locked)",
      liveCalls === 2,
      `liveCalls=${liveCalls}`
    );

    delete process.env.CARFAX_NEGATIVE_CACHE_MS;
  }

  if (failed === 0) {
    console.log("\nAll CARFAX timeout + negative-cache smoke checks passed.");
    process.exit(0);
  } else {
    console.error(
      `\n${failed} CARFAX timeout + negative-cache smoke check(s) failed.`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\ncarfax-timeout-negative-cache smoke crashed:", err);
  process.exit(1);
});
