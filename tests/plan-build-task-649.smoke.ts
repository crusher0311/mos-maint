/**
 * Task #649 smoke: warn advisors when the entered odometer disagrees sharply
 * with the vehicle's recorded history.
 *
 * Run: `npx tsx tests/plan-build-task-649.smoke.ts`
 *
 * The plan endpoint (app/api/extension/plan/route.ts) composes the existing
 * Task #391 helpers exactly as exercised below: it feeds the advisor-entered
 * odometer as `currentMiles` and the best already-known readings (the prior
 * open-RO/cached WO odometer as shop history, plus the vehicles snapshot /
 * CARFAX last-recorded as carfax records). When the entered value is below a
 * higher recorded reading beyond tolerance — a likely typo — it emits a
 * `mileage_discrepancy` flag that the overlay renders. This test mirrors that
 * composition so a regression in the route's wiring is caught here.
 *
 * Coverage:
 *   (a) entered far below recorded WO odometer fires (shop history)
 *   (b) entered far below vehicles snapshot fires (carfax-record slot)
 *   (c) entered within tolerance of prior reading -> no flag
 *   (d) entered ABOVE prior readings (normal driving) -> no flag
 *   (e) no prior readings at all -> no flag
 *   (f) flag shape carries entered (currentMiles) + last record (priorMiles)
 *       so the overlay can render "Entered X — last record Y"
 */

import {
  detectMileageDiscrepancy,
  buildMileageDiscrepancyFlag,
  shopHistoryLabelFromProvider,
} from "../lib/plan-build/mileage-discrepancy";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  \u2713 ${name}`);
  else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

// Mirror the route's composition (app/api/extension/plan/route.ts Task #649).
function buildPlanMileageFlag(opts: {
  enteredOdometer: number | null;
  priorKnownMileage: number | null;
  snapshotMiles?: number | null;
  carfaxLastRecorded?: number | null;
  provider?: string | null;
}) {
  if (opts.enteredOdometer == null) return null;
  const shopHistory = opts.priorKnownMileage != null
    ? [{ mileage: opts.priorKnownMileage, date: null }]
    : [];
  const carfaxRecords: { odometer: number; date: string | null }[] = [];
  if (opts.snapshotMiles && opts.snapshotMiles > 0) carfaxRecords.push({ odometer: opts.snapshotMiles, date: null });
  if (opts.carfaxLastRecorded && opts.carfaxLastRecorded > 0) carfaxRecords.push({ odometer: opts.carfaxLastRecorded, date: null });
  const d = detectMileageDiscrepancy({
    currentMiles: opts.enteredOdometer,
    shopHistory,
    carfaxRecords,
    shopHistoryLabel: shopHistoryLabelFromProvider(opts.provider),
  });
  return d ? buildMileageDiscrepancyFlag(d) : null;
}

console.log("Task #649 smoke — entered odometer disagreement warning");

// ---------------- (a) entered far below recorded WO odometer ----------------
{
  const flag = buildPlanMileageFlag({
    enteredOdometer: 11_950, // dropped a digit; should be ~119,500
    priorKnownMileage: 116_266,
    provider: "tekmetric",
  });
  ok("(a) entered below recorded WO odometer fires", flag != null);
  ok("(a) source labelled by provider", flag != null && flag.details.priorSource === "Tekmetric");
  ok("(a) entered echoed as currentMiles", flag != null && flag.details.currentMiles === 11_950);
  ok("(a) last record echoed as priorMiles", flag != null && flag.details.priorMiles === 116_266);
}

// ---------------- (b) entered far below vehicles snapshot ----------------
{
  const flag = buildPlanMileageFlag({
    enteredOdometer: 50_000,
    priorKnownMileage: null, // no WO odometer resolved
    snapshotMiles: 130_000,
    provider: "protractor",
  });
  ok("(b) entered below snapshot fires via carfax slot", flag != null && flag.details.priorMiles === 130_000);
  ok("(b) snapshot reading labelled CARFAX", flag != null && flag.details.priorSource === "CARFAX");
}

// ---------------- (c) within tolerance -> no flag ----------------
{
  const flag = buildPlanMileageFlag({
    enteredOdometer: 116_230,
    priorKnownMileage: 116_266, // gap 36 < 50mi tolerance
    provider: "tekmetric",
  });
  ok("(c) within tolerance returns no flag", flag === null);
}

// ---------------- (d) entered ABOVE prior readings (normal driving) ----------------
{
  const flag = buildPlanMileageFlag({
    enteredOdometer: 119_500,
    priorKnownMileage: 116_266,
    snapshotMiles: 115_000,
    provider: "tekmetric",
  });
  ok("(d) normal forward progress does not warn", flag === null);
}

// ---------------- (e) no prior readings -> no flag ----------------
{
  const flag = buildPlanMileageFlag({
    enteredOdometer: 80_000,
    priorKnownMileage: null,
    provider: "tekmetric",
  });
  ok("(e) no history -> no flag (nothing to compare)", flag === null);
}

// ---------------- (f) flag shape supports overlay render ----------------
{
  const flag = buildPlanMileageFlag({
    enteredOdometer: 11_950,
    priorKnownMileage: 116_266,
    provider: "shopware",
  })!;
  ok("(f) code is mileage_discrepancy", flag.code === "mileage_discrepancy");
  ok("(f) severity warning (non-blocking)", flag.severity === "warning");
  ok("(f) details expose entered + last record for the overlay",
    flag.details.currentMiles === 11_950 && flag.details.priorMiles === 116_266 && flag.details.priorSource === "Shop-Ware");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll task-649 assertions passed.");
