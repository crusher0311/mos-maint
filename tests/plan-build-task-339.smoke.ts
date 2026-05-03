/**
 * Regression smoke test for Task #339 (km display for Canadian shops).
 *
 * Run: `npx tsx tests/plan-build-task-339.smoke.ts`
 *
 * Tasks #333 and #336 wired the shop's preferred distance unit through
 * both the dashboard plan path (`lib/plan-build/triage.ts`) and the
 * extension on-demand analyzer (`runOnDemandAnalysis` in
 * `app/api/extension/plan/route.ts`). OEM intervals from DataOne are
 * always real miles; for a Canadian (kilometers) shop they must be
 * converted at intake so anchors against the shop-unit odometer + last
 * performed mileage produce correct dueAt + milesToGo, and so the user
 * sees "5,000 km" / "8,047 km" in interval text and reason strings
 * instead of raw miles.
 *
 * Without this test, a future refactor of `triage()` or
 * `runOnDemandAnalysis` could silently regress to showing miles for
 * Canadian shops again. We exercise BOTH paths against a flagged-engine
 * profile (Pentastar 3.6L) so we also lock in the engine-risk
 * safety-check row carrying km in its reason string.
 *
 * The test runs each path twice — once with `distanceUnit: "kilometers"`
 * and once with `"miles"` — so a regression on either side fails the
 * build.
 */

import { triage, type OEMItem, type TriagedItem } from "../lib/plan-build/triage";
import {
  classifyEngineRisk,
  SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES,
  SAFETY_CHECK_OIL_LEVEL_KEY,
  type EngineProfile,
} from "../lib/engine-risk";
import { makeFakeDb } from "./utils/fake-mongo";

type RouteModule = typeof import("../app/api/extension/plan/route");

const MILES_TO_KM = 1.60934;
const OEM_OIL_MILES = 5_000;
const OEM_OIL_KM = Math.round(OEM_OIL_MILES * MILES_TO_KM); // 8,047
const SAFETY_KM = Math.round(SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES * MILES_TO_KM); // 4,828

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

// Stub `server-only` (transitively imported by the route via carfax)
// before importing the route module so it can resolve in a Node test.
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

console.log("Task #339 regression checks (km display for Canadian shops)");

// Sanity: the conversion constant matches what both modules use, so a
// future tweak to MILES_TO_KM in either file shows up here loudly
// instead of as a silent off-by-rounding regression.
ok(
  "OEM 5,000 mi converts to 8,047 km",
  OEM_OIL_KM === 8_047,
  `got ${OEM_OIL_KM}`,
);
ok(
  "Safety-check 3,000 mi converts to 4,828 km",
  SAFETY_KM === 4_828,
  `got ${SAFETY_KM}`,
);

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

// 5,000 mi oil interval — small enough that, post-conversion, both the
// US (5,000) and Canadian (8,047) values are visibly distinct. Kept
// below the engine-risk oil-row threshold (7,500 mi) on purpose so the
// chip doesn't fire on the oil row itself; we're locking in the
// safety-check row reason string here, which fires whenever the
// engine is flagged regardless of OEM oil interval.
function makeOilOnlyOemItems(): OEMItem[] {
  return [
    {
      maintenance_id: 1,
      name: "Engine oil & filter — Replace",
      category: "Engine",
      miles: OEM_OIL_MILES,
      months: 12,
      notes: null,
      intervals: [],
      intervalMilesNormal: OEM_OIL_MILES,
      intervalMonthsNormal: 12,
      intervalMilesSevere: OEM_OIL_MILES,
      intervalMonthsSevere: 12,
    },
  ];
}

function makeOemResult(profile: EngineProfile) {
  return {
    ok: true,
    vin: "TESTVIN0000000339",
    squish: "TESTVIN0019",
    count: 1,
    source: "cache" as const,
    items: [
      {
        maintenance_id: 1,
        maintenance_category: "Engine",
        maintenance_name: "Engine oil & filter — Replace",
        maintenance_notes: null,
        intervals: [],
        miles: OEM_OIL_MILES,
        months: 12,
        intervalMilesNormal: OEM_OIL_MILES,
        intervalMonthsNormal: 12,
        intervalMilesSevere: OEM_OIL_MILES,
        intervalMonthsSevere: 12,
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

const flaggedRisk = classifyEngineRisk(PENTASTAR_PROFILE);
ok("Pentastar profile flagged by classifier", flaggedRisk.flagged === true);

// ---------------------------------------------------------------------------
// 1. Cached-plan path (triage -> convertCachedPlanItemForSidePanel)
// ---------------------------------------------------------------------------

function runCached(distanceUnit: "miles" | "kilometers") {
  const triaged = triage({
    oemItems: makeOilOnlyOemItems(),
    carfaxRecords: [],
    shopServiceHistory: [],
    currentMiles: 50_000,
    dviFindings: [],
    vehicleYear: 2019,
    engineRisk: flaggedRisk,
    distanceUnit,
  });
  const all: TriagedItem[] = [...triaged.overdue, ...triaged.dueSoon, ...triaged.upcoming];
  const converted = all.map((it) =>
    convertCachedPlanItemForSidePanel(it, undefined, {
      cachedCurrentMiles: 50_000,
      currentRoAuthorizedJobs: [],
      currentRoAllJobs: [],
      distanceUnit,
    }),
  );
  return { all, converted };
}

console.log("\n[1a] Cached-plan path, distanceUnit=kilometers");
const cachedKm = runCached("kilometers");
const cachedKmOilTri = cachedKm.all.find((it) => it.serviceKey === "oil");
ok(
  "triage(km): oil row intervalMiles converted to km (8,047)",
  cachedKmOilTri?.intervalMiles === OEM_OIL_KM,
  `got ${cachedKmOilTri?.intervalMiles}`,
);

const cachedKmOilConv = cachedKm.converted.find((c) => c.serviceKey === "oil");
ok(
  "convertCachedPlanItemForSidePanel(km): oil row interval === 8,047",
  cachedKmOilConv?.interval === OEM_OIL_KM,
);
ok(
  "convertCachedPlanItemForSidePanel(km): oil row intervalText reads 'km'",
  typeof cachedKmOilConv?.intervalText === "string" &&
    cachedKmOilConv.intervalText.includes(" km") &&
    cachedKmOilConv.intervalText.includes(OEM_OIL_KM.toLocaleString()),
  `got ${JSON.stringify(cachedKmOilConv?.intervalText)}`,
);

const cachedKmSafetyTri = cachedKm.all.find((it) => it.serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY);
ok(
  "triage(km): Safety Check — Oil Level row auto-inserted",
  cachedKmSafetyTri != null,
);
ok(
  "triage(km): safety row intervalMiles converted (4,828 km)",
  cachedKmSafetyTri?.intervalMiles === SAFETY_KM,
  `got ${cachedKmSafetyTri?.intervalMiles}`,
);
ok(
  "triage(km): safety row recommendedReason mentions 'km'",
  typeof cachedKmSafetyTri?.recommendedReason === "string" &&
    cachedKmSafetyTri.recommendedReason.includes(" km") &&
    cachedKmSafetyTri.recommendedReason.includes(SAFETY_KM.toLocaleString()),
  `got ${JSON.stringify(cachedKmSafetyTri?.recommendedReason)}`,
);

console.log("\n[1b] Cached-plan path, distanceUnit=miles (regression guard)");
const cachedMi = runCached("miles");
const cachedMiOilTri = cachedMi.all.find((it) => it.serviceKey === "oil");
ok(
  "triage(mi): oil row intervalMiles unchanged (5,000)",
  cachedMiOilTri?.intervalMiles === OEM_OIL_MILES,
  `got ${cachedMiOilTri?.intervalMiles}`,
);
const cachedMiOilConv = cachedMi.converted.find((c) => c.serviceKey === "oil");
ok(
  "convertCachedPlanItemForSidePanel(mi): oil row interval === 5,000",
  cachedMiOilConv?.interval === OEM_OIL_MILES,
);
ok(
  "convertCachedPlanItemForSidePanel(mi): oil row intervalText reads 'mi' (not 'km')",
  typeof cachedMiOilConv?.intervalText === "string" &&
    cachedMiOilConv.intervalText.includes(" mi") &&
    !cachedMiOilConv.intervalText.includes(" km") &&
    cachedMiOilConv.intervalText.includes(OEM_OIL_MILES.toLocaleString()),
  `got ${JSON.stringify(cachedMiOilConv?.intervalText)}`,
);
const cachedMiSafetyTri = cachedMi.all.find((it) => it.serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY);
ok(
  "triage(mi): safety row intervalMiles unchanged (3,000)",
  cachedMiSafetyTri?.intervalMiles === SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES,
  `got ${cachedMiSafetyTri?.intervalMiles}`,
);
ok(
  "triage(mi): safety row recommendedReason mentions 'mi' (not 'km')",
  typeof cachedMiSafetyTri?.recommendedReason === "string" &&
    cachedMiSafetyTri.recommendedReason.includes(" mi") &&
    !cachedMiSafetyTri.recommendedReason.includes(" km"),
  `got ${JSON.stringify(cachedMiSafetyTri?.recommendedReason)}`,
);

// ---------------------------------------------------------------------------
// 2. On-demand path (runOnDemandAnalysis with __deps.getDb swapped)
// ---------------------------------------------------------------------------

const runOnDemandFor = async (distanceUnit: "miles" | "kilometers") => {
  const fake = makeFakeDb({
    engine_risk_overrides: [],
    oem_carfax_mappings: [],
    maintenance_analysis_cache: [],
    tekmetric_work_orders: [],
  });
  const originalGetDb = __deps.getDb;
  __deps.getDb = (async () => fake.db) as any;
  try {
    const recs = await runOnDemandAnalysis(
      42,
      "TESTVIN0000000339",
      50_000,
      true,
      {},
      [],
      {
        oemResult: makeOemResult(PENTASTAR_PROFILE) as any,
        shopWorkOrders: [],
      } as any,
      [],
      "always",
      [],
      [],
      distanceUnit,
    );
    return recs;
  } finally {
    __deps.getDb = originalGetDb;
  }
};

console.log("\n[2a] On-demand path, distanceUnit=kilometers");
const onDemandKm = await runOnDemandFor("kilometers");
const onDemandKmOil = onDemandKm.find((r: any) => r.serviceKey === "oil");
ok(
  "runOnDemandAnalysis(km): oil row interval === 8,047",
  onDemandKmOil?.interval === OEM_OIL_KM,
  `got ${onDemandKmOil?.interval}`,
);
ok(
  "runOnDemandAnalysis(km): oil row intervalText reads 'km'",
  typeof onDemandKmOil?.intervalText === "string" &&
    onDemandKmOil.intervalText.includes(" km") &&
    onDemandKmOil.intervalText.includes(OEM_OIL_KM.toLocaleString()),
  `got ${JSON.stringify(onDemandKmOil?.intervalText)}`,
);

const onDemandKmSafety = onDemandKm.find((r: any) => r.serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY);
ok(
  "runOnDemandAnalysis(km): Safety Check — Oil Level row present",
  onDemandKmSafety != null,
);
ok(
  "runOnDemandAnalysis(km): safety row interval === 4,828",
  onDemandKmSafety?.interval === SAFETY_KM,
  `got ${onDemandKmSafety?.interval}`,
);
ok(
  "runOnDemandAnalysis(km): safety row intervalText reads 'km'",
  typeof onDemandKmSafety?.intervalText === "string" &&
    onDemandKmSafety.intervalText.includes(" km") &&
    onDemandKmSafety.intervalText.includes(SAFETY_KM.toLocaleString()),
  `got ${JSON.stringify(onDemandKmSafety?.intervalText)}`,
);
ok(
  "runOnDemandAnalysis(km): safety row engineRiskReason mentions 'km'",
  typeof onDemandKmSafety?.engineRiskReason === "string" &&
    onDemandKmSafety.engineRiskReason.includes(" km") &&
    onDemandKmSafety.engineRiskReason.includes(SAFETY_KM.toLocaleString()),
  `got ${JSON.stringify(onDemandKmSafety?.engineRiskReason)}`,
);

console.log("\n[2b] On-demand path, distanceUnit=miles (regression guard)");
const onDemandMi = await runOnDemandFor("miles");
const onDemandMiOil = onDemandMi.find((r: any) => r.serviceKey === "oil");
ok(
  "runOnDemandAnalysis(mi): oil row interval unchanged (5,000)",
  onDemandMiOil?.interval === OEM_OIL_MILES,
  `got ${onDemandMiOil?.interval}`,
);
ok(
  "runOnDemandAnalysis(mi): oil row intervalText reads 'mi' (not 'km')",
  typeof onDemandMiOil?.intervalText === "string" &&
    onDemandMiOil.intervalText.includes(" mi") &&
    !onDemandMiOil.intervalText.includes(" km") &&
    onDemandMiOil.intervalText.includes(OEM_OIL_MILES.toLocaleString()),
  `got ${JSON.stringify(onDemandMiOil?.intervalText)}`,
);

const onDemandMiSafety = onDemandMi.find((r: any) => r.serviceKey === SAFETY_CHECK_OIL_LEVEL_KEY);
ok(
  "runOnDemandAnalysis(mi): safety row interval unchanged (3,000)",
  onDemandMiSafety?.interval === SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES,
  `got ${onDemandMiSafety?.interval}`,
);
ok(
  "runOnDemandAnalysis(mi): safety row engineRiskReason mentions 'mi' (not 'km')",
  typeof onDemandMiSafety?.engineRiskReason === "string" &&
    onDemandMiSafety.engineRiskReason.includes(" mi") &&
    !onDemandMiSafety.engineRiskReason.includes(" km"),
  `got ${JSON.stringify(onDemandMiSafety?.engineRiskReason)}`,
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failed > 0) {
  console.error(`\nTask #339 smoke FAILED (${failed} assertion${failed === 1 ? "" : "s"})`);
  process.exit(1);
}
console.log("\nTask #339 smoke PASSED");

}

main().catch((err) => {
  console.error("Task #339 smoke crashed:", err);
  process.exit(1);
});
