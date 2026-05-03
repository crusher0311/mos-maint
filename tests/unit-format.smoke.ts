/**
 * Smoke test for the dual-unit spec formatters.
 *
 * Run: `npx tsx tests/unit-format.smoke.ts`
 *
 * Locks in `formatGallonsDual` and `formatPoundsDual` behavior across
 * typical values, zero, comma-formatted strings, and null/undefined.
 */

import {
  GAL_TO_L,
  LBS_TO_KG,
  formatGallonsDual,
  formatPoundsDual,
} from "../lib/unit-format";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, got: unknown, want: unknown) {
  ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

console.log("formatGallonsDual");

// Sanity check on the conversion constant — guards against silent edits.
ok(
  "GAL_TO_L matches the US-gal → L constant",
  Math.abs(GAL_TO_L - 3.785411784) < 1e-12,
);

eq("typical 18 gal", formatGallonsDual(18), "18 gal / 68.1 L");
eq("decimal 15.5 gal", formatGallonsDual(15.5), "15.5 gal / 58.7 L");
eq("zero gallons", formatGallonsDual(0), "0 gal / 0 L");
eq(
  "string '1,234.5' parses commas",
  formatGallonsDual("1,234.5"),
  "1,234.5 gal / 4,673.1 L",
);
eq("plain numeric string '20'", formatGallonsDual("20"), "20 gal / 75.7 L");
eq("null returns null", formatGallonsDual(null), null);
eq("undefined returns null", formatGallonsDual(undefined), null);
eq("empty string returns null", formatGallonsDual(""), null);
eq("NaN-ish 'abc' returns null", formatGallonsDual("abc"), null);

// Rounding: 0.05 gal * 3.785 = 0.189... → 0.2 L
eq("rounds half-up to one decimal", formatGallonsDual(0.05), "0.1 gal / 0.2 L");

console.log("formatPoundsDual");

ok(
  "LBS_TO_KG matches the lb → kg constant",
  Math.abs(LBS_TO_KG - 0.45359237) < 1e-12,
);

eq("typical 4500 lbs", formatPoundsDual(4500), "4,500 lbs / 2,041 kg");
eq("zero pounds", formatPoundsDual(0), "0 lbs / 0 kg");
eq(
  "string '6,200' parses commas",
  formatPoundsDual("6,200"),
  "6,200 lbs / 2,812 kg",
);
eq("decimal input rounds to int lbs", formatPoundsDual(100.6), "101 lbs / 46 kg");
eq("null returns null", formatPoundsDual(null), null);
eq("undefined returns null", formatPoundsDual(undefined), null);
eq("empty string returns null", formatPoundsDual(""), null);
eq("garbage string returns null", formatPoundsDual("heavy"), null);

if (failed === 0) {
  console.log("\nAll unit-format checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} unit-format check(s) failed.`);
  process.exit(1);
}
