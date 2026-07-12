/**
 * Task #479 regression tests: fake `0` mileage anchors must never survive
 * the analysis-cache → triaged-item conversion.
 *
 * Background: the extension plan route used to serialize `dueMileage: 0`
 * (and `milesToGo: 0`) for month-only OEM rules (brake fluid: 36 months,
 * no mileage interval) and DVI-finding rows. Partner readers converted
 * that to `dueAtMiles: 0`, where legacy mileage math computed
 * "remaining = 0 - currentMiles" and reported the vehicle's entire
 * odometer as overdue miles ("111,961 mi over").
 *
 * Checks:
 * 1. convertRecToTriaged normalizes dueMileage 0 → dueAtMiles null (and
 *    suppresses the sentinel milesToGo).
 * 2. Real positive dueMileage passes through untouched.
 * 3. computeIntervalProgress never produces a miles-axis reading from a
 *    null dueAtMiles (partner render guard stays intact end-to-end).
 *
 * Run: `npx tsx tests/plan-build-task-479.smoke.ts`
 */

import { convertRecToTriaged } from "../lib/vhi-score";
import { computeIntervalProgress } from "../lib/vhi-progress";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Plan-build task #479 smoke checks");

// --- 1. Legacy time-only rec with the 0 sentinel (brake fluid 36 months) ---
console.log("\n1) time-only rec with dueMileage: 0 sentinel");
{
  const triaged = convertRecToTriaged({
    service: "Brake Fluid Exchange",
    serviceKey: "brake_fluid",
    category: "Brakes",
    interval: 0,
    intervalMonths: 36,
    dueMileage: 0,
    milesToGo: 0,
    status: "upcoming",
    source: "oe",
  });
  ok("dueAtMiles normalized to null", triaged.dueAtMiles === null, `got ${triaged.dueAtMiles}`);
  ok("milesToGo suppressed to null", triaged.milesToGo === null, `got ${triaged.milesToGo}`);
}

// --- 2. Legacy DVI rec with the 0 sentinel ---
console.log("\n2) DVI rec with dueMileage: 0 sentinel");
{
  const triaged = convertRecToTriaged({
    service: "Control Arms",
    serviceKey: "control_arm",
    category: "DVI Finding",
    interval: 0,
    intervalMonths: null,
    dueMileage: 0,
    milesToGo: 0,
    status: "overdue",
    source: "dvi",
  });
  ok("DVI dueAtMiles normalized to null", triaged.dueAtMiles === null, `got ${triaged.dueAtMiles}`);
  ok("DVI milesToGo suppressed to null", triaged.milesToGo === null, `got ${triaged.milesToGo}`);
}

// --- 3. Real mileage-based rec passes through unchanged ---
console.log("\n3) real mileage rec passes through");
{
  const triaged = convertRecToTriaged({
    service: "Engine Oil & Filter",
    serviceKey: "engine_oil",
    interval: 5000,
    intervalMonths: 6,
    dueMileage: 115000,
    milesToGo: 3039,
    status: "upcoming",
    source: "oe",
  });
  ok("positive dueAtMiles preserved", triaged.dueAtMiles === 115000, `got ${triaged.dueAtMiles}`);
  ok("positive milesToGo preserved", triaged.milesToGo === 3039, `got ${triaged.milesToGo}`);
}

// --- 4. Missing dueMileage (already-null modern rows) stays null ---
console.log("\n4) null/undefined dueMileage stays null");
{
  const triaged = convertRecToTriaged({
    service: "Cabin Air Filter",
    serviceKey: "cabin_air_filter",
    interval: 0,
    intervalMonths: 24,
    dueMileage: null,
    milesToGo: null,
    status: "upcoming",
    source: "oe",
  });
  ok("null dueMileage → null dueAtMiles", triaged.dueAtMiles === null, `got ${triaged.dueAtMiles}`);
  ok("null milesToGo stays null", triaged.milesToGo === null, `got ${triaged.milesToGo}`);
}

// --- 5. End-to-end: normalized item produces NO miles-axis reading ---
console.log("\n5) computeIntervalProgress miles axis suppressed after normalization");
{
  const currentMiles = 111961; // the real-world "111,961 mi over" repro
  const progress = computeIntervalProgress(
    {
      intervalMiles: null,
      intervalMonths: 36,
      last: { date: "2023-01-15", miles: 85000 },
      dueAtMiles: null, // post-#479 normalized value
      dueAtDate: null,
      milesToGo: null,
    },
    currentMiles,
    undefined,
    "mi"
  );
  const milesText = JSON.stringify(progress ?? {});
  ok(
    "no '111,961' odometer-sized overdue miles in progress payload",
    !milesText.includes("111961") && !milesText.includes("111,961"),
    milesText.slice(0, 200)
  );
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll task #479 checks passed.");
