/**
 * Smoke test for the oil-sticker rename/hide behavior (task #439 → #441).
 *
 * Run: `npx tsx tests/sticker-defaults.smoke.ts`
 *
 * Locks in `determineOilType` auto-detect fall-through, plus
 * `getVisibleOilTypes` and `resolveOilTypeLabel` honoring per-shop
 * `hidden` / `label` overrides. A future refactor that silently
 * re-routes a BMW into Conventional, or that lets hidden buckets
 * leak back into the picker, will fail here.
 */

import {
  DEFAULT_INTERVALS,
  determineOilType,
  getVisibleOilTypes,
  resolveOilTypeLabel,
  type IntervalsConfig,
  type OilType,
} from "../lib/sticker-defaults";

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
  ok(
    name,
    got === want,
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
  );
}

function arrEq(name: string, got: OilType[], want: OilType[]) {
  ok(
    name,
    got.length === want.length && got.every((v, i) => v === want[i]),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
  );
}

function withHidden(...keys: OilType[]): Partial<IntervalsConfig> {
  const out: Partial<IntervalsConfig> = {
    diesel: { ...DEFAULT_INTERVALS.diesel },
    euro: { ...DEFAULT_INTERVALS.euro },
    synthetic: { ...DEFAULT_INTERVALS.synthetic },
    conventional: { ...DEFAULT_INTERVALS.conventional },
  };
  for (const k of keys) {
    out[k] = { ...DEFAULT_INTERVALS[k], hidden: true };
  }
  return out;
}

console.log("determineOilType — natural matches when nothing is hidden");

eq(
  "diesel fuel → diesel",
  determineOilType({ make: "Ford", fuelType: "Diesel" }),
  "diesel",
);
eq(
  "BMW → euro",
  determineOilType({ make: "BMW" }),
  "euro",
);
eq(
  "Mercedes-Benz → euro",
  determineOilType({ make: "Mercedes-Benz" }),
  "euro",
);
eq(
  "synthetic in job description → synthetic",
  determineOilType({ make: "Toyota", jobDescription: "Full Synthetic Oil Change" }),
  "synthetic",
);
eq(
  "no signal → conventional",
  determineOilType({ make: "Toyota" }),
  "conventional",
);
eq(
  "diesel beats euro (precedence)",
  determineOilType({ make: "BMW", fuelType: "Diesel" }),
  "diesel",
);

console.log("determineOilType — fall-through when the natural bucket is hidden");

eq(
  "diesel hidden → euro for a diesel BMW",
  determineOilType({ make: "BMW", fuelType: "Diesel" }, withHidden("diesel")),
  "euro",
);
eq(
  "diesel hidden → euro for a diesel Ford (next in precedence)",
  determineOilType({ make: "Ford", fuelType: "Diesel" }, withHidden("diesel")),
  "euro",
);
eq(
  "diesel+euro hidden → synthetic for a diesel Ford",
  determineOilType(
    { make: "Ford", fuelType: "Diesel" },
    withHidden("diesel", "euro"),
  ),
  "synthetic",
);
eq(
  "euro hidden → synthetic for a BMW (NOT conventional)",
  determineOilType({ make: "BMW" }, withHidden("euro")),
  "synthetic",
);
eq(
  "euro+synthetic hidden → conventional for a BMW",
  determineOilType({ make: "BMW" }, withHidden("euro", "synthetic")),
  "conventional",
);
eq(
  "synthetic hidden → conventional when job said synthetic",
  determineOilType(
    { make: "Toyota", jobDescription: "Full Synthetic" },
    withHidden("synthetic"),
  ),
  "conventional",
);

console.log("determineOilType — every bucket hidden falls to fallbackDefault then synthetic");

eq(
  "all hidden, no fallback → synthetic",
  determineOilType({ make: "BMW" }, withHidden("diesel", "euro", "synthetic", "conventional")),
  "synthetic",
);
eq(
  "all hidden, fallback=conventional → conventional ignored (hidden), returns synthetic",
  determineOilType(
    { make: "BMW" },
    withHidden("diesel", "euro", "synthetic", "conventional"),
    "conventional",
  ),
  "synthetic",
);
eq(
  "all but conventional hidden, fallback=synthetic → conventional (visible wins before fallback)",
  determineOilType(
    { make: "BMW" },
    withHidden("diesel", "euro", "synthetic"),
    "synthetic",
  ),
  "conventional",
);

console.log("getVisibleOilTypes — hidden buckets dropped, picker order preserved");

arrEq(
  "no overrides → all four in picker order",
  getVisibleOilTypes(),
  ["conventional", "synthetic", "euro", "diesel"],
);
arrEq(
  "euro hidden → dropped",
  getVisibleOilTypes(withHidden("euro")),
  ["conventional", "synthetic", "diesel"],
);
arrEq(
  "diesel + conventional hidden → dropped",
  getVisibleOilTypes(withHidden("diesel", "conventional")),
  ["synthetic", "euro"],
);
arrEq(
  "all hidden → empty",
  getVisibleOilTypes(withHidden("diesel", "euro", "synthetic", "conventional")),
  [],
);

console.log("resolveOilTypeLabel — custom label wins, built-in name otherwise");

eq(
  "no overrides → built-in 'European' for euro",
  resolveOilTypeLabel("euro"),
  "European",
);
eq(
  "no overrides → built-in 'Conventional' for conventional",
  resolveOilTypeLabel("conventional"),
  "Conventional",
);
eq(
  "custom label wins",
  resolveOilTypeLabel("euro", {
    euro: { ...DEFAULT_INTERVALS.euro, label: "Euro Spec" },
  }),
  "Euro Spec",
);
eq(
  "whitespace-only label falls back to built-in",
  resolveOilTypeLabel("synthetic", {
    synthetic: { ...DEFAULT_INTERVALS.synthetic, label: "   " },
  }),
  "Synthetic",
);
eq(
  "empty-string label falls back to built-in",
  resolveOilTypeLabel("diesel", {
    diesel: { ...DEFAULT_INTERVALS.diesel, label: "" },
  }),
  "Diesel",
);
eq(
  "custom label is trimmed before being returned",
  resolveOilTypeLabel("conventional", {
    conventional: { ...DEFAULT_INTERVALS.conventional, label: "  House Blend  " },
  }),
  "House Blend",
);

if (failed === 0) {
  console.log("\nAll sticker-defaults checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} sticker-defaults check(s) failed.`);
  process.exit(1);
}
