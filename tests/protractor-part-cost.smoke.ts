/**
 * Smoke test for real part-cost capture + resolution (task #681).
 *
 * Run: `npx tsx tests/protractor-part-cost.smoke.ts`
 *
 * Pins the behavior that replaced the hardcoded 60%-of-retail Cost written on
 * every Protractor push:
 *   - `extractProtractorLineCost` pulls real Cost/TotalCost off raw lines.
 *   - `normalizeProtractorPackageLine` carries the real cost through the
 *     read -> modal -> push chain (parts only, never labor).
 *   - `resolvePartLineCost` writes the real cost when present, falls back to
 *     the per-shop ratio estimate when not.
 *   - `isValidPartCostRatio` guards the configurable ratio.
 */

import {
  normalizeProtractorPackageLine,
  resolvePartLineCost,
  extractProtractorLineCost,
  isValidPartCostRatio,
  DEFAULT_PART_COST_RATIO,
} from "../lib/integrations/protractor";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const approx = (a: number | undefined, b: number) =>
  typeof a === "number" && Math.abs(a - b) < 0.005;

console.log("Protractor part cost (task #681)");

// --- extractProtractorLineCost ---

// 1. Flat Cost/TotalCost on a raw invoice line.
{
  const r = extractProtractorLineCost({ Cost: "12.50", TotalCost: "25.00", Quantity: 2 });
  ok(
    "raw Cost/TotalCost extracted",
    approx(r.cost, 12.5) && approx(r.extendedCost, 25),
    `got cost=${r.cost} ext=${r.extendedCost}`,
  );
}

// 2. Only TotalCost present -> unit derived from quantity.
{
  const r = extractProtractorLineCost({ TotalCost: 30, Quantity: 3 });
  ok(
    "unit cost derived from TotalCost/qty",
    approx(r.cost, 10) && approx(r.extendedCost, 30),
    `got cost=${r.cost} ext=${r.extendedCost}`,
  );
}

// 3. Zero/absent cost -> undefined (never 0, which would write $0 cost).
{
  const r = extractProtractorLineCost({ Cost: 0, TotalCost: "" });
  ok("zero/absent cost -> undefined", r.cost === undefined && r.extendedCost === undefined);
}

// --- normalizeProtractorPackageLine cost carry ---

// 4. Part line carries real cost through normalization.
{
  const r = normalizeProtractorPackageLine({
    Type: "Part",
    Description: "Oil filter",
    Quantity: 2,
    Price: 19.99,
    Cost: 8.4,
    TotalCost: 16.8,
  });
  ok(
    "part line carries cost 8.40 / extendedCost 16.80",
    approx(r.cost, 8.4) && approx(r.extendedCost, 16.8),
    `got cost=${r.cost} ext=${r.extendedCost}`,
  );
}

// 5. Labor line never carries cost (Protractor labor TotalCost is labor total).
{
  const r = normalizeProtractorPackageLine({
    Type: "Labor",
    Rate: 150,
    Hours: 2,
    TotalCost: 300,
  });
  ok(
    "labor line does NOT carry cost",
    r.cost === undefined && r.extendedCost === undefined,
    `got cost=${r.cost} ext=${r.extendedCost}`,
  );
}

// 6. Idempotent: renormalizing keeps the cost.
{
  const once = normalizeProtractorPackageLine({
    Type: "Part",
    Quantity: 2,
    Price: 19.99,
    Cost: 8.4,
  });
  const twice = normalizeProtractorPackageLine(once);
  ok("cost survives renormalization", approx(twice.cost, 8.4), `got ${twice.cost}`);
}

// --- resolvePartLineCost ---

// 7. Real cost written through unchanged.
{
  const r = resolvePartLineCost(
    { quantity: 2, unitPrice: 19.99, extendedPrice: 39.98, cost: 8.4, extendedCost: 16.8 },
    0.6,
  );
  ok(
    "real cost used as-is",
    r.source === "real" && approx(r.unitCost, 8.4) && approx(r.totalCost, 16.8),
    `got source=${r.source} unit=${r.unitCost} total=${r.totalCost}`,
  );
}

// 8. Real unit cost without extended -> extended derived from qty.
{
  const r = resolvePartLineCost({ quantity: 3, unitPrice: 10, cost: 4 }, 0.6);
  ok(
    "extended derived from real unit cost",
    r.source === "real" && approx(r.totalCost, 12),
    `got total=${r.totalCost}`,
  );
}

// 9. No cost -> ratio estimate from retail.
{
  const r = resolvePartLineCost({ quantity: 2, unitPrice: 50, extendedPrice: 100 }, 0.6);
  ok(
    "no cost -> 60% estimate",
    r.source === "estimated" && approx(r.unitCost, 30) && approx(r.totalCost, 60),
    `got source=${r.source} unit=${r.unitCost} total=${r.totalCost}`,
  );
}

// 10. Custom shop ratio respected.
{
  const r = resolvePartLineCost({ quantity: 1, unitPrice: 100 }, 0.45);
  ok(
    "custom ratio 0.45 applied",
    r.source === "estimated" && approx(r.unitCost, 45) && approx(r.totalCost, 45),
    `got unit=${r.unitCost}`,
  );
}

// 11. Zero cost is NOT treated as real (falls back to estimate).
{
  const r = resolvePartLineCost({ quantity: 1, unitPrice: 20, cost: 0 }, 0.6);
  ok(
    "cost=0 falls back to estimate",
    r.source === "estimated" && approx(r.unitCost, 12),
    `got source=${r.source} unit=${r.unitCost}`,
  );
}

// 12. Extended cost alone still anchors the line as real.
{
  const r = resolvePartLineCost({ quantity: 4, unitPrice: 10, extendedCost: 20 }, 0.6);
  ok(
    "extendedCost alone -> real, unit derived",
    r.source === "real" && approx(r.unitCost, 5) && approx(r.totalCost, 20),
    `got source=${r.source} unit=${r.unitCost} total=${r.totalCost}`,
  );
}

// --- isValidPartCostRatio ---

{
  ok(
    "ratio validation bounds",
    isValidPartCostRatio(0.6) &&
      isValidPartCostRatio(0.05) &&
      isValidPartCostRatio(1.5) &&
      !isValidPartCostRatio(0) &&
      !isValidPartCostRatio(-0.5) &&
      !isValidPartCostRatio(60) && // percentage typed as ratio
      !isValidPartCostRatio(NaN) &&
      !isValidPartCostRatio("0.6" as any) &&
      !isValidPartCostRatio(null),
  );
  ok("default ratio is 0.6 (historical hardcode)", DEFAULT_PART_COST_RATIO === 0.6);
}

if (failed === 0) {
  console.log("\nAll part-cost checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} part-cost check(s) failed.`);
  process.exit(1);
}
