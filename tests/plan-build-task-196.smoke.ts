/**
 * Regression smoke test for Task #196 (engine-aware oil warning end-to-end
 * in the side panel).
 *
 * Run: `npx tsx tests/plan-build-task-196.smoke.ts`
 *
 * Task #175 wires the engine-risk chip and the auto-inserted "Safety
 * Check — Oil Level" row through the shop extension via two paths
 * (cached dashboard plan and on-demand analysis). This test exercises
 * BOTH paths against a Pentastar 3.6L Ram (flagged) and a 5.7L Tundra
 * V8 (not flagged) and asserts the side-panel item shape:
 *
 *   1. Cached-plan path: `triage()` produces the dashboard's
 *      `TriagedItem` shape; we then run those items through
 *      `convertCachedPlanItemForSidePanel` (the extracted module-scope
 *      helper formerly inlined as `convertItem` in the GET handler) and
 *      check the converted side-panel rows.
 *
 *   2. On-demand path: `runOnDemandAnalysis` is invoked directly with
 *      `__deps.getDb` swapped to an in-memory Mongo (`makeFakeDb`) and
 *      a prefetched OEM result so the test never touches DataOne or
 *      the real Tekmetric history collection.
 *
 * The flagged engine MUST surface `engineRiskFlag: true`,
 * `engineRiskReason` (non-empty), and a "Safety Check — Oil Level" row
 * with `serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY` and
 * `interval === SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES` (3,000 mi). The
 * unflagged engine MUST NOT auto-insert a safety-check row, and its
 * oil row MUST have a falsy `engineRiskFlag`.
 */

import { triage, type OEMItem, type TriagedItem } from "../lib/plan-build/triage";
import {
  classifyEngineRisk,
  OIL_INTERVAL_RISK_THRESHOLD_MILES,
  SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES,
  SAFETY_CHECK_OIL_LEVEL_KEY,
  SAFETY_CHECK_OIL_LEVEL_TITLE,
  type EngineProfile,
} from "../lib/engine-risk";
import { makeFakeDb } from "./utils/fake-mongo";

// Type-only import: the runtime module is loaded lazily inside main()
// after the require.cache shim is installed (see comment there).
type RouteModule = typeof import("../app/api/extension/plan/route");

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

async function main() {

// `lib/integrations/carfax.ts` (transitively imported by the route)
// imports the `server-only` package, which throws if it's loaded outside
// a Server Component build. Stub it via require.cache BEFORE the route
// module is imported below so the carfax module can be resolved without
// exploding. The test never calls into carfax.
const serverOnlyPath = require.resolve("server-only");
require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  children: [],
  paths: [],
  exports: {},
} as any;

const routeModule: RouteModule = await import("../app/api/extension/plan/route");
const { __deps, convertCachedPlanItemForSidePanel, runOnDemandAnalysis } = routeModule;

console.log("Task #196 regression checks");

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PENTASTAR_PROFILE: EngineProfile = {
  engine_name: "3.6L V6 Pentastar",
  engine_size: 3.6,
  engine_block: "V",
  engine_cylinders: 6,
  engine_induction: "Multipoint Fuel Injection",
  engine_aspiration: "Naturally Aspirated",
  fuel_type: "G",
  make: "Ram",
  model: "1500",
  year: 2019,
};

const SAFE_TUNDRA_PROFILE: EngineProfile = {
  engine_name: "5.7L V8",
  engine_size: 5.7,
  engine_block: "V",
  engine_cylinders: 8,
  engine_induction: "Multipoint Fuel Injection",
  engine_aspiration: "Naturally Aspirated",
  fuel_type: "G",
  make: "Toyota",
  model: "Tundra",
  year: 2019,
};

// OEM rows are kept tiny: an oil row at 10,000 mi (above the 7,500 mi
// risk threshold so the engine-risk chip activates on a flagged engine)
// plus an unrelated cabin-air row so the OEM list isn't degenerate.
function makeOilOnlyOemItems(): OEMItem[] {
  return [
    {
      maintenance_id: 1,
      name: "Engine oil & filter — Replace",
      category: "Engine",
      miles: 10_000,
      months: 12,
      notes: null,
      intervals: [],
      intervalMilesNormal: 10_000,
      intervalMonthsNormal: 12,
      intervalMilesSevere: 10_000,
      intervalMonthsSevere: 12,
    },
    {
      maintenance_id: 2,
      name: "Cabin air filter — Replace",
      category: "HVAC",
      miles: 20_000,
      months: 24,
      notes: null,
      intervals: [],
    },
  ];
}

// Same shape DataOne returns from `getMaintenanceScheduleCached` — the
// route reads `oemResult.items[*].maintenance_name`, `.maintenance_category`,
// `.miles`, `.months`, plus the duty-cycle fields and the `vehicle` block
// for engine-risk classification.
function makeOemResult(profile: EngineProfile, source: "api" | "cache" = "cache") {
  return {
    ok: true,
    vin: "TESTVIN0000000196",
    squish: "TESTVIN0019",
    count: 2,
    source,
    items: [
      {
        maintenance_id: 1,
        maintenance_category: "Engine",
        maintenance_name: "Engine oil & filter — Replace",
        maintenance_notes: null,
        intervals: [],
        miles: 10_000,
        months: 12,
        intervalMilesNormal: 10_000,
        intervalMonthsNormal: 12,
        intervalMilesSevere: 10_000,
        intervalMonthsSevere: 12,
      },
      {
        maintenance_id: 2,
        maintenance_category: "HVAC",
        maintenance_name: "Cabin air filter — Replace",
        maintenance_notes: null,
        intervals: [],
        miles: 20_000,
        months: 24,
        intervalMilesNormal: null,
        intervalMonthsNormal: null,
        intervalMilesSevere: null,
        intervalMonthsSevere: null,
      },
    ],
    vehicle: {
      year: profile.year ?? null,
      make: profile.make ?? "",
      model: profile.model ?? "",
      engine: profile.engine_name ?? "",
      engine_size: profile.engine_size ?? null,
      engine_block: profile.engine_block ?? null,
      engine_cylinders: profile.engine_cylinders ?? null,
      engine_induction: profile.engine_induction ?? null,
      engine_aspiration: profile.engine_aspiration ?? null,
      fuel_type: profile.fuel_type ?? null,
    },
    fetchedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
  };
}

// Sanity guard: the test's chosen oil interval must actually trigger the
// engine-risk chip; without this, a future bump to the threshold could
// silently make the test pass for the wrong reason.
ok(
  "Test oil interval (10,000 mi) >= OIL_INTERVAL_RISK_THRESHOLD_MILES",
  10_000 >= OIL_INTERVAL_RISK_THRESHOLD_MILES,
  `threshold is ${OIL_INTERVAL_RISK_THRESHOLD_MILES}`,
);

// ---------------------------------------------------------------------------
// 1. Cached-plan path: triage() -> convertCachedPlanItemForSidePanel()
// ---------------------------------------------------------------------------
//
// The dashboard caches `TriagedItem`s under `cached_plans.plan.buckets.*`;
// the side panel reads them back via `getCachedPlan` and converts each
// one through what used to be the inline `convertItem` closure. This
// section exercises that conversion directly so a regression in either
// `triage()`'s engine-risk fields or the convert function's mapping of
// them surfaces here.

console.log("\n[1] Cached-plan path (triage -> convertCachedPlanItemForSidePanel)");

const flaggedRisk = classifyEngineRisk(PENTASTAR_PROFILE);
ok("Pentastar profile flagged by classifier", flaggedRisk.flagged === true);

const flaggedTriaged = triage({
  oemItems: makeOilOnlyOemItems(),
  carfaxRecords: [],
  shopServiceHistory: [],
  currentMiles: 50_000,
  dviFindings: [],
  vehicleYear: 2019,
  engineRisk: flaggedRisk,
});

const flaggedAllItems: TriagedItem[] = [
  ...flaggedTriaged.overdue,
  ...flaggedTriaged.dueSoon,
  ...flaggedTriaged.upcoming,
];

const flaggedOilTriaged = flaggedAllItems.find((it) => it.serviceKey === "oil");
ok(
  "Pentastar plan: triage emits oil row",
  flaggedOilTriaged != null,
);
ok(
  "Pentastar plan: oil row carries engineRiskFlag=true",
  flaggedOilTriaged?.engineRiskFlag === true,
);
ok(
  "Pentastar plan: oil row carries non-empty engineRiskReason",
  typeof flaggedOilTriaged?.engineRiskReason === "string" &&
    (flaggedOilTriaged?.engineRiskReason ?? "").length > 0,
);

const flaggedSafetyTriaged = flaggedAllItems.find(
  (it) => it.serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY,
);
ok(
  "Pentastar plan: triage auto-inserts Safety Check — Oil Level",
  flaggedSafetyTriaged != null,
);
ok(
  "Pentastar plan: safety row interval = SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES (3,000 mi)",
  flaggedSafetyTriaged?.intervalMiles === SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES,
);

// Now run the cached items through the side-panel converter. This is the
// "convertItem" half of the cached-plan path — the conversion that the
// extension's GET handler runs against `cachedPlan.plan.buckets.*` rows
// before sending them to the Chrome extension UI.
const flaggedConverted = flaggedAllItems.map((it) =>
  convertCachedPlanItemForSidePanel(it, undefined, {
    cachedCurrentMiles: 50_000,
    currentRoAuthorizedJobs: [],
    currentRoAllJobs: [],
  }),
);

const convertedFlaggedOil = flaggedConverted.find((c) => c.serviceKey === "oil");
ok(
  "Cached-plan side-panel: oil row exposes engineRiskFlag=true",
  convertedFlaggedOil?.engineRiskFlag === true,
);
ok(
  "Cached-plan side-panel: oil row exposes non-empty engineRiskReason",
  typeof convertedFlaggedOil?.engineRiskReason === "string" &&
    (convertedFlaggedOil?.engineRiskReason ?? "").length > 0,
);

const convertedFlaggedSafety = flaggedConverted.find(
  (c) => c.serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY,
);
ok(
  "Cached-plan side-panel: Safety Check — Oil Level row present",
  convertedFlaggedSafety != null,
);
ok(
  "Cached-plan side-panel: safety row interval === 3000",
  convertedFlaggedSafety?.interval === SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES,
);
ok(
  "Cached-plan side-panel: safety row serviceKey === safety_check_oil_level",
  convertedFlaggedSafety?.serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY,
);
ok(
  "Cached-plan side-panel: safety row engineRiskFlag=true",
  convertedFlaggedSafety?.engineRiskFlag === true,
);

// ---------------------------------------------------------------------------
// 1b. Cached-plan path on an unflagged engine — no chip, no auto-insert.
// ---------------------------------------------------------------------------

const safeRisk = classifyEngineRisk(SAFE_TUNDRA_PROFILE);
ok("Tundra 5.7L profile NOT flagged by classifier", safeRisk.flagged === false);

const safeTriaged = triage({
  oemItems: makeOilOnlyOemItems(),
  carfaxRecords: [],
  shopServiceHistory: [],
  currentMiles: 50_000,
  dviFindings: [],
  vehicleYear: 2019,
  engineRisk: safeRisk,
});
const safeAllItems: TriagedItem[] = [
  ...safeTriaged.overdue,
  ...safeTriaged.dueSoon,
  ...safeTriaged.upcoming,
];
const safeConverted = safeAllItems.map((it) =>
  convertCachedPlanItemForSidePanel(it, undefined, {
    cachedCurrentMiles: 50_000,
    currentRoAuthorizedJobs: [],
    currentRoAllJobs: [],
  }),
);

const convertedSafeOil = safeConverted.find((c) => c.serviceKey === "oil");
ok(
  "Cached-plan side-panel (unflagged): oil row engineRiskFlag is falsy",
  convertedSafeOil != null && !convertedSafeOil.engineRiskFlag,
);
ok(
  "Cached-plan side-panel (unflagged): no Safety Check — Oil Level row",
  !safeConverted.some((c) => c.serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY),
);

// ---------------------------------------------------------------------------
// 2. On-demand path: runOnDemandAnalysis with __deps.getDb swapped to fake-mongo
// ---------------------------------------------------------------------------
//
// This exercises the *other* side panel codepath: when the dashboard
// cache misses, the extension calls `runOnDemandAnalysis` directly. We
// inject the OEM result via `prefetched.oemResult` (so DataOne is never
// touched) and `prefetched.shopWorkOrders=[]` (so the route skips the
// `.sort().limit()` chain that the in-memory fake doesn't support).

console.log("\n[2] On-demand path (runOnDemandAnalysis -> recommendations)");

const runOnDemandFor = async (profile: EngineProfile) => {
  const fake = makeFakeDb({
    engine_risk_overrides: [], // baseline-only classification
    oem_carfax_mappings: [], // empty mapping table is fine
    maintenance_analysis_cache: [], // upsert target
    tekmetric_work_orders: [], // unused (we pass prefetched.shopWorkOrders)
  });
  const originalGetDb = __deps.getDb;
  __deps.getDb = (async () => fake.db) as any;
  try {
    const recs = await runOnDemandAnalysis(
      42, // shopId
      "TESTVIN0000000196",
      50_000, // mileage
      true, // showInspectItems
      {}, // shopIntervals
      [], // carfaxRecords
      {
        oemResult: makeOemResult(profile) as any,
        shopWorkOrders: [],
      } as any,
      [], // dviFindings
      "always", // intervalApplyMode
      [], // currentRoAuthorizedJobs
      [], // currentRoAllJobs
    );
    return { recs, fake };
  } finally {
    __deps.getDb = originalGetDb;
  }
}

const flaggedOnDemand = await runOnDemandFor(PENTASTAR_PROFILE);
const flaggedOnDemandOil = flaggedOnDemand.recs.find((r: any) => r.serviceKey === "oil");
ok(
  "On-demand (Pentastar): oil row present in recommendations",
  flaggedOnDemandOil != null,
);
ok(
  "On-demand (Pentastar): oil row engineRiskFlag === true",
  flaggedOnDemandOil?.engineRiskFlag === true,
);
ok(
  "On-demand (Pentastar): oil row engineRiskReason non-empty",
  typeof flaggedOnDemandOil?.engineRiskReason === "string" &&
    (flaggedOnDemandOil?.engineRiskReason ?? "").length > 0,
);

const flaggedOnDemandSafety = flaggedOnDemand.recs.find(
  (r: any) => r.serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY,
);
ok(
  "On-demand (Pentastar): Safety Check — Oil Level row present",
  flaggedOnDemandSafety != null,
);
ok(
  "On-demand (Pentastar): safety row serviceKey === safety_check_oil_level",
  flaggedOnDemandSafety?.serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY,
);
ok(
  "On-demand (Pentastar): safety row interval === 3000",
  flaggedOnDemandSafety?.interval === SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES,
);
ok(
  "On-demand (Pentastar): safety row title matches SAFETY_CHECK_OIL_LEVEL_TITLE",
  flaggedOnDemandSafety?.service === SAFETY_CHECK_OIL_LEVEL_TITLE,
);
ok(
  "On-demand (Pentastar): safety row engineRiskFlag === true",
  flaggedOnDemandSafety?.engineRiskFlag === true,
);

// And the unflagged engine: no chip, no auto-insert.
const safeOnDemand = await runOnDemandFor(SAFE_TUNDRA_PROFILE);
const safeOnDemandOil = safeOnDemand.recs.find((r: any) => r.serviceKey === "oil");
ok(
  "On-demand (Tundra 5.7L): oil row engineRiskFlag is falsy",
  safeOnDemandOil != null && !safeOnDemandOil.engineRiskFlag,
);
ok(
  "On-demand (Tundra 5.7L): no Safety Check — Oil Level row auto-inserted",
  !safeOnDemand.recs.some((r: any) => r.serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY),
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failed > 0) {
  console.error(`\nTask #196 smoke FAILED (${failed} assertion${failed === 1 ? "" : "s"})`);
  process.exit(1);
}
console.log("\nTask #196 smoke PASSED");

} // end main

main().catch((err) => {
  console.error("Task #196 smoke crashed:", err);
  process.exit(1);
});
