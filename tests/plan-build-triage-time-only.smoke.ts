/**
 * Task #476 regression: time-only OEM rules (e.g. brake fluid "every 36
 * months", no `intervals: Miles` entry) must NOT compute a "miles over"
 * headline. Before the fix, the live triage path correctly wrote
 * `dueAtMiles = null` for these rows, but renderers + a legacy cached
 * payload branch could fall through to `current - 0` and show
 * "111,961 mi over" anchored to zero.
 *
 * This smoke exercises the engine itself (lib/plan-build/triage.ts) to
 * lock in: when the OEM rule is time-only and shop history has a real
 * non-zero `last.miles`, triage emits `dueAtMiles: null` so the miles
 * axis stays absent and only the time axis fires.
 *
 * Run: `npx tsx tests/plan-build-triage-time-only.smoke.ts`
 */

import { triage, type OEMItem } from "../lib/plan-build/triage";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  \u2713 ${name}`);
  else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Plan-build triage time-only OEM rule smoke checks");

const today = new Date("2026-04-28T00:00:00Z");

// Brake fluid: 36 months, no mileage interval. Mirrors the OEM row that
// produced the bogus "111,961 mi over" in Brandon's screenshot.
const brakeFluidOem: OEMItem = {
  maintenance_id: 99,
  name: "Replace brake fluid",
  category: "Brakes",
  miles: null,
  months: 36,
  intervals: [
    { units: "Months", value: 36 },
    // intentionally no { units: "Miles" } entry
  ],
  notes: null,
};

const buckets = triage({
  oemItems: [brakeFluidOem],
  carfaxRecords: [
    { date: "06/18/2019", odometer: 74209, description: "Brake fluid flushed" },
  ],
  carfaxCategories: [],
  shopServiceHistory: [],
  currentMiles: 111961,
  today,
  dviFindings: [],
  vehicleYear: 2014,
});

const allRows = [
  ...buckets.overdue,
  ...buckets.dueSoon,
  ...buckets.upcoming,
];
const brake = allRows.find(
  (r) => /brake/i.test(r.title) || r.serviceKey === "brake_fluid",
);

ok("brake-fluid row present in some bucket", !!brake, JSON.stringify(brake));
if (brake) {
  // The headline assertion: dueAtMiles MUST stay null on a time-only
  // OEM rule. Anything else (0 or a finite number) lets downstream
  // renderers compute `current - dueAtMiles` and emit "X mi over".
  ok(
    "time-only OEM: dueAtMiles is null (no miles axis)",
    brake.dueAtMiles == null,
    `got ${brake.dueAtMiles}`,
  );
  ok(
    "time-only OEM: milesToGo is null",
    brake.milesToGo == null,
    `got ${brake.milesToGo}`,
  );
  // Time axis should still fire — 36 months from 06/18/2019 = 06/18/2022,
  // which is well before today (2026-04-28), so the row is overdue
  // on the date axis.
  ok(
    "time-only OEM: dueAtDate is populated",
    brake.dueAtDate != null,
  );
  ok(
    "time-only OEM: last.miles preserved as anchor for display",
    brake.last?.miles === 74209,
    `got ${brake.last?.miles}`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} task #476 triage check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll task #476 triage checks passed");
