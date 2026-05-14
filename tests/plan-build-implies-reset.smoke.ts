/**
 * Smoke test for the implies-reset anchor fallback inside `triage()`.
 *
 * Run: `npx tsx tests/plan-build-implies-reset.smoke.ts`
 *
 * Why: Task #434 introduces a hand-curated `IMPLIES_RESET` map that says
 * "Four tires replaced" implicitly resets the tire-rotation cycle even
 * when CARFAX has no explicit rotation record. The triage layer must:
 *
 *   1. Use the implied parent anchor when no direct child record exists,
 *      stamping `lastSource = "implied"` and surfacing the parent's
 *      customer-facing display name.
 *   2. Prefer a direct child record over the implied fallback whenever
 *      both are present (direct beats implied — the map is fallback only).
 *   3. Borrow miles from a per-record CARFAX line for the same parent
 *      when the rollup row's odometer is null (preserves the task #431
 *      odometer-borrow rule across the implied path).
 *   4. Leave items with no parent and no direct record alone (no false
 *      positives — the existing "never done" path still fires).
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

console.log("Plan-build implies-reset smoke checks");

const today = new Date("2026-05-14T00:00:00Z");

const tireRotationOem: OEMItem = {
  maintenance_id: 42,
  name: "Rotate tires",
  category: "Tires",
  miles: 5000,
  months: 6,
  intervals: [
    { units: "Miles", value: 5000 },
    { units: "Months", value: 6 },
  ],
  notes: null,
};

// ------------------------------------------------------------------
// Scenario A (the Lexus RX350 case from the task spec): CARFAX shows
// "Four tires replaced" at 188,908 mi but NO direct rotation record.
// Implied fallback should anchor the rotation row at 188,908 mi so it
// reads "Due at 193,908 mi · 4,536 mi to go" instead of the legacy
// "anchored at 0" disaster.
// ------------------------------------------------------------------
{
  const buckets = triage({
    oemItems: [tireRotationOem],
    carfaxRecords: [
      { date: "04/22/2026", odometer: 188908, description: "Four tires replaced" },
    ],
    shopServiceHistory: [],
    currentMiles: 189372,
    today,
    dviFindings: [],
    vehicleYear: 2018,
  });

  const rot = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming]
    .find((t) => t.serviceKey === "tire_rotation");

  ok("Scenario A: tire-rotation row is present", rot != null);
  ok(
    "Scenario A: lastSource is 'implied' (no direct rotation record)",
    rot?.lastSource === "implied",
    `lastSource=${rot?.lastSource}`,
  );
  ok(
    "Scenario A: implied parent name surfaces for the panel label",
    rot?.last?.impliedFromParentName === "tire replacement",
    `impliedFromParentName=${rot?.last?.impliedFromParentName}`,
  );
  ok(
    "Scenario A: anchor mileage came from the parent record (188,908)",
    rot?.last?.miles === 188908,
    `last.miles=${rot?.last?.miles}`,
  );
  ok(
    "Scenario A: dueAtMiles = 188908 + 5000 = 193908",
    rot?.dueAtMiles === 193908,
    `dueAtMiles=${rot?.dueAtMiles}`,
  );
}

// ------------------------------------------------------------------
// Scenario B: both an explicit "tires rotated" record and "Four tires
// replaced" are present. Direct child record must win — the implied
// fallback exists strictly for the no-direct-record case.
// ------------------------------------------------------------------
{
  const buckets = triage({
    oemItems: [tireRotationOem],
    carfaxRecords: [
      { date: "04/22/2026", odometer: 188908, description: "Four tires replaced" },
      // Explicit rotation record AFTER the tire replacement — direct wins.
      { date: "05/01/2026", odometer: 189100, description: "Tires rotated" },
    ],
    shopServiceHistory: [],
    currentMiles: 189372,
    today,
    dviFindings: [],
    vehicleYear: 2018,
  });

  const rot = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming]
    .find((t) => t.serviceKey === "tire_rotation");

  ok("Scenario B: tire-rotation row is present", rot != null);
  ok(
    "Scenario B: lastSource is 'direct' (explicit rotation record beats implied)",
    rot?.lastSource === "direct",
    `lastSource=${rot?.lastSource}`,
  );
  ok(
    "Scenario B: no implied-parent label leaks onto a direct anchor",
    !rot?.last?.impliedFromParentName,
    `impliedFromParentName=${rot?.last?.impliedFromParentName}`,
  );
  ok(
    "Scenario B: anchor mileage is the direct rotation record (189,100)",
    rot?.last?.miles === 189100,
    `last.miles=${rot?.last?.miles}`,
  );
}

// ------------------------------------------------------------------
// Scenario C: implied parent rollup row carries a date but a NULL
// odometer (the post-#431 trap). The triage layer must borrow miles
// from a matching per-record CARFAX line for the same parent so the
// rotation row is not silently anchored at zero.
// ------------------------------------------------------------------
{
  const buckets = triage({
    oemItems: [tireRotationOem],
    carfaxRecords: [
      // Per-record line: has the miles we need to borrow.
      { date: "04/22/2026", odometer: 188908, description: "Four tires replaced" },
    ],
    // Rollup row carries the same date but no odometer — must borrow.
    carfaxCategories: [
      { serviceName: "Tires replaced", date: "04/22/2026", odometer: null },
    ],
    shopServiceHistory: [],
    currentMiles: 189372,
    today,
    dviFindings: [],
    vehicleYear: 2018,
  });

  const rot = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming]
    .find((t) => t.serviceKey === "tire_rotation");

  ok("Scenario C: tire-rotation row is present", rot != null);
  ok(
    "Scenario C: lastSource is 'implied'",
    rot?.lastSource === "implied",
    `lastSource=${rot?.lastSource}`,
  );
  ok(
    "Scenario C: borrowed miles from the matching per-record parent line (188,908)",
    rot?.last?.miles === 188908,
    `last.miles=${rot?.last?.miles}`,
  );
  ok(
    "Scenario C: dueAtMiles uses the borrowed anchor (193,908) — NOT zero",
    rot?.dueAtMiles === 193908,
    `dueAtMiles=${rot?.dueAtMiles}`,
  );
}

// ------------------------------------------------------------------
// Scenario D: no parent record, no direct record. The implied map must
// not invent a fictional anchor — the row should fall through to the
// existing "never done" path (anchored at the interval, not at the
// parent that doesn't exist).
// ------------------------------------------------------------------
{
  const buckets = triage({
    oemItems: [tireRotationOem],
    carfaxRecords: [
      // Unrelated record — neither direct child nor implied parent.
      { date: "03/01/2026", odometer: 180000, description: "Engine oil and filter change" },
    ],
    shopServiceHistory: [],
    currentMiles: 189372,
    today,
    dviFindings: [],
    vehicleYear: 2018,
  });

  const rot = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming]
    .find((t) => t.serviceKey === "tire_rotation");

  ok("Scenario D: tire-rotation row is present", rot != null);
  ok(
    "Scenario D: lastSource is null when neither direct nor implied applies",
    rot?.lastSource == null,
    `lastSource=${rot?.lastSource}`,
  );
  ok(
    "Scenario D: never-done path fires (no anchor borrowed from unrelated parent)",
    rot?.last == null || rot?.last?.miles == null,
    `last=${JSON.stringify(rot?.last)}`,
  );
}

if (failed === 0) {
  console.log("\nAll plan-build implies-reset smoke checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} plan-build implies-reset smoke check(s) failed.`);
  process.exit(1);
}
