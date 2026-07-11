// tests/shared-vehicle-logic.smoke.ts
//
// Task #763 — parity checks for the consolidated shared helpers:
//   1. lib/aces-fields.ts (coerceAcesId / buildSubmodelKey) produces exactly
//      the same values the old inline logic did, and both consumers
//      (extractVehicleSpecs, acesFromDecoded) agree on identical input rows.
//   2. lib/vehicle-display.ts resolveVehicleFields matches the old inline
//      DashboardClient parse (structured-fields-win, displayVehicle fallback).
//   3. tokenizeQueryWords reproduces the old inline splits (minLen 2 and 3).
//
// Pure refactor — these tests pin behavior, they do not change it.

import { coerceAcesId, buildSubmodelKey } from "../lib/aces-fields";
import { resolveVehicleFields, splitDisplayVehicle } from "../lib/vehicle-display";
import { tokenizeQueryWords, buildSearchQuery, extractVehicleSpecs } from "../lib/job-scoring";
import { acesFromDecoded } from "../lib/job-index-aces";

let failed = 0;
function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string): never { console.error(`  ✗ ${msg}`); process.exit(1); }
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) { failed++; fail(`${msg}: expected ${e}, got ${a}`); }
}

console.log("1. coerceAcesId matches old inline coercion");
eq(coerceAcesId(12345), 12345, "positive number passes through");
eq(coerceAcesId(0), null, "zero → null");
eq(coerceAcesId(-3), null, "negative → null");
eq(coerceAcesId(null), null, "null → null");
eq(coerceAcesId(undefined), null, "undefined → null");
eq(coerceAcesId("123"), null, "string → null (typeof guard)");
ok("coerceAcesId parity");

console.log("2. buildSubmodelKey matches old inline template");
eq(
  buildSubmodelKey(2018, " Ford ", "F-150", " XLT 4dr "),
  "2018|ford|f-150|xlt 4dr",
  "trims + lowercases each part",
);
eq(buildSubmodelKey(2018, "Ford", "F-150", null), null, "missing style → null");
eq(buildSubmodelKey(0, "Ford", "F-150", "XLT"), null, "falsy year → null");
eq(buildSubmodelKey("", "Ford", "F-150", "XLT"), null, "empty year → null");
ok("buildSubmodelKey parity");

console.log("3. extractVehicleSpecs ↔ acesFromDecoded agree on identical rows");
const row = {
  vehicle_id: 401234,
  engine_id: 9021,
  year: 2018,
  make: "Honda",
  model: "CR-V",
  style: "EX-L",
} as any;
const specs = extractVehicleSpecs(row);
const aces = acesFromDecoded(row);
if (!aces) fail("acesFromDecoded returned null for valid row");
eq(specs.acesVehicleId, aces.acesVehicleId, "acesVehicleId agrees");
eq(specs.acesEngineId, aces.acesEngineId, "acesEngineId agrees");
eq(specs.submodelKey, aces.submodelKey, "submodelKey agrees");
eq(specs.submodelKey, "2018|honda|cr-v|ex-l", "submodelKey exact value");
const ambiguous = { vehicle_id: null, engine_id: null, year: 2018, make: "Honda", model: "CR-V", style: null } as any;
const specsA = extractVehicleSpecs(ambiguous);
const acesA = acesFromDecoded(ambiguous);
if (!acesA) fail("acesFromDecoded returned null for ambiguous row");
eq(specsA.acesVehicleId, null, "ambiguous vehicle_id → null (specs)");
eq(acesA.acesVehicleId, null, "ambiguous vehicle_id → null (aces)");
eq(specsA.submodelKey, null, "missing style → null submodelKey (specs)");
eq(acesA.submodelKey, null, "missing style → null submodelKey (aces)");
ok("both consumers agree via shared aces-fields helpers");

console.log("4. resolveVehicleFields matches old DashboardClient inline parse");
eq(
  resolveVehicleFields({ vehicle: { year: 2020, make: "Toyota", model: "Camry" }, displayVehicle: "1999 Junk Data" }),
  { year: 2020, make: "Toyota", model: "Camry" },
  "structured fields win",
);
eq(
  resolveVehicleFields({ displayVehicle: "2018 Ford F-150" }),
  { year: 2018, make: "Ford", model: "F-150" },
  "displayVehicle fallback parses year/make/model",
);
eq(
  resolveVehicleFields({ displayVehicle: "2015 Mercedes-Benz C 300 4MATIC" }),
  { year: 2015, make: "Mercedes-Benz", model: "C 300 4MATIC" },
  "multi-word model joined",
);
eq(
  resolveVehicleFields({ displayVehicle: "Ford F-150" }),
  { year: undefined, make: "Ford", model: "F-150" },
  "no leading year",
);
eq(resolveVehicleFields({}), { year: undefined, make: undefined, model: undefined }, "empty row");
// Partial structured data must NOT fall back (matches old `!year && !make && !model` guard)
eq(
  resolveVehicleFields({ vehicle: { make: "Ford" }, displayVehicle: "2018 Ford F-150" }),
  { year: undefined, make: "Ford", model: undefined },
  "any structured field present suppresses fallback",
);
const split = splitDisplayVehicle("2018 Ford F-150");
eq(split.year, 2018, "splitDisplayVehicle year");
eq(split.parts, ["Ford", "F-150"], "splitDisplayVehicle parts");
ok("resolveVehicleFields parity");

console.log("5. tokenizeQueryWords reproduces old inline splits");
eq(tokenizeQueryWords("Brake Pad Replacement -- Front", 2), ["brake", "pad", "replacement", "--", "front"], "minLen 2 keeps 2-char tokens");
eq(tokenizeQueryWords("a Brake Pad", 2), ["brake", "pad"], "minLen 2 drops 1-char words");
eq(tokenizeQueryWords("an oil change", 3), ["oil", "change"], "minLen 3 drops 2-char words");
eq(buildSearchQuery("Replace Brake Pads").allTokens, ["replace", "brake", "pads"], "buildSearchQuery allTokens unchanged");
eq(buildSearchQuery("Replace Brake Pads").coreTokens, ["brake", "pads"], "buildSearchQuery drops stopwords");
ok("tokenizer parity");

if (failed === 0) {
  console.log("\nAll shared-vehicle-logic parity checks passed.");
}
