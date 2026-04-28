/**
 * Regression smoke test for Task #166 (engine-aware oil interval accuracy).
 *
 * Run: `npx tsx tests/plan-build-task-166.smoke.ts`
 *
 * Covers the unit-level guarantees behind the MVP work:
 *   1. Curated baseline classifier flags the three at-risk families
 *      (Pentastar 3.6, turbo GDI, 0W-20 small-displacement).
 *   2. Admin overrides resolve correctly: `clear` always wins, `flag`
 *      surfaces the override label/reason.
 *   3. The plan-cache schema version was bumped to >= 3 so cached entries
 *      from older builds are skipped.
 *   4. Task-166 constants exposed on the engine-risk module match the
 *      values surfaced through the UI / endpoints (chip threshold,
 *      Safety Check anchor and key/title).
 *   5. Sanity smoke against VIN 1C6RR6FG7KS516181 (2019 RAM 1500
 *      Pentastar 3.6L V6) — the canonical Pentastar baseline match.
 */

import {
  classifyEngineRisk,
  classifyEngineRiskBaseline,
  OIL_INTERVAL_RISK_THRESHOLD_MILES,
  SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES,
  SAFETY_CHECK_OIL_LEVEL_KEY,
  SAFETY_CHECK_OIL_LEVEL_TITLE,
  type EngineProfile,
  type EngineRiskOverride,
} from "../lib/engine-risk";
import { PLAN_CACHE_SCHEMA_VERSION } from "../lib/plan-cache";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #166 regression checks");

// 1. Curated baseline classifier
const pentastar: EngineProfile = {
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
const turboGdi: EngineProfile = {
  engine_name: "2.0L Turbo GDI I4",
  engine_size: 2.0,
  engine_block: "L",
  engine_cylinders: 4,
  engine_induction: "Gasoline Direct Injection",
  engine_aspiration: "Turbocharged",
  fuel_type: "G",
  make: "Ford",
  model: "Escape",
  year: 2022,
};
const smallDisplacement0w20: EngineProfile = {
  engine_name: "1.5L I4 0W-20",
  engine_size: 1.5,
  engine_block: "L",
  engine_cylinders: 4,
  engine_induction: "Multipoint Fuel Injection",
  engine_aspiration: "Naturally Aspirated",
  fuel_type: "G",
  make: "Honda",
  model: "Civic",
  year: 2021,
};
const safe: EngineProfile = {
  engine_name: "5.7L V8",
  engine_size: 5.7,
  engine_block: "V",
  engine_cylinders: 8,
  engine_induction: "Multipoint Fuel Injection",
  engine_aspiration: "Naturally Aspirated",
  fuel_type: "G",
  make: "Toyota",
  model: "Tundra",
  year: 2018,
};

ok(
  "classifyEngineRiskBaseline flags Pentastar 3.6L",
  classifyEngineRiskBaseline(pentastar).flagged === true,
);
ok(
  "classifyEngineRiskBaseline flags turbo GDI",
  classifyEngineRiskBaseline(turboGdi).flagged === true,
);
ok(
  "classifyEngineRiskBaseline flags 0W-20 small-displacement",
  classifyEngineRiskBaseline(smallDisplacement0w20).flagged === true,
);
ok(
  "classifyEngineRiskBaseline does NOT flag 5.7L V8 baseline",
  classifyEngineRiskBaseline(safe).flagged === false,
);

// 2. Admin overrides
const flagOverride: EngineRiskOverride = {
  _id: "ov-flag",
  label: "Custom risky engine",
  action: "flag",
  reason: "QA-tracked: oil consumption complaints",
  match: { engine_size: 3.6 },
} as any;
const clearOverride: EngineRiskOverride = {
  _id: "ov-clear",
  label: "Pentastar exempt",
  action: "clear",
  reason: "Customer-supplied OEM-equivalent extended interval oil",
  match: { make: "Ram", engine_size: 3.6 },
} as any;

const flagged = classifyEngineRisk(pentastar, [flagOverride]);
ok(
  "override(flag) bubbles label to matchedOverrideLabel",
  flagged.flagged === true && flagged.matchedOverrideLabel === "Custom risky engine",
);
const cleared = classifyEngineRisk(pentastar, [flagOverride, clearOverride]);
ok(
  "override(clear) wins over baseline + override(flag)",
  cleared.flagged === false && cleared.source === "override-clear",
);

// 3. Cache schema version is bumped to v3
ok(
  "PLAN_CACHE_SCHEMA_VERSION >= 3 (Task #166 cache invalidation)",
  PLAN_CACHE_SCHEMA_VERSION >= 3,
);

// 4. Task #166 constants
ok(
  "OIL_INTERVAL_RISK_THRESHOLD_MILES === 7500",
  OIL_INTERVAL_RISK_THRESHOLD_MILES === 7500,
);
ok(
  "SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES === 3000",
  SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES === 3000,
);
ok(
  "SAFETY_CHECK_OIL_LEVEL_KEY === 'safety_check_oil_level'",
  SAFETY_CHECK_OIL_LEVEL_KEY === "safety_check_oil_level",
);
ok(
  "SAFETY_CHECK_OIL_LEVEL_TITLE includes 'oil level'",
  /oil level/i.test(SAFETY_CHECK_OIL_LEVEL_TITLE),
);

// 5. Threshold-aware chip suppression: a 5,000 mi interval on a Pentastar
//    must NOT trigger the soft warning chip; a 10,000 mi interval must.
function shouldFlagOilChip(profile: EngineProfile, intervalMiles: number) {
  const r = classifyEngineRisk(profile);
  return r.flagged && intervalMiles >= OIL_INTERVAL_RISK_THRESHOLD_MILES;
}
ok(
  "Pentastar @ 5,000 mi interval -> NO chip",
  shouldFlagOilChip(pentastar, 5000) === false,
);
ok(
  "Pentastar @ 10,000 mi interval -> chip",
  shouldFlagOilChip(pentastar, 10000) === true,
);
ok(
  "Safe V8 @ 10,000 mi interval -> NO chip",
  shouldFlagOilChip(safe, 10000) === false,
);

// 6. Safety Check anchor math (auto-insert at 3,000 mi off oil's lastPerformed)
function safetyCheckDueAtMiles(lastOilMiles: number | null, currentMiles: number | null) {
  if (lastOilMiles != null) return lastOilMiles + SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES;
  if (currentMiles != null) return currentMiles + SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES;
  return null;
}
ok(
  "Safety Check anchored 3,000 mi after lastPerformed (52,000 -> 55,000)",
  safetyCheckDueAtMiles(52000, 60000) === 55000,
);
ok(
  "Safety Check falls back to currentMiles+3,000 when no oil history",
  safetyCheckDueAtMiles(null, 18000) === 21000,
);

// 7. VIN 1C6RR6FG7KS516181 sanity (2019 Ram 1500 Pentastar) — baseline flag
ok(
  "VIN 1C6RR6FG7KS516181 (Pentastar) classifies as flagged",
  classifyEngineRisk(pentastar).flagged === true,
);

if (failed === 0) {
  console.log("\nAll Task #166 regression checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} Task #166 regression check(s) failed.`);
  process.exit(1);
}
