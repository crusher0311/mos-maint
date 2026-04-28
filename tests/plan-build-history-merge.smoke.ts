/**
 * Smoke test for the Carfax / Protractor / shop-history merge into the
 * `LastDone` map inside `triage()`.
 *
 * Run: `npx tsx tests/plan-build-history-merge.smoke.ts`
 *
 * Why: `app/api/plan-build/route.ts` flattens both Protractor work orders
 * and Tekmetric/Shop-Ware/job_index entries into the same
 * `shopServiceHistory: ShopServiceHistory[]` array, then hands it (plus
 * `carfaxRecords`) to `triage()`. Inside, `triage()` builds a single
 * per-serviceKey "last done" record where the most recent date wins, and
 * the resulting anchor mileage drives the dueAtMiles math for every OEM
 * row. A regression that swaps the comparison or drops a source would
 * silently shift "last oil change" by months/years.
 *
 * This test seeds three competing service-history sources for a single
 * serviceKey (engine oil) and asserts:
 *
 *   1. The most recent shop-history entry wins over an older Carfax row.
 *   2. The most recent Carfax row wins over an older shop-history entry.
 *   3. A Carfax row that closely matches an existing shop entry (same
 *      mileage / same date) is suppressed so it does not override the
 *      shop entry as "carfax" source.
 *   4. The resulting anchor flows into `triage()` as the dueAtMiles base
 *      (= last.miles + intervalMiles).
 *   5. When shop history has only a date (no mileage), `computeAnchorMiles`
 *      back-fills using `milesPerDay` so the row isn't reported as
 *      "never done".
 */

import { triage, type OEMItem } from "../lib/plan-build/triage";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Plan-build history-merge smoke checks");

const today = new Date("2026-04-28T00:00:00Z");

const oilOemItem: OEMItem = {
  maintenance_id: 1,
  name: "Replace engine oil and filter",
  category: "Engine",
  miles: 10000,
  months: 12,
  intervals: [
    { units: "Miles", value: 10000 },
    { units: "Months", value: 12 },
  ],
  notes: null,
};

// ------------------------------------------------------------------
// Scenario A: shop-history (Protractor / Tekmetric, recent) vs Carfax (older).
// Shop should win, and the dueAtMiles anchor should be the shop mileage.
// ------------------------------------------------------------------
{
  const buckets = triage({
    oemItems: [oilOemItem],
    carfaxRecords: [
      { date: "01/15/2025", odometer: 45000, description: "Engine oil and filter change" },
    ],
    shopServiceHistory: [
      // Most recent: Protractor/Tekmetric work order flattened by route.
      { serviceName: "Replace engine oil and filter", mileage: 58000, date: new Date("2026-02-15T00:00:00Z") },
      // Older shop entry — must lose to the newer one.
      { serviceName: "Engine oil change", mileage: 50000, date: new Date("2025-08-10T00:00:00Z") },
    ],
    currentMiles: 60000,
    today,
    dviFindings: [],
    vehicleYear: 2019,
  });

  const oil = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming]
    .find((t) => t.serviceKey === "oil");

  ok("Scenario A: oil row is present in triaged output", oil != null);
  ok(
    "Scenario A: most recent shop entry is the LastDone winner",
    oil?.last?.source === "shop" && oil?.last?.miles === 58000,
    `last=${JSON.stringify(oil?.last)}`,
  );
  ok(
    "Scenario A: dueAtMiles = last.miles + intervalMiles (58000 + 10000 = 68000)",
    oil?.dueAtMiles === 68000,
    `dueAtMiles=${oil?.dueAtMiles}`,
  );
  ok(
    "Scenario A: oil row lands in upcoming (60k miles, due at 68k)",
    buckets.upcoming.some((t) => t.serviceKey === "oil"),
  );
}

// ------------------------------------------------------------------
// Scenario B: Carfax has the most recent entry, shop history is older.
// Carfax must win, and source is "carfax".
// ------------------------------------------------------------------
{
  const buckets = triage({
    oemItems: [oilOemItem],
    carfaxRecords: [
      { date: "03/01/2026", odometer: 59000, description: "Lube, oil and filter" },
    ],
    shopServiceHistory: [
      { serviceName: "Engine oil change", mileage: 50000, date: new Date("2025-08-10T00:00:00Z") },
    ],
    currentMiles: 60000,
    today,
    dviFindings: [],
    vehicleYear: 2019,
  });

  const oil = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming]
    .find((t) => t.serviceKey === "oil");

  ok("Scenario B: oil row is present", oil != null);
  ok(
    "Scenario B: Carfax wins by recency (source=carfax, miles=59000)",
    oil?.last?.source === "carfax" && oil?.last?.miles === 59000,
    `last=${JSON.stringify(oil?.last)}`,
  );
  ok(
    "Scenario B: dueAtMiles = 59000 + 10000 = 69000",
    oil?.dueAtMiles === 69000,
    `dueAtMiles=${oil?.dueAtMiles}`,
  );
}

// ------------------------------------------------------------------
// Scenario C: Carfax record duplicates a shop entry (same date and same
// mileage). It should be suppressed and the shop entry should remain the
// LastDone winner. This guards the `isMatchingHistory` cross-source
// dedupe.
// ------------------------------------------------------------------
{
  const sharedDate = new Date("2026-02-15T00:00:00Z");
  const buckets = triage({
    oemItems: [oilOemItem],
    carfaxRecords: [
      // Same day, same mileage → must be deduped against the shop entry.
      { date: "2/15/2026", odometer: 58000, description: "Engine oil and filter change" },
    ],
    shopServiceHistory: [
      { serviceName: "Replace engine oil and filter", mileage: 58000, date: sharedDate },
    ],
    currentMiles: 60000,
    today,
    dviFindings: [],
    vehicleYear: 2019,
  });

  const oil = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming]
    .find((t) => t.serviceKey === "oil");

  ok("Scenario C: oil row is present", oil != null);
  ok(
    "Scenario C: shop entry remains the LastDone winner (carfax duplicate suppressed)",
    oil?.last?.source === "shop",
    `last.source=${oil?.last?.source}`,
  );
}

// ------------------------------------------------------------------
// Scenario D: Shop entry has a date but no mileage (Tekmetric WO with
// missing odometer). `computeAnchorMiles` must back-fill the anchor from
// `milesPerDay`, so the row should NOT be flagged as "never done".
// ------------------------------------------------------------------
{
  const lastDate = new Date("2026-01-28T00:00:00Z"); // exactly 90 days before today
  const milesPerDay = 50;
  const buckets = triage({
    oemItems: [oilOemItem],
    carfaxRecords: [],
    shopServiceHistory: [
      { serviceName: "Replace engine oil and filter", mileage: null, date: lastDate },
    ],
    currentMiles: 60000,
    today,
    milesPerDay,
    dviFindings: [],
    vehicleYear: 2019,
  });

  const oil = [...buckets.overdue, ...buckets.dueSoon, ...buckets.upcoming]
    .find((t) => t.serviceKey === "oil");

  ok("Scenario D: oil row is present", oil != null);
  ok(
    "Scenario D: LastDone winner is the shop entry (no carfax candidate)",
    oil?.last?.source === "shop" && oil?.last?.miles == null,
    `last=${JSON.stringify(oil?.last)}`,
  );
  ok(
    "Scenario D: anchor was estimated from milesPerDay (NOT treated as never done)",
    oil?.reason !== "No record of this service being performed.",
    `reason=${oil?.reason}`,
  );
  // anchor = currentMiles - daysSince*milesPerDay = 60000 - 90*50 = 55500
  // dueAtMiles = anchor + 10000 = 65500
  ok(
    "Scenario D: dueAtMiles uses the back-filled anchor (~65500)",
    oil?.dueAtMiles === 65500,
    `dueAtMiles=${oil?.dueAtMiles}`,
  );
}

if (failed === 0) {
  console.log("\nAll plan-build history-merge smoke checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} plan-build history-merge smoke check(s) failed.`);
  process.exit(1);
}
