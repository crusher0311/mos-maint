/**
 * Resumable-sweep cursor for the Protractor daily sync cron.
 *
 * The sync used to refresh ALL Protractor shops in a single run, which
 * consistently hit the scheduler's 25-min hard abort — the run never recorded
 * a success and shops late in the queue never refreshed. The cron now sweeps
 * shops in rotating batches across runs: each run processes the shops not yet
 * covered in the current cycle, marks each completed shop done, and lets the
 * next run continue. When every configured shop is done the cycle resets and
 * the sweep starts over.
 *
 * Forward-progress safety net: a single pathological "fat" shop that keeps
 * getting killed mid-run (so its `done` mark never persists) must NOT be able
 * to block the cycle from ever resetting — that would freeze fleet-wide
 * refresh. We track a per-shop attempt count and treat a shop that has been
 * attempted `maxAttempts` times this cycle without completing as "exhausted":
 * it is skipped for the rest of the cycle so the cycle can reset and every
 * other shop keeps refreshing. The exhausted shop gets a fresh chance on the
 * next cycle (attempts reset on reset).
 *
 * This module holds ONLY the pure cursor math so it can be unit-tested without
 * a live Mongo/Protractor connection.
 */

export interface SweepPlan {
  /** True when the previous cycle was complete and a fresh sweep just began. */
  cycleReset: boolean;
  /** Shops already swept this cycle (empty immediately after a reset). */
  doneShopIds: number[];
  /** Shops still to sweep this cycle — the work for the current run. */
  remainingShopIds: number[];
  /**
   * Shops skipped this cycle because they hit the attempt cap without
   * completing (empty after a reset). Surfaced for observability.
   */
  exhaustedShopIds: number[];
}

/**
 * Decide which shops a run should sweep.
 *
 * @param allShopIds       Every currently-configured Protractor shop id.
 * @param priorDoneShopIds Shops marked done in the persisted progress doc.
 * @param attemptsByShop   Per-shop attempt counts this cycle (keyed by shop id).
 * @param maxAttempts      Attempts before a non-completing shop is exhausted.
 */
export function computeSweepPlan(
  allShopIds: number[],
  priorDoneShopIds: number[],
  attemptsByShop: Record<string, number> = {},
  maxAttempts = 3
): SweepPlan {
  const allSet = new Set(allShopIds);

  // Drop ids that are no longer configured (a shop can be removed mid-cycle).
  let doneShopIds = priorDoneShopIds.filter((id) => allSet.has(id));
  const doneSet = new Set(doneShopIds);

  // A shop attempted maxAttempts times this cycle without ever being marked
  // done is "exhausted" — skip it so one pathological shop can't block the
  // cycle from resetting (which would stall fleet-wide refresh).
  const exhaustedShopIds = allShopIds.filter(
    (id) => !doneSet.has(id) && (attemptsByShop[String(id)] || 0) >= maxAttempts
  );
  const exhaustedSet = new Set(exhaustedShopIds);

  // The cycle is complete when every configured shop is either done or
  // exhausted — then start a fresh sweep.
  let cycleReset = false;
  if (
    allShopIds.length > 0 &&
    allShopIds.every((id) => doneSet.has(id) || exhaustedSet.has(id))
  ) {
    doneShopIds = [];
    cycleReset = true;
  }

  const remainingShopIds = cycleReset
    ? [...allShopIds]
    : allShopIds.filter((id) => !doneSet.has(id) && !exhaustedSet.has(id));

  return {
    cycleReset,
    doneShopIds,
    remainingShopIds,
    exhaustedShopIds: cycleReset ? [] : exhaustedShopIds,
  };
}
