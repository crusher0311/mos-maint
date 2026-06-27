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

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll CARFAX match checks passed.");
