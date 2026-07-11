/**
 * Task #655 — Trust CARFAX work in VHI: service-match gap regression tests.
 *
 * Run: `npx tsx tests/carfax-match.smoke.ts`
 *
 * Covers:
 *  1. Dictionary gaps closed — CARFAX wordings that previously fell through
 *     now resolve to (or imply a reset of) a canonical service key.
 *  2. name ↔ free-text parity — every `toKeyFromName` result is also returned
 *     by `toKeyFromFreeText` for the same string, so the two stay in sync.
 *  3. Unmatched logging — genuinely generic descriptions are recorded once
 *     per distinct normalized description with VIN/shop context.
 *  4. `buildCarfaxMatchDiagnostics` — produces a faithful per-entry breakdown
 *     (matched / implied / unmatched / out-of-range / deduped).
 */

import {
  toKeyFromName,
  toKeyFromFreeText,
  findImpliesResetMatches,
  toAnchorKeysFromHistory,
  isInspectOnlyHistoryPhrase,
} from "../lib/service-keys";
import {
  recordUnmatchedCarfaxDescription,
  getUnmatchedCarfaxTally,
  clearUnmatchedCarfaxTally,
  normalizeCarfaxDescription,
} from "../lib/carfax-match-log";
import { buildCarfaxMatchDiagnostics } from "../lib/plan-build/carfax-match-diagnostic";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

function anchored(s: string): boolean {
  return toKeyFromFreeText(s).length > 0 || findImpliesResetMatches(s).length > 0;
}

console.log("1. Dictionary gaps closed");
{
  const cases: Array<[string, string]> = [
    ["Wheels rotated", "tire_rotation"],
    ["Tires rotated", "tire_rotation"],
    ["Wheels aligned", "wheel_alignment"],
    ["Wheel alignment performed", "wheel_alignment"],
    ["Air filter replaced", "engine_air"],
    ["Cabin air filter replaced", "cabin_air"],
    ["Transmission fluid replaced", "trans_auto"],
    ["Manual transmission fluid replaced", "trans_manual"],
    ["Differential fluid changed", "rear_differential"],
    ["Brakes serviced", "front_brake_pads"],
    ["Brake pads replaced", "front_brake_pads"],
    ["Rear brake pads replaced", "rear_brake_pads"],
    ["Front brake rotors replaced", "front_brake_rotors"],
    ["Wipers replaced", "wiper_blades"],
    ["Windshield wipers replaced", "wiper_blades"],
  ];
  for (const [desc, expectKey] of cases) {
    const ft = toKeyFromFreeText(desc);
    const impl = findImpliesResetMatches(desc).map((m) => m.childKey);
    const has = ft.includes(expectKey) || impl.includes(expectKey);
    ok(`"${desc}" → ${expectKey}`, has, `got ft=[${ft}] impl=[${impl}]`);
  }
}

console.log("2. name \u2194 free-text parity");
{
  const samples = [
    "Oil and filter changed",
    "Tires rotated",
    "Wheels rotated",
    "Wheels aligned",
    "Air filter replaced",
    "Cabin air filter replaced",
    "Transmission fluid replaced",
    "Manual transmission fluid replaced",
    "Brake fluid flushed",
    "Power steering flushed",
    "Spark plugs replaced",
    "Battery replaced",
    "Fuel filter replaced",
    "Fuel system serviced",
    "Serpentine belt replaced",
    "Timing belt replaced",
    "Windshield wipers replaced",
    "Differential fluid changed",
    "Rear differential serviced",
    "Transfer case fluid changed",
    "A/C recharge",
    "Brakes serviced",
    "Brake pads replaced",
    "Rear brake pads replaced",
    "Front brake rotors replaced",
  ];
  for (const s of samples) {
    const nm = toKeyFromName(s);
    if (nm === null) continue; // free-text-only mappings are allowed
    const ft = toKeyFromFreeText(s);
    ok(`parity "${s}" (${nm})`, ft.includes(nm), `ft=[${ft}]`);
  }
}

console.log("3. Unmatched logging");
{
  clearUnmatchedCarfaxTally();
  // Generic strings that intentionally match nothing.
  const generic = "Maintenance inspection completed";
  ok("generic stays unmatched", !anchored(generic));

  recordUnmatchedCarfaxDescription(generic, { vin: "1HGCM82633A004352", shopId: 42, source: "category" });
  recordUnmatchedCarfaxDescription("maintenance  inspection COMPLETED", { vin: "1HGCM82633A004352", shopId: 42, source: "record" });
  recordUnmatchedCarfaxDescription("Vehicle serviced", { vin: "2T1BURHE0JC000001", shopId: 7 });

  const tally = getUnmatchedCarfaxTally();
  const entry = tally.find((e) => e.key === normalizeCarfaxDescription(generic));
  ok("dedupes by normalized description", !!entry && entry.count === 2, `count=${entry?.count}`);
  ok("distinct descriptions are separate rows", tally.length === 2, `len=${tally.length}`);
  ok("captures VIN context", !!entry && entry.vins.includes("1HGCM82633A004352"));
  ok("captures shop context", !!entry && entry.shopIds.includes("42"));
  ok("tracks both sources", !!entry && entry.sources.includes("category") && entry.sources.includes("record"));
  recordUnmatchedCarfaxDescription("", { vin: "X", shopId: 1 });
  ok("blank descriptions are ignored", getUnmatchedCarfaxTally().length === 2);
  clearUnmatchedCarfaxTally();
  ok("clear empties the tally", getUnmatchedCarfaxTally().length === 0);
}

console.log("4. buildCarfaxMatchDiagnostics");
{
  const today = new Date("2026-06-27");
  const diag = buildCarfaxMatchDiagnostics({
    carfaxRecords: [
      { description: "Oil and filter changed", date: "2025-01-15", odometer: 60000 },
      { description: "Maintenance inspection completed", date: "2025-01-15", odometer: 60000 },
    ],
    carfaxCategories: [
      { serviceName: "Tires rotated", date: "2025-02-01", odometer: 61000 },
      { serviceName: "Brakes serviced", date: "1990-01-01", odometer: 1000 }, // before vehicle year
    ],
    shopServiceHistory: [
      { serviceName: "Oil change", mileage: 60000, date: new Date("2025-01-15") },
    ],
    vehicleYear: 2018,
    today,
  });

  const byDesc = (d: string) => diag.entries.find((e) => e.description === d)!;
  ok("oil change matched", byDesc("Oil and filter changed").matchedKeys.includes("oil"));
  ok("oil change deduped against shop", byDesc("Oil and filter changed").dedupedAgainstShop);
  ok("generic record unmatched", byDesc("Maintenance inspection completed").unmatched);
  ok("tire rotation category matched", byDesc("Tires rotated").matchedKeys.includes("tire_rotation"));
  ok("pre-vehicle-year category flagged out of range", byDesc("Brakes serviced").outOfDateRange);
  ok("summary counts records", diag.summary.totalRecords === 2);
  ok("summary counts categories", diag.summary.totalCategories === 2);
  ok("summary counts unmatched", diag.summary.unmatched === 1, `got ${diag.summary.unmatched}`);
}

console.log("5. Operator overrides applied live");
{
  const today = new Date("2026-06-27");
  const generic = "Maintenance inspection completed";

  // Without an override, the generic record is unmatched.
  const before = buildCarfaxMatchDiagnostics({
    carfaxRecords: [{ description: generic, date: "2025-01-15", odometer: 60000 }],
    carfaxCategories: [],
    shopServiceHistory: [],
    vehicleYear: 2018,
    today,
  });
  ok("generic unmatched without override", before.entries[0].unmatched);
  ok("no override badge without override", before.entries[0].matchedViaOverride === false);

  // With an override mapping the normalized description to a key, it matches.
  const overrides = new Map<string, string[]>([
    [normalizeCarfaxDescription(generic), ["oil"]],
  ]);
  const after = buildCarfaxMatchDiagnostics({
    carfaxRecords: [{ description: generic, date: "2025-01-15", odometer: 60000 }],
    carfaxCategories: [],
    shopServiceHistory: [],
    vehicleYear: 2018,
    today,
    carfaxKeyOverrides: overrides,
  });
  const entry = after.entries[0];
  ok("override anchors the description", !entry.unmatched);
  ok("override key surfaces in matchedKeys", entry.matchedKeys.includes("oil"));
  ok("matchedViaOverride flag set", entry.matchedViaOverride === true);
  ok("override drops unmatched count", after.summary.unmatched === 0, `got ${after.summary.unmatched}`);
}

console.log("6. Task #819 — CARFAX standardized vocabulary mappings");
{
  // High-frequency corpus phrases that now resolve to canonical keys
  // (directly or via an implied reset).
  const cases: Array<[string, string]> = [
    ["Tire(s) replaced", "tire_rotation"],
    ["Tire(s) mounted", "tire_rotation"],
    ["Wiper(s) replaced", "wiper_blades"],
    ["Fuel system cleaned/serviced", "fuel_system"],
    ["Fuel injection system flushed/serviced", "fuel_system"],
    ["Induction system serviced", "fuel_system"],
    ["Throttle body cleaned/serviced", "fuel_system"],
    ["Transmission filter replaced", "trans_auto"],
    ["Transfer case exchange/replacement", "transfer_case"],
    ["Power steering system serviced", "power_steering"],
    ["Brake system bled", "brake_fluid"],
    ["A/C system flushed", "ac_refrigerant"],
    ["Safety test", "emissions"],
    ["Water pump replaced", "coolant"],
    ["Radiator replaced", "coolant"],
    ["Drain plug gasket replaced", "oil"],
  ];
  for (const [desc, expectKey] of cases) {
    const ft = toKeyFromFreeText(desc);
    const impl = findImpliesResetMatches(desc).map((m) => m.childKey);
    const has = ft.includes(expectKey) || impl.includes(expectKey);
    ok(`"${desc}" → ${expectKey}`, has, `got ft=[${ft}] impl=[${impl}]`);
  }

  // Inspect-vs-replace verb guard: inspect-only phrases resolve to a key
  // (so they leave the unmatched tally) but must NOT anchor/reset the
  // replace-interval clock.
  const inspectOnly: Array<[string, string]> = [
    ["Brakes checked", "front_brake_pads"],
    ["Brakes inspected", "front_brake_pads"],
    ["Tire condition and pressure checked", "tire_rotation"],
    ["A/C system checked", "ac_refrigerant"],
    ["Power steering system checked", "power_steering"],
  ];
  for (const [desc, key] of inspectOnly) {
    ok(`"${desc}" resolves to ${key}`, toKeyFromFreeText(desc).includes(key), `ft=[${toKeyFromFreeText(desc)}]`);
    ok(`"${desc}" is inspect-only`, isInspectOnlyHistoryPhrase(desc));
    ok(`"${desc}" does NOT anchor`, !toAnchorKeysFromHistory(desc).includes(key), `anchors=[${toAnchorKeysFromHistory(desc)}]`);
    ok(`"${desc}" has no implied reset`, findImpliesResetMatches(desc).length === 0);
  }

  // Performed counterparts still anchor.
  ok(`"Brake pads replaced" anchors`, toAnchorKeysFromHistory("Brake pads replaced").includes("front_brake_pads"));
  ok(`"A/C system flushed" anchors`, toAnchorKeysFromHistory("A/C system flushed").includes("ac_refrigerant"));
  ok(`"Brake system bled" anchors`, toAnchorKeysFromHistory("Brake system bled").includes("brake_fluid"));

  // Emissions is an inspection-service key: the test IS the service, so
  // outcome-coded phrases both anchor the test-performed event (the key
  // does not distinguish pass from fail).
  ok(`"Passed emissions inspection" anchors emissions`, toAnchorKeysFromHistory("Passed emissions inspection").includes("emissions"));
  ok(`"Failed emissions inspection" anchors emissions (test-performed semantics)`, toAnchorKeysFromHistory("Failed emissions inspection").includes("emissions"));
  ok(`"Safety test" anchors emissions`, toAnchorKeysFromHistory("Safety test").includes("emissions"));

  // Front/rear position phrases keep their sides.
  ok(`"Front brake caliper(s) replaced" does not hit rear pads`, !toKeyFromFreeText("Front brake caliper(s) replaced").includes("rear_brake_pads"));
  ok(`"Rear brakes checked" resolves rear side`, toKeyFromFreeText("Rear brakes checked").includes("rear_brake_pads"));
  ok(`"Rear brakes checked" does NOT anchor`, toAnchorKeysFromHistory("Rear brakes checked").length === 0);

  // False-positive fixes surfaced by the corpus analysis.
  ok(`"Ignition coil(s) replaced" no longer maps to oil`, !toKeyFromFreeText("Ignition coil(s) replaced").includes("oil"), `ft=[${toKeyFromFreeText("Ignition coil(s) replaced")}]`);
  ok(`"Oil and filter changed" still maps to oil`, toKeyFromFreeText("Oil and filter changed").includes("oil"));
  {
    const ft = toKeyFromFreeText("Cabin air filter replaced/cleaned");
    ok(`"Cabin air filter replaced/cleaned" maps to cabin_air only`, ft.includes("cabin_air") && !ft.includes("engine_air"), `ft=[${ft}]`);
    const impl = findImpliesResetMatches("Cabin air filter replaced/cleaned").map((m) => m.childKey);
    ok(`cabin filter line does not imply engine_air reset`, !impl.includes("engine_air"), `impl=[${impl}]`);
    const engineImpl = findImpliesResetMatches("Air filter replaced").map((m) => m.childKey);
    ok(`plain "Air filter replaced" still implies engine_air`, engineImpl.includes("engine_air"));
  }
  {
    const ft = toKeyFromFreeText("Anti-theft/keyless remote battery replaced");
    ok(`key-fob battery does not map to battery key`, !ft.includes("battery"), `ft=[${ft}]`);
    ok(`key-fob battery name does not map to battery key`, toKeyFromName("Anti-theft/keyless remote battery replaced") !== "battery");
    ok(`"Battery replaced" still maps to battery`, toKeyFromFreeText("Battery replaced").includes("battery"));
  }

  // Generic phrases intentionally stay unmatched (no false credit).
  for (const generic of ["Vehicle serviced", "Recommended maintenance performed", "Maintenance inspection completed", "Battery charged"]) {
    ok(`generic "${generic}" stays unmatched/unanchored`, !anchored(generic) || toAnchorKeysFromHistory(generic).length === 0);
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll CARFAX match checks passed.");
