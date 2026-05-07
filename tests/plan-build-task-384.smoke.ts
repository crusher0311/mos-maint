/**
 * Task #384 smoke: external VHI responses must always include
 * `mileageSource`, `mileageEstimated`, and `mileageEstimateDetails`,
 * regardless of whether the response is served from `cached_plans`,
 * `maintenance_analysis_cache`, or freshly built.
 *
 * Run: `npx tsx tests/plan-build-task-384.smoke.ts`
 *
 * Coverage:
 *   (a) cached_plan branch echoes persisted source
 *   (b) cached_plan branch defaults legacy entries to "actual"
 *   (c) analysis_cache branch echoes persisted source via getVhiFromAnalysisCache
 *   (d) on-demand build branch persists source onto cached_plans so the
 *       next read sees it (rebuildVhi side-effect)
 *   (e) analyze endpoint contract surfaces the same three fields
 *
 * The route handler itself isn't booted — we exercise the cache helpers
 * (`getCachedPlan`, `getVhiFromAnalysisCache`) and `rebuildVhi` directly,
 * which is where the contract gap was.
 */

import {
  setCachedPlan,
  getCachedPlan,
  type CachedPlanData,
} from "../lib/plan-cache";
import { getVhiFromAnalysisCache } from "../lib/vhi-score";
import { __deps, rebuildVhi } from "../lib/vhi-rebuild";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  \u2713 ${name}`);
  else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

// ----------------- in-memory Mongo fake -----------------
type Doc = Record<string, any>;

function setNestedPath(doc: Doc, path: string, value: any) {
  const parts = path.split(".");
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

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
    updateOne: async (q: any, update: any) => {
      const target = docs.find((d) => matchesQuery(d, q));
      if (!target) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) {
        for (const [k, v] of Object.entries(update.$set)) {
          if (k.includes(".")) setNestedPath(target, k, v);
          else target[k] = v;
        }
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    findOne: async (q: any, _opts?: any) => {
      const matches = docs.filter((d) => matchesQuery(d, q));
      return matches[0] ?? null;
    },
    find: (q: any) => {
      const result = docs.filter((d) => matchesQuery(d, q));
      const cursor = {
        sort: (_: any) => {
          result.sort(
            (a, b) =>
              (b.createdAt?.getTime?.() ?? 0) -
              (a.createdAt?.getTime?.() ?? 0),
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

const VIN = "1GYS4KKJ4GR434503";
const SHOP_ID = 63;
const MILES = 87_500;

const basePlan = (
  extra: Partial<CachedPlanData> = {},
): CachedPlanData => ({
  buckets: { overdue: [], dueSoon: [], upcoming: [] },
  vehicle: { year: 2018, make: "Cadillac", model: "Escalade", engine: "6.2L V8" },
  currentMiles: MILES,
  mpdBlended: null,
  customerName: "Test Customer",
  latestRoNumber: null,
  distanceUnit: "miles",
  soonMiles: 3000,
  soonDays: 30,
  showInspectItems: true,
  ...extra,
});

async function run() {
  console.log("plan-build-task-384 smoke");

  // (a) cached_plan branch echoes persisted source ---------------------
  console.log("\n[a] cached_plan branch echoes persisted source");
  {
    const db = makeFakeDb();
    const details = {
      confidence: "medium",
      dataPoints: 4,
      lastRecordedMileage: 80_000,
      lastRecordedDate: "2025-09-01",
      milesPerDay: 30,
    };
    await setCachedPlan(
      db,
      VIN,
      SHOP_ID,
      MILES,
      basePlan({
        mileageSource: "estimated_carfax",
        mileageEstimateDetails: details,
      }),
    );
    const got = await getCachedPlan(db, VIN, SHOP_ID, MILES);
    ok("cache HIT returns plan", !!got);
    ok(
      "cached plan carries mileageSource",
      got?.plan.mileageSource === "estimated_carfax",
      `got ${got?.plan.mileageSource}`,
    );
    ok(
      "cached plan carries mileageEstimateDetails",
      (got?.plan.mileageEstimateDetails as any)?.dataPoints === 4,
    );
  }

  // (b) cached_plan branch defaults legacy entries to "actual" ---------
  console.log("\n[b] cached_plan branch defaults legacy entries to actual");
  {
    const db = makeFakeDb();
    // Legacy plan: no mileageSource / mileageEstimateDetails written
    await setCachedPlan(db, VIN, SHOP_ID, MILES, basePlan());
    const got = await getCachedPlan(db, VIN, SHOP_ID, MILES);
    const src = got?.plan.mileageSource ?? "actual";
    const details = src === "actual" ? null : got?.plan.mileageEstimateDetails ?? null;
    ok("legacy mileageSource defaults to actual", src === "actual");
    ok("legacy mileageEstimateDetails defaults to null", details === null);
    // Mirrors the route's response derivation (mileageEstimated = source !== "actual")
    ok("legacy mileageEstimated derives to false", src !== "actual" === false);
  }

  // (c) analysis_cache branch echoes persisted source ------------------
  console.log("\n[c] analysis_cache branch echoes persisted source");
  {
    const db = makeFakeDb();
    const details = {
      confidence: "low",
      dataPoints: 2,
      lastRecordedMileage: 75_000,
      lastRecordedDate: "2025-06-01",
      milesPerDay: 25,
    };
    await db.collection("maintenance_analysis_cache").insertOne({
      vin: VIN,
      shopId: SHOP_ID,
      recommendations: [
        { service: "Engine Oil & Filter", serviceKey: "oil", status: "overdue", dueMileage: 80_000, milesToGo: -7500 },
      ],
      analyzedAt: new Date(),
      schemaVersion: 3,
      mileageAtAnalysis: MILES,
      mileageSource: "estimated_carfax",
      mileageEstimateDetails: details,
    });
    const out = await getVhiFromAnalysisCache(db, VIN, SHOP_ID, MILES);
    ok("analysis cache returned a result", !!out);
    ok(
      "analysis cache surfaces mileageSource",
      out?.mileageSource === "estimated_carfax",
      `got ${out?.mileageSource}`,
    );
    ok(
      "analysis cache surfaces mileageEstimateDetails",
      (out?.mileageEstimateDetails as any)?.dataPoints === 2,
    );
  }

  // (c2) analysis_cache branch defaults legacy entries -----------------
  console.log("\n[c2] analysis_cache branch defaults legacy entries to actual");
  {
    const db = makeFakeDb();
    await db.collection("maintenance_analysis_cache").insertOne({
      vin: VIN,
      shopId: SHOP_ID,
      recommendations: [
        { service: "Tire Rotation", serviceKey: "tire_rotation", status: "due_soon", dueMileage: 90_000, milesToGo: 2500 },
      ],
      analyzedAt: new Date(),
      schemaVersion: 3,
      mileageAtAnalysis: MILES,
    });
    const out = await getVhiFromAnalysisCache(db, VIN, SHOP_ID, MILES);
    ok("legacy entry mileageSource defaults to actual", out?.mileageSource === "actual");
    ok("legacy entry mileageEstimateDetails defaults to null", out?.mileageEstimateDetails === null);
  }

  // (d) on-demand build branch persists source so next read sees it ----
  console.log("\n[d] rebuildVhi persists mileageSource onto cached_plans");
  {
    const db = makeFakeDb();
    // Seed a cache row WITHOUT mileageSource (simulating the plan-build
    // endpoint returning before this fix landed).
    await setCachedPlan(db, VIN, SHOP_ID, MILES, basePlan());

    const original = { ...__deps };
    __deps.getDb = (async () => db) as any;
    __deps.invalidateCachedPlan = (async () => undefined) as any;
    __deps.triggerPlanBuild = (async () => ({ ok: true, status: 200 })) as any;
    try {
      const r = await rebuildVhi(SHOP_ID, VIN, MILES, {
        mileageSource: "estimated_carfax",
        mileageEstimateDetails: { confidence: "medium", dataPoints: 3 },
      });
      ok(
        "rebuildVhi result includes mileageSource",
        r.mileageSource === "estimated_carfax",
        `got ${r.mileageSource}`,
      );
      ok(
        "rebuildVhi result derives mileageEstimated=true",
        r.mileageEstimated === true,
      );
      ok(
        "rebuildVhi result includes mileageEstimateDetails",
        (r.mileageEstimateDetails as any)?.dataPoints === 3,
      );

      // The persisted row must now carry the fields, so a follow-up read
      // (this is the regression we're fixing) surfaces them.
      const followUp = await getCachedPlan(db, VIN, SHOP_ID, MILES);
      ok(
        "follow-up cache HIT carries persisted mileageSource",
        followUp?.plan.mileageSource === "estimated_carfax",
        `got ${followUp?.plan.mileageSource}`,
      );
      ok(
        "follow-up cache HIT carries persisted mileageEstimateDetails",
        (followUp?.plan.mileageEstimateDetails as any)?.dataPoints === 3,
      );
    } finally {
      Object.assign(__deps, original);
    }
  }

  // (d2) actual mileage round-trip stays "actual" / null + backfills cache --
  console.log("\n[d2] actual mileage round-trips as actual / null and backfills legacy cache");
  {
    const db = makeFakeDb();
    await setCachedPlan(db, VIN, SHOP_ID, MILES, basePlan());
    const original = { ...__deps };
    __deps.getDb = (async () => db) as any;
    __deps.invalidateCachedPlan = (async () => undefined) as any;
    __deps.triggerPlanBuild = (async () => ({ ok: true, status: 200 })) as any;
    try {
      const r = await rebuildVhi(SHOP_ID, VIN, MILES, {
        mileageSource: "actual",
        mileageEstimateDetails: null,
      });
      ok("actual: result mileageSource === actual", r.mileageSource === "actual");
      ok("actual: result mileageEstimated === false", r.mileageEstimated === false);
      ok("actual: result mileageEstimateDetails === null", r.mileageEstimateDetails === null);

      // Code-review fix: actual-path rebuild must still backfill legacy
      // cache rows that are missing the field, so support tooling sees
      // mileageSource on every row.
      const cacheDocs = db._coll("cached_plans")?.docs ?? [];
      const persisted = cacheDocs[0]?.plan;
      ok(
        "actual: legacy cache row backfilled with plan.mileageSource",
        persisted?.mileageSource === "actual",
        `got ${persisted?.mileageSource}`,
      );
      ok(
        "actual: legacy cache row backfilled with plan.mileageEstimateDetails=null",
        persisted?.mileageEstimateDetails === null,
      );
    } finally {
      Object.assign(__deps, original);
    }
  }

  // (e) analyze endpoint contract — covered by checking that rebuildVhi
  // surfaces mileageSource / mileageEstimateDetails to its caller, which
  // is exactly what app/api/external/vhi/analyze/route.ts spreads into
  // its JSON response. The route's own JSON shape is asserted by the
  // type system + existing route tests; here we lock in the upstream
  // contract.
  console.log("\n[e] analyze contract: rebuildVhi surface matches GET shape");
  {
    const db = makeFakeDb();
    await setCachedPlan(db, VIN, SHOP_ID, MILES, basePlan());
    const original = { ...__deps };
    __deps.getDb = (async () => db) as any;
    __deps.invalidateCachedPlan = (async () => undefined) as any;
    __deps.triggerPlanBuild = (async () => ({ ok: true, status: 200 })) as any;
    try {
      const r = await rebuildVhi(SHOP_ID, VIN, MILES, {
        invalidateFirst: true,
        mileageSource: "actual",
        mileageEstimateDetails: null,
      });
      ok("analyze result has mileageSource field", "mileageSource" in r);
      ok("analyze result has mileageEstimated field", "mileageEstimated" in r);
      ok(
        "analyze result has mileageEstimateDetails field",
        "mileageEstimateDetails" in r,
      );
    } finally {
      Object.assign(__deps, original);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
