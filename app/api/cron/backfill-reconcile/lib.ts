/**
 * Pure helpers for the backfill reconcile cron. No DB, no network — extracted
 * so the date-semantics contract can be unit-tested (see
 * tests/backfill-reconcile-date-fields.smoke.ts).
 *
 * THE DATE-FIELD CONTRACT (why this file exists):
 * Reconcile compares a LOCAL count against an UPSTREAM sample for the same
 * 30-day window. Both sides MUST filter by the same date semantics or the
 * comparison is meaningless. The original Tekmetric implementation filtered
 * upstream by `updatedDateStart/End` while counting local `job_index` rows by
 * `closedAt` — so an RO closed years ago but touched (updated) recently showed
 * up in the upstream sample of the recent window while our local row (keyed by
 * its old close date) did not. That false gap re-opened completed shops.
 *
 * Fix: sample upstream by `postedDateStart/End`. Local `closedAt` is written
 * as `postedDate || completedDate || updatedDate` (full-page backfill), so
 * postedDate is the like-for-like upstream filter. The completedDate /
 * updatedDate fallbacks drift slightly for the rare RO with no postedDate,
 * which the directional shortfall + tolerance absorbs.
 */

export const DELTA_TOLERANCE = 0.1;

/**
 * Upstream Tekmetric `/repair-orders` sample params for a reconcile window.
 * MUST filter by posted date (not updated date) — see contract above.
 */
export function buildTekmetricUpstreamParams(
  tekmetricShopId: number,
  startIso: string,
  endIso: string
): URLSearchParams {
  return new URLSearchParams({
    shop: String(tekmetricShopId),
    page: "0",
    size: "1",
    postedDateStart: startIso,
    postedDateEnd: endIso,
  });
}

/**
 * Local `job_index` filter matching the upstream posted-date sample.
 *
 * Tekmetric job_index rows come in two shapes:
 *  - full-page backfill rows: `closedAt` is an ISO STRING
 *    (`postedDate || completedDate || updatedDate`) — direct match.
 *  - webhook/poll rows (indexTekmetricWorkOrderJobs): no `closedAt`; they
 *    carry `performedAt` as a DATE (`completedDate || updatedDate ||
 *    createdDate`) — near-identical close semantics.
 *
 * Mongo comparisons are typed, so a string range never matches a Date value
 * (and vice versa). Count BOTH shapes with an $or or rows from one indexing
 * path silently read as missing and fake a shortfall.
 */
export function buildTekmetricLocalQuery(
  shopId: number,
  startIso: string,
  endIso: string
): Record<string, any> {
  return {
    shopId,
    sourceSystem: "tekmetric",
    $or: [
      { closedAt: { $gte: startIso, $lte: endIso } },
      { performedAt: { $gte: new Date(startIso), $lte: new Date(endIso) } },
    ],
  };
}

/**
 * Protractor day-granularity bounds. Upstream `/Invoice?startDate=&endDate=`
 * filters by whole days (inclusive), so the local `performedAt` (Date) count
 * must span the SAME inclusive day window — 00:00:00.000Z on the start day
 * through 23:59:59.999Z on the end day. Using raw window timestamps (which
 * carry a random time-of-day) would shave a partial day off each edge.
 */
export function protractorDayBounds(
  startDay: string,
  endDay: string
): { lowerBound: Date; upperBound: Date } {
  return {
    lowerBound: new Date(`${startDay}T00:00:00.000Z`),
    upperBound: new Date(`${endDay}T23:59:59.999Z`),
  };
}

/**
 * Directional shortfall: only "we have FEWER than upstream" is a gap a
 * re-pull can fix. Overcount yields 0 — re-pulling can't remove records, and
 * benign over/under drift from fallback date fields must never re-queue an
 * already-complete shop. Zero upstream ⇒ zero delta (nothing to be short of).
 */
export function computeShortfallDelta(upstreamTotal: number, ourCount: number): number {
  return upstreamTotal === 0 ? 0 : Math.max(0, upstreamTotal - ourCount) / upstreamTotal;
}

/**
 * Zero-count guard: if we matched ZERO stored records in *every* sampled
 * window, the count query is almost certainly misreading (wrong field/type)
 * rather than the shop having genuinely lost all of its history. Refuse to
 * re-queue; just flag for visibility.
 */
export function sawAnyStoredData(audits: Array<{ ours?: number }>): boolean {
  return audits.some((a) => typeof a.ours === "number" && a.ours > 0);
}

/**
 * Final re-queue decision for a shop given its sampled window deltas.
 * Requeue only when at least one window shows a shortfall beyond tolerance
 * AND the zero-count guard didn't trip.
 */
export function decideRequeue(
  audits: Array<{ ours?: number; delta?: number }>
): { shouldRequeue: boolean; zeroCountGuardTripped: boolean } {
  const anyBreach = audits.some(
    (a) => typeof a.delta === "number" && a.delta > DELTA_TOLERANCE
  );
  const hasStoredData = sawAnyStoredData(audits);
  return {
    shouldRequeue: anyBreach && hasStoredData,
    zeroCountGuardTripped: anyBreach && !hasStoredData,
  };
}
