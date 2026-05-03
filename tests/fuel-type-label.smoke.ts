/**
 * Smoke test for `deriveFuelTypeLabel`.
 *
 * Run: `npx tsx tests/fuel-type-label.smoke.ts`
 *
 * Locks in fuel-type derivation across gas-only, diesel, plain hybrid,
 * plug-in hybrid, pure EV, mild hybrid (48V), flex fuel, and the raw
 * "I" fallback when no engine hint is available.
 */

import { deriveFuelTypeLabel } from "../lib/fuel-type-label";

let failed = 0;

function eq(name: string, got: unknown, want: unknown) {
  if (got === want) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(
      `  ✗ ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
    );
  }
}

console.log("deriveFuelTypeLabel");

// Gas-only: short code "G" or no engine hybrid hints.
eq("gas-only short code G", deriveFuelTypeLabel({ fuelType: "G" }), "Gasoline");
eq(
  "gas-only with engine name",
  deriveFuelTypeLabel({
    fuelType: "G",
    engineName: "2.5L I4",
    model: "Camry",
  }),
  "Gasoline",
);

// Diesel
eq("diesel short code D", deriveFuelTypeLabel({ fuelType: "D" }), "Diesel");
eq(
  "diesel via I + engine text",
  deriveFuelTypeLabel({
    fuelType: "I",
    engineName: "3.0L Turbo Diesel I6",
  }),
  "Diesel",
);

// Plain hybrid (Prius)
eq(
  "plain hybrid Prius",
  deriveFuelTypeLabel({
    fuelType: "I",
    engineName: "1.8L I4 Hybrid",
    model: "Prius",
    trim: "LE",
  }),
  "Hybrid",
);

// Plug-in hybrid (Volvo XC90 T8)
eq(
  "plug-in hybrid Volvo XC90 T8",
  deriveFuelTypeLabel({
    fuelType: "I",
    engineName: "2.0L I4 Plug-In Hybrid",
    model: "XC90",
    trim: "T8 Recharge",
  }),
  "Plug-in Hybrid",
);
eq(
  "PHEV short code beats hybrid",
  deriveFuelTypeLabel({ fuelType: "PHEV" }),
  "Plug-in Hybrid",
);

// Pure EV
eq("pure EV short code", deriveFuelTypeLabel({ fuelType: "E" }), "Electric");
eq(
  "pure EV BEV beats hybrid hint",
  deriveFuelTypeLabel({
    fuelType: "BEV",
    engineName: "Hybrid Synergy Drive",
  }),
  "Electric",
);

// Mild hybrid (48V)
eq(
  "mild hybrid 48V",
  deriveFuelTypeLabel({
    fuelType: "I",
    engineName: "3.0L I6 48V Mild Hybrid",
    model: "GLE 450",
  }),
  "Mild Hybrid",
);
eq(
  "mild hybrid via 48V token alone",
  deriveFuelTypeLabel({
    fuelType: "G",
    engineName: "3.0L I6 Turbo 48V",
  }),
  "Mild Hybrid",
);

// Flex fuel
eq(
  "flex fuel short code F",
  deriveFuelTypeLabel({ fuelType: "F" }),
  "Flex Fuel",
);
eq(
  "flex fuel via I + engine text",
  deriveFuelTypeLabel({
    fuelType: "I",
    engineName: "5.3L V8 Flex Fuel",
  }),
  "Flex Fuel",
);

// Raw "I" fallback when no engine hint is available — task explicitly
// requires we stop showing the bare "I" code, so it should land on Gasoline.
eq(
  "bare I with no hints falls back to Gasoline",
  deriveFuelTypeLabel({ fuelType: "I" }),
  "Gasoline",
);

// Null / unknown handling
eq(
  "null fuelType with no engine hints returns null",
  deriveFuelTypeLabel({ fuelType: null }),
  null,
);
eq(
  "empty fuelType returns null",
  deriveFuelTypeLabel({ fuelType: "" }),
  null,
);
eq(
  "unknown raw value passes through",
  deriveFuelTypeLabel({ fuelType: "Methanol" }),
  "Methanol",
);

if (failed === 0) {
  console.log("\nAll fuel-type label checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} fuel-type label check(s) failed.`);
  process.exit(1);
}
