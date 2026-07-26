/**
 * Task #872 regression tests: stale RO odometers must not read as "Current".
 *
 * Rule (amends Task #476's "most-recent RO wins"): when the winning RO
 * odometer's RO date is older than RO_ODOMETER_FRESHNESS_DAYS (90), the
 * CARFAX rolling estimate is also computed and the LARGER of the two wins
 * (monotonic — a real reading is a floor, never undercut). When the
 * estimate wins, provenance is `carfax_estimated`.
 *
 * Covers the pure helpers shared by all three surfaces (partner GET,
 * partner analyze POST, extension plan route):
 *   - isRoOdometerStale
 *   - pickMileageInput's staleActual flag
 *   - reconcileStaleActualWithEstimate
 *
 * Run: `npx tsx tests/vhi-mileage-freshness-task-872.smoke.ts`
 */

import {
  RO_ODOMETER_FRESHNESS_DAYS,
  isRoOdometerStale,
  pickMileageInput,
  reconcileStaleActualWithEstimate,
  type OpenRoMileageResult,
} from "../lib/plan-build/open-ro-mileage";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-07-14T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

function roLookup(miles: number, roDate: Date | null): OpenRoMileageResult {
  return {
    miles,
    integration: "tekmetric",
    roIdentifier: "36709",
    roDate,
  } as OpenRoMileageResult;
}

console.log("Task #872 mileage-freshness smoke checks");

// ---------------------------------------------------------------------
// isRoOdometerStale
// ---------------------------------------------------------------------
ok("freshness window is 90 days", RO_ODOMETER_FRESHNESS_DAYS === 90);
ok("30-day-old RO date is fresh", isRoOdometerStale(daysAgo(30), NOW) === false);
ok("89-day-old RO date is fresh", isRoOdometerStale(daysAgo(89), NOW) === false);
ok("91-day-old RO date is stale", isRoOdometerStale(daysAgo(91), NOW) === true);
ok("8-month-old RO date is stale", isRoOdometerStale(daysAgo(240), NOW) === true);
ok("missing RO date treated as fresh (null)", isRoOdometerStale(null, NOW) === false);
ok("missing RO date treated as fresh (undefined)", isRoOdometerStale(undefined, NOW) === false);
ok("invalid RO date treated as fresh", isRoOdometerStale("not-a-date", NOW) === false);
ok("ISO-string RO date accepted", isRoOdometerStale(daysAgo(120).toISOString(), NOW) === true);

// ---------------------------------------------------------------------
// pickMileageInput.staleActual
// ---------------------------------------------------------------------
{
  const picked = pickMileageInput({
    vehicleDocMileage: null,
    openRoLookup: roLookup(112000, daysAgo(240)),
    now: NOW,
  });
  ok("stale RO win flags staleActual", picked.staleActual === true);
  ok("stale RO still returns its miles", picked.miles === 112000);
  ok("stale RO keeps open_ro label pre-reconcile", picked.mileageInputSource === "open_ro");
}
{
  const picked = pickMileageInput({
    vehicleDocMileage: null,
    openRoLookup: roLookup(112000, daysAgo(10)),
    now: NOW,
  });
  ok("fresh RO win does not flag staleActual", picked.staleActual === false);
}
{
  const picked = pickMileageInput({
    vehicleDocMileage: null,
    openRoLookup: roLookup(112000, null),
    now: NOW,
  });
  ok("RO with unknown date treated as fresh (roNumber path / legacy mirrors)", picked.staleActual === false);
}
{
  // vehicles snapshot wins (larger) — snapshot has no per-record date so
  // staleActual must stay false even when the losing RO is old.
  const picked = pickMileageInput({
    vehicleDocMileage: 120000,
    openRoLookup: roLookup(112000, daysAgo(240)),
    now: NOW,
  });
  ok("vehicles_collection win never flags staleActual", picked.staleActual === false && picked.mileageInputSource === "vehicles_collection");
}
{
  const picked = pickMileageInput({ vehicleDocMileage: null, openRoLookup: null, now: NOW });
  ok("no reading: staleActual false, miles null", picked.staleActual === false && picked.miles === null);
}

// ---------------------------------------------------------------------
// reconcileStaleActualWithEstimate
// ---------------------------------------------------------------------
{
  // The HEART Evanston Lexus case: 8-month-old RO reading, higher estimate.
  const r = reconcileStaleActualWithEstimate({
    actualMiles: 112000,
    actualSource: "open_ro",
    estimateMiles: 118400,
  });
  ok("estimate > stale actual: estimate wins", r.estimateWon === true && r.miles === 118400);
  ok("estimate win relabels carfax_estimated", r.mileageInputSource === "carfax_estimated");
}
{
  const r = reconcileStaleActualWithEstimate({
    actualMiles: 112000,
    actualSource: "open_ro",
    estimateMiles: 108000,
  });
  ok("estimate < stale actual: monotonic guard keeps actual", r.estimateWon === false && r.miles === 112000);
  ok("actual retains its original label", r.mileageInputSource === "open_ro");
}
{
  const r = reconcileStaleActualWithEstimate({
    actualMiles: 112000,
    actualSource: "open_ro",
    estimateMiles: 112000,
  });
  ok("estimate == stale actual: actual wins (no pointless relabel)", r.estimateWon === false && r.mileageInputSource === "open_ro");
}
{
  const r = reconcileStaleActualWithEstimate({
    actualMiles: 112000,
    actualSource: "open_ro",
    estimateMiles: null,
  });
  ok("no estimate available: stale actual is still served", r.estimateWon === false && r.miles === 112000);
}
{
  // No-actual path (routes reuse the same helper when mileage was missing).
  const r = reconcileStaleActualWithEstimate({
    actualMiles: null,
    actualSource: null,
    estimateMiles: 118400,
  });
  ok("no actual: estimate adopted as carfax_estimated", r.estimateWon === true && r.miles === 118400 && r.mileageInputSource === "carfax_estimated");
}
{
  const r = reconcileStaleActualWithEstimate({
    actualMiles: null,
    actualSource: null,
    estimateMiles: null,
  });
  ok("nothing available: nulls out cleanly", r.miles === null && r.mileageInputSource === null && r.estimateWon === false);
}
{
  const r = reconcileStaleActualWithEstimate({
    actualMiles: 112000,
    actualSource: "open_ro",
    estimateMiles: 0,
  });
  ok("zero estimate treated as no estimate (sentinel guard)", r.estimateWon === false && r.miles === 112000);
}

// ---------------------------------------------------------------------
// Task #943: no-estimate forward projection of a stale reading
// ---------------------------------------------------------------------
{
  // The HEART Evanston Lexus case: stale RO reading (~6 months old), CARFAX
  // estimate unavailable (empty serviceHistory) → project forward at the
  // default annual rate, labeled estimated.
  const r = reconcileStaleActualWithEstimate({
    actualMiles: 82258,
    actualSource: "open_ro",
    estimateMiles: null,
    staleReadingDate: daysAgo(180),
    now: NOW,
  });
  const expected = Math.round(82258 + 180 * (12000 / 365));
  ok("no estimate + stale date: projection wins", r.projectionWon === true && r.miles === expected, `got ${r.miles}, expected ${expected}`);
  ok("projection labeled annual_estimated", r.mileageInputSource === "annual_estimated");
  ok("projection never below the stale reading (monotonic)", (r.miles ?? 0) > 82258);
  ok("projection carries estimate details", !!r.projectionDetails && (r.projectionDetails as any).method === "stale_reading_forward_projection" && (r.projectionDetails as any).baseMiles === 82258);
}
{
  // Low estimate (below the stale reading) — projection still applies so the
  // stale reading is never presented as current.
  const r = reconcileStaleActualWithEstimate({
    actualMiles: 112000,
    actualSource: "open_ro",
    estimateMiles: 108000,
    staleReadingDate: daysAgo(240),
    now: NOW,
  });
  ok("low estimate: projection wins over both", r.projectionWon === true && (r.miles ?? 0) > 112000);
  ok("low-estimate projection labeled annual_estimated", r.mileageInputSource === "annual_estimated");
}
{
  // Higher estimate still wins over the projection path.
  const r = reconcileStaleActualWithEstimate({
    actualMiles: 112000,
    actualSource: "open_ro",
    estimateMiles: 118400,
    staleReadingDate: daysAgo(240),
    now: NOW,
  });
  ok("higher estimate still beats projection", r.estimateWon === true && r.projectionWon === false && r.miles === 118400);
}
{
  // No stale date → legacy behavior: stale actual retained with its label.
  const r = reconcileStaleActualWithEstimate({
    actualMiles: 112000,
    actualSource: "open_ro",
    estimateMiles: null,
    staleReadingDate: null,
    now: NOW,
  });
  ok("no date to project from: stale actual retained", r.projectionWon === false && r.miles === 112000 && r.mileageInputSource === "open_ro");
}
{
  // Invalid / future dates never project.
  const bad = reconcileStaleActualWithEstimate({
    actualMiles: 112000,
    actualSource: "open_ro",
    estimateMiles: null,
    staleReadingDate: "not-a-date",
    now: NOW,
  });
  ok("invalid date: no projection", bad.projectionWon === false && bad.miles === 112000);
  const future = reconcileStaleActualWithEstimate({
    actualMiles: 112000,
    actualSource: "open_ro",
    estimateMiles: null,
    staleReadingDate: new Date(NOW.getTime() + DAY_MS),
    now: NOW,
  });
  ok("future date: no projection", future.projectionWon === false && future.miles === 112000);
}
{
  // ISO-string dates accepted (Mongo often hands back strings).
  const r = reconcileStaleActualWithEstimate({
    actualMiles: 82258,
    actualSource: "open_ro",
    estimateMiles: null,
    staleReadingDate: daysAgo(180).toISOString(),
    now: NOW,
  });
  ok("ISO-string stale date projects", r.projectionWon === true && (r.miles ?? 0) > 82258);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll Task #872 checks passed");
