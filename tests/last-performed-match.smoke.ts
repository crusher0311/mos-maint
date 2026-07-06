/**
 * Smoke test for the pure "last performed" matching layer (Task #743).
 *
 * Run: `npx tsx tests/last-performed-match.smoke.ts`
 *
 * Locks in the fact-only contract: an absent record returns `null` (so the
 * caller renders NO badge and never shows a false "never done"), while a
 * present record matches by canonical service key or free-text tokens and
 * carries the correct advisor-facing source label.
 *
 * This exercises the data-store-free logic only (no db, no `server-only`),
 * which is why the matcher lives in `lib/last-performed-match.ts` separate
 * from the server loader in `lib/last-performed.ts`.
 */

import {
  buildRecord,
  matchLastPerformed,
  type VehicleHistory,
} from "../lib/last-performed-match";

let failed = 0;

function ok(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

function eq(name: string, got: unknown, want: unknown) {
  ok(`${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`, got === want);
}

console.log("matchLastPerformed");

// --- 1. No record → null (the core "never a false never-done" guarantee) ---
const emptyHistory: VehicleHistory = {
  records: [],
  currentMiles: 50000,
  milesPerDay: 30,
};
eq("empty history → null", matchLastPerformed(emptyHistory, "Oil Change"), null);

// --- 2. History exists but nothing matches the query → null ---
const brakesHistory: VehicleHistory = {
  records: [buildRecord("shop", "Front brake pads replaced", new Date("2024-03-05"), 48200)],
  currentMiles: 52000,
  milesPerDay: 30,
};
eq(
  "non-matching query → null",
  matchLastPerformed(brakesHistory, "Cabin Air Filter"),
  null,
);

// --- 3. Shop record matches → badge with recorded odometer + shop label ---
const oilShop = matchLastPerformed(
  {
    records: [buildRecord("shop", "Full synthetic oil change", new Date("2024-03-05"), 48200)],
    currentMiles: 52000,
    milesPerDay: 30,
  },
  "Oil Change",
);
ok("shop oil change matched (not null)", oilShop !== null);
if (oilShop) {
  eq("shop source", oilShop.source, "shop");
  eq("shop source label", oilShop.sourceLabel, "at your shop");
  eq("recorded miles used", oilShop.miles, 48200);
  eq("recorded miles not estimated", oilShop.milesEstimated, false);
  eq("iso date", oilShop.date, "2024-03-05");
  ok("summary mentions Last performed", /Last performed/.test(oilShop.summary));
  ok("summary mentions at your shop", /at your shop/.test(oilShop.summary));
}

// --- 4. CARFAX record with no odometer → estimated miles + carfax label ---
const cfHistory: VehicleHistory = {
  records: [buildRecord("carfax", "Engine oil and filter changed", new Date("2023-01-01"), null)],
  currentMiles: 60000,
  milesPerDay: 40,
};
const oilCf = matchLastPerformed(cfHistory, "Oil Change");
ok("carfax oil change matched (not null)", oilCf !== null);
if (oilCf) {
  eq("carfax source", oilCf.source, "carfax");
  eq("carfax source label", oilCf.sourceLabel, "via CARFAX");
  ok("carfax miles estimated flag", oilCf.milesEstimated === true || oilCf.miles === null);
  ok("summary mentions via CARFAX", /via CARFAX/.test(oilCf.summary));
}

// --- 5. Free-text (non-canonical) repair matches by tokens ---
const strutHistory: VehicleHistory = {
  records: [buildRecord("shop", "Replaced front strut mount", new Date("2024-06-01"), 51000)],
  currentMiles: 52000,
  milesPerDay: 30,
};
const strut = matchLastPerformed(strutHistory, "front strut mount replacement");
ok("free-text strut mount matched (not null)", strut !== null);

// --- 6. Most-recent wins when multiple records match ---
const multi: VehicleHistory = {
  records: [
    buildRecord("shop", "Oil change", new Date("2022-01-01"), 30000),
    buildRecord("shop", "Oil change", new Date("2024-01-01"), 48000),
    buildRecord("shop", "Oil change", new Date("2023-01-01"), 40000),
  ],
  currentMiles: 52000,
  milesPerDay: 30,
};
const recent = matchLastPerformed(multi, "Oil Change");
ok("multi-record matched (not null)", recent !== null);
if (recent) eq("most recent date chosen", recent.date, "2024-01-01");

// --- 7. Empty/garbage query → null (nothing to match on) ---
eq("empty query → null", matchLastPerformed(multi, ""), null);
eq("whitespace query → null", matchLastPerformed(multi, "   "), null);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll last-performed matcher assertions passed.");
