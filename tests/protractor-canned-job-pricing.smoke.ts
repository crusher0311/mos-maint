/**
 * Smoke test for canned-job line pricing normalization.
 *
 * Run: `npx tsx tests/protractor-canned-job-pricing.smoke.ts`
 *
 * Regression guard for the bug where Protractor "canned jobs" pushed to a new
 * work order from the MOS dashboard landed as $0.00 subtotals. The cause was
 * `normalizeProtractorPackageLine` reading pricing only from the flat
 * `Price`/`UnitPrice` fields, while BG (and other) canned-job / service-package
 * lines carry their pricing under nested `PriceSummary.SellPrice` and labor
 * lines under `Rate` + `EstimatedHours`/`Hours`. This pins the wider field
 * mapping (and idempotency) so the pricing survives the read -> modal -> push
 * chain.
 */

import { normalizeProtractorPackageLine } from "../lib/integrations/protractor";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const approx = (a: number, b: number) => Math.abs(a - b) < 0.005;

console.log("Protractor canned-job line pricing");

// 1. Part line carrying price under nested PriceSummary.SellPrice (BG shape).
{
  const r = normalizeProtractorPackageLine({
    Type: "Part",
    Description: "BG fluid",
    Quantity: 2,
    PriceSummary: { SellPrice: 19.99, SellTotal: 39.98 },
    PartNumber: "BG-123",
    Manufacturer: "BG",
  });
  ok(
    "PriceSummary.SellPrice -> unitPrice 19.99",
    approx(r.unitPrice, 19.99) && r.quantity === 2 && r.partNumber === "BG-123",
    `got unitPrice=${r.unitPrice} qty=${r.quantity}`,
  );
}

// 2. Labor line with Rate + Hours (no flat Price).
{
  const r = normalizeProtractorPackageLine({
    Type: "Labor",
    Description: "BG service labor",
    Rate: 150,
    Hours: 1.5,
  });
  ok(
    "labor Rate -> unitPrice 150, Hours -> quantity 1.5",
    approx(r.unitPrice, 150) && approx(r.quantity, 1.5),
    `got unitPrice=${r.unitPrice} qty=${r.quantity}`,
  );
}

// 3. Labor EstimatedHours is honored over a raw Quantity count.
{
  const r = normalizeProtractorPackageLine({
    Type: "Labor",
    Rate: 120,
    Quantity: 1,
    EstimatedHours: 2.5,
  });
  ok(
    "labor EstimatedHours -> quantity 2.5",
    approx(r.unitPrice, 120) && approx(r.quantity, 2.5),
    `got unitPrice=${r.unitPrice} qty=${r.quantity}`,
  );
}

// 4. Flat Price field still works (back-compat).
{
  const r = normalizeProtractorPackageLine({ Type: "Part", Price: 10, Quantity: 3 });
  ok("flat Price 10 still read", approx(r.unitPrice, 10) && r.quantity === 3);
}

// 5. Only an extended/total present -> unit price derived from it.
{
  const r = normalizeProtractorPackageLine({ Type: "Part", Quantity: 4, Total: 40 });
  ok("derive unit from Total", approx(r.unitPrice, 10), `got ${r.unitPrice}`);
}

// 6. Idempotent: feeding an already-normalized line returns the same values.
{
  const once = normalizeProtractorPackageLine({
    Type: "Part",
    PriceSummary: { SellPrice: 19.99 },
    Quantity: 2,
    Description: "x",
  });
  const twice = normalizeProtractorPackageLine(once);
  ok(
    "idempotent for already-normalized lines",
    approx(twice.unitPrice, 19.99) &&
      twice.quantity === 2 &&
      twice.lineType.toLowerCase() === "part",
    `got unitPrice=${twice.unitPrice} qty=${twice.quantity} type=${twice.lineType}`,
  );
}

// 7. Labor prefers PriceSummary.SellPrice over a stray Rate.
{
  const r = normalizeProtractorPackageLine({
    Type: "Labor",
    PriceSummary: { SellPrice: 120 },
    Rate: 999,
    Hours: 2,
  });
  ok(
    "labor SellPrice preferred over Rate",
    approx(r.unitPrice, 120) && approx(r.quantity, 2),
    `got unitPrice=${r.unitPrice}`,
  );
}

// 8. Genuinely unpriced job stays sensible (no crash, $0).
{
  const r = normalizeProtractorPackageLine({ Type: "Labor", Description: "no price" });
  ok("unpriced line -> 0 without crashing", r.unitPrice === 0 && r.quantity === 1);
}

if (failed === 0) {
  console.log("\nAll Protractor canned-job pricing checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} Protractor canned-job pricing check(s) failed.`);
  process.exit(1);
}
