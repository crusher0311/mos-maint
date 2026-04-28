/**
 * Smoke test for the final cache write via `setCachedPlan` /
 * `getCachedPlan` in `lib/plan-cache.ts`.
 *
 * Run: `npx tsx tests/plan-build-cache-write.smoke.ts`
 *
 * The plan-build route ends with `setCachedPlan(db, vin, shopId, mileage,
 * planData)` — and a cold read from `getCachedPlan` is what the customer
 * sees on the next plan request. A regression that:
 *
 *   - drops the schemaVersion stamp (cache hits would serve old shapes),
 *   - skips the `deleteMany` (duplicate entries pile up per VIN),
 *   - writes the wrong VIN/shopId casing,
 *   - or computes a too-short / too-long expiresAt
 *
 * would all ship green today. This test stubs out MongoDB with an
 * in-memory fake `Db` collection so the real `setCachedPlan` /
 * `getCachedPlan` codepaths run end-to-end without needing a live Mongo.
 */

import {
  setCachedPlan,
  getCachedPlan,
  PLAN_CACHE_SCHEMA_VERSION,
  type CachedPlanData,
} from "../lib/plan-cache";

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
    if (v !== null && typeof v === "object" && "$in" in (v as any)) {
      const arr = (v as any).$in as any[];
      if (!arr.some((cand) => cand === doc[k])) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }
  return true;
}

function makeFakeCollection() {
  const docs: Doc[] = [];
  return {
    docs,
    deleteMany: async (q: any) => {
      const before = docs.length;
      for (let i = docs.length - 1; i >= 0; i--) {
        if (matchesQuery(docs[i], q)) docs.splice(i, 1);
      }
      return { deletedCount: before - docs.length };
    },
    insertOne: async (doc: Doc) => {
      docs.push(doc);
      return { insertedId: docs.length };
    },
    find: (q: any) => {
      const result = docs.filter((d) => matchesQuery(d, q));
      const cursor = {
        sort: (_: any) => {
          // Match getCachedPlan's createdAt:-1 sort (newest first).
          result.sort(
            (a, b) =>
              (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0),
          );
          return cursor;
        },
        toArray: async () => result.slice(),
      };
      return cursor;
    },
  };
}

type FakeColl = ReturnType<typeof makeFakeCollection>;

function makeFakeDb() {
  const collections = new Map<string, FakeColl>();
  return {
    collection: (name: string) => {
      if (!collections.has(name)) collections.set(name, makeFakeCollection());
      return collections.get(name)!;
    },
    _coll: (name: string): FakeColl | undefined => collections.get(name),
  } as any;
}

// ----------------- fixture plan -----------------
const samplePlan: CachedPlanData = {
  buckets: {
    overdue: [
      {
        key: "oil_replace_1",
        serviceKey: "oil",
        title: "Replace engine oil and filter",
        category: "Engine",
        intervalMiles: 10000,
        intervalMonths: 12,
        dueAtMiles: 65000,
        dueAtDate: "2026-05-01T00:00:00.000Z",
        milesToGo: -5000,
        daysToGo: 3,
        bump: null,
        source: "oem",
        action: "replace",
        notes: null,
        recommendedDefault: false,
      },
    ],
    dueSoon: [],
    upcoming: [],
  },
  vehicle: { year: 2019, make: "Ram", model: "1500", engine: "5.7L V8" },
  currentMiles: 70000,
  mpdBlended: 35,
  customerName: "Test Customer",
  latestRoNumber: "1234",
  distanceUnit: "miles",
  soonMiles: 1000,
  soonDays: 30,
  showInspectItems: false,
};

async function main() {
  console.log("Plan-build cache-write smoke checks");

  // ----------------- 1. fresh write + read round-trip -----------------
  {
    const db = makeFakeDb();
    const vin = "1c6rr6fg7ks516181"; // intentionally lowercase — must be normalized
    const shopId = 42;
    const mileage = 70000;

    await setCachedPlan(db, vin, shopId, mileage, samplePlan);

    const coll = db._coll("cached_plans") as FakeColl;
    ok("setCachedPlan inserts exactly one doc", coll.docs.length === 1);

    const stored = coll.docs[0];
    ok(
      "stored doc normalizes VIN to upper case",
      stored.vin === "1C6RR6FG7KS516181",
      `vin=${stored.vin}`,
    );
    ok(
      "stored doc normalizes shopId to a number",
      stored.shopId === 42 && typeof stored.shopId === "number",
    );
    ok("stored doc carries the mileage", stored.mileage === mileage);
    ok(
      "stored doc stamps the current schema version",
      stored.schemaVersion === PLAN_CACHE_SCHEMA_VERSION,
      `schemaVersion=${stored.schemaVersion}`,
    );
    ok(
      "stored doc has createdAt and expiresAt Dates",
      stored.createdAt instanceof Date && stored.expiresAt instanceof Date,
    );
    // 4-hour TTL ± 1s.
    const ttlMs = stored.expiresAt.getTime() - stored.createdAt.getTime();
    ok(
      "expiresAt is ~4 hours after createdAt",
      Math.abs(ttlMs - 4 * 60 * 60 * 1000) < 1000,
      `ttlMs=${ttlMs}`,
    );
    ok(
      "stored doc carries the plan payload verbatim",
      stored.plan?.buckets?.overdue?.[0]?.serviceKey === "oil",
    );

    // Round-trip: getCachedPlan finds the entry by upper-case VIN regardless
    // of the casing originally written.
    const cached = await getCachedPlan(db, "1C6RR6FG7KS516181", shopId, mileage);
    ok("getCachedPlan finds the entry just written", cached != null);
    ok(
      "round-trip preserves the plan payload",
      cached?.plan.buckets.overdue[0]?.serviceKey === "oil",
    );
    ok(
      "round-trip preserves the schemaVersion",
      cached?.schemaVersion === PLAN_CACHE_SCHEMA_VERSION,
    );
  }

  // ----------------- 2. re-write replaces (no duplicate) -----------------
  {
    const db = makeFakeDb();
    const vin = "1C6RR6FG7KS516181";
    await setCachedPlan(db, vin, 42, 70000, samplePlan);
    await setCachedPlan(db, vin, 42, 70500, samplePlan);
    await setCachedPlan(db, vin, 42, 71000, samplePlan);

    const coll = db._coll("cached_plans") as FakeColl;
    ok(
      "repeated setCachedPlan calls leave only ONE doc per (vin, shopId)",
      coll.docs.length === 1,
      `docs.length=${coll.docs.length}`,
    );
    ok(
      "the surviving doc reflects the latest mileage write",
      coll.docs[0].mileage === 71000,
    );

    // Sibling shop entries are NOT touched.
    await setCachedPlan(db, vin, 99, 71000, samplePlan);
    ok(
      "writing for a different shopId does NOT delete the original shop's entry",
      coll.docs.length === 2,
    );
  }

  // ----------------- 3. mileage-tolerance guard on read -----------------
  {
    const db = makeFakeDb();
    await setCachedPlan(db, "ABCDEFGHJKLMNPQRS", 7, 70000, samplePlan);

    const within = await getCachedPlan(db, "ABCDEFGHJKLMNPQRS", 7, 70300);
    ok("getCachedPlan HITs within the 500-mile tolerance window", within != null);

    const outside = await getCachedPlan(db, "ABCDEFGHJKLMNPQRS", 7, 71000);
    ok(
      "getCachedPlan MISSes when the new mileage is beyond the tolerance",
      outside === null,
    );
  }

  // ----------------- 4. stale schemaVersion is skipped -----------------
  {
    const db = makeFakeDb();
    const coll = db.collection("cached_plans") as FakeColl;
    const now = new Date();
    coll.docs.push({
      vin: "ABCDEFGHJKLMNPQRT",
      shopId: 7,
      mileage: 70000,
      plan: samplePlan,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 4 * 60 * 60 * 1000),
      schemaVersion: PLAN_CACHE_SCHEMA_VERSION - 1,
    });

    const stale = await getCachedPlan(db, "ABCDEFGHJKLMNPQRT", 7, 70000);
    ok(
      "getCachedPlan SKIPs entries with an older schemaVersion",
      stale === null,
    );
  }

  // ----------------- 5. expired entry is skipped -----------------
  {
    const db = makeFakeDb();
    const coll = db.collection("cached_plans") as FakeColl;
    const past = new Date(Date.now() - 5 * 60 * 60 * 1000);
    coll.docs.push({
      vin: "ABCDEFGHJKLMNPQRU",
      shopId: 7,
      mileage: 70000,
      plan: samplePlan,
      createdAt: past,
      expiresAt: new Date(past.getTime() + 4 * 60 * 60 * 1000),
      schemaVersion: PLAN_CACHE_SCHEMA_VERSION,
    });

    const expired = await getCachedPlan(db, "ABCDEFGHJKLMNPQRU", 7, 70000);
    ok("getCachedPlan SKIPs entries past their expiresAt", expired === null);
  }

  if (failed === 0) {
    console.log("\nAll plan-build cache-write smoke checks passed.");
    process.exit(0);
  } else {
    console.error(`\n${failed} plan-build cache-write smoke check(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nplan-build cache-write smoke crashed:", err);
  process.exit(1);
});
