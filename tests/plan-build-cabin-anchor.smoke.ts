/**
 * Task #431 regression: the cabin-air-filter "anchor mileage" was being
 * dropped because the CARFAX `serviceCategories` rollup overwrote the
 * per-record CARFAX entry whenever its date was equal-or-newer, even if
 * `odometerOfLastService` was null. With `last.miles` lost,
 * `computeAnchorMiles` fell back to "interval only" and the planner
 * reported the cabin air filter as "Due at 12,000 mi · 38,000 mi over"
 * instead of "Due at 33,578 mi".
 *
 * Run: `npx tsx tests/plan-build-cabin-anchor.smoke.ts`
 */

import { triage, type OEMItem } from "../lib/plan-build/triage";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Plan-build cabin-air anchor smoke checks");

const today = new Date("2026-04-28T00:00:00Z");

const cabinOemItem: OEMItem = {
  maintenance_id: 42,
  name: "Replace cabin air filter",
  category: "HVAC",
  miles: 12000,
  months: 12,
  intervals: [
    { units: "Miles", value: 12000 },
    { units: "Months", value: 12 },
  ],
  notes: null,
};

// ------------------------------------------------------------------
// Scenario A: per-record has miles + date, rollup has same date but
// `odometerOfLastService = null`. The rollup must NOT wipe the miles.
// ------------------------------------------------------------------
{
  const buckets = triage({
    oemItems: [cabinOemItem],
    carfaxRecords: [
      { date: "06/18/2024", odometer: 21578, description: "Cabin air filter replaced/cleaned" },
    ],
    carfaxCategories: [
      { serviceName: "Cabin air filter", date: "06/18/2024", odometer: null },
    ],
    shopServiceHistory: [],
    currentMiles: 50000,
    today,
    dviFindings: [],
    vehicleYear: 2018,
  });

  const cabin = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming]
    .find((t) => t.serviceKey === "cabin_air");

  ok("Scenario A: cabin air row is present", cabin != null);
  ok(
    "Scenario A: last.miles survives the rollup merge (21578)",
    cabin?.last?.miles === 21578,
    `last=${JSON.stringify(cabin?.last)}`,
  );
  ok(
    "Scenario A: dueAtMiles = 21578 + 12000 = 33578",
    cabin?.dueAtMiles === 33578,
    `dueAtMiles=${cabin?.dueAtMiles}`,
  );
  ok(
    "Scenario A: overdue distance is computed off the 33,578 anchor (~16,422 mi over)",
    cabin?.milesToGo === 33578 - 50000,
    `milesToGo=${cabin?.milesToGo}`,
  );
  ok(
    "Scenario A: cabin air lands in overdue (50k > 33,578)",
    buckets.overdue.some((t) => t.serviceKey === "cabin_air"),
  );
}

// ------------------------------------------------------------------
// Scenario B: rollup-only (no per-record line) but rollup ships its own
// odometer. Must continue to anchor against the rollup miles so we don't
// regress shops where CARFAX only surfaces serviceCategories.
// ------------------------------------------------------------------
{
  const buckets = triage({
    oemItems: [cabinOemItem],
    carfaxRecords: [],
    carfaxCategories: [
      { serviceName: "Cabin air filter", date: "06/18/2024", odometer: 21578 },
    ],
    shopServiceHistory: [],
    currentMiles: 50000,
    today,
    dviFindings: [],
    vehicleYear: 2018,
  });

  const cabin = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming]
    .find((t) => t.serviceKey === "cabin_air");

  ok("Scenario B: cabin air row is present", cabin != null);
  ok(
    "Scenario B: rollup-only miles still anchor (21578)",
    cabin?.last?.miles === 21578,
    `last=${JSON.stringify(cabin?.last)}`,
  );
  ok(
    "Scenario B: dueAtMiles = 33578",
    cabin?.dueAtMiles === 33578,
    `dueAtMiles=${cabin?.dueAtMiles}`,
  );
}

// ------------------------------------------------------------------
// Scenario C: rollup carries a STRICTLY newer date than the per-record
// line and its own miles is null. The newer date should be adopted (so
// time-axis math is correct) but the per-record's `miles` must be kept.
// ------------------------------------------------------------------
{
  const buckets = triage({
    oemItems: [cabinOemItem],
    carfaxRecords: [
      { date: "06/18/2024", odometer: 21578, description: "Cabin air filter replaced/cleaned" },
    ],
    carfaxCategories: [
      // Newer date than the per-record but no odometer — historically wiped
      // the mileage.
      { serviceName: "Cabin air filter", date: "07/01/2024", odometer: null },
    ],
    shopServiceHistory: [],
    currentMiles: 50000,
    today,
    dviFindings: [],
    vehicleYear: 2018,
  });

  const cabin = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming]
    .find((t) => t.serviceKey === "cabin_air");

  ok("Scenario C: cabin air row is present", cabin != null);
  ok(
    "Scenario C: per-record miles preserved across newer null-miles rollup",
    cabin?.last?.miles === 21578,
    `last=${JSON.stringify(cabin?.last)}`,
  );
  ok(
    "Scenario C: dueAtMiles still uses the 21578 anchor",
    cabin?.dueAtMiles === 33578,
    `dueAtMiles=${cabin?.dueAtMiles}`,
  );
}

if (failed === 0) {
  console.log("\nAll plan-build cabin-air anchor smoke checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} plan-build cabin-air anchor smoke check(s) failed.`);
  process.exit(1);
}
