/**
 * Protractor New-Shop Drain Sweep (task #547)
 *
 * A one-shot "sweep" that finds the recently-onboarded / still-incomplete
 * Protractor shops and drives each one to completion immediately, without
 * waiting on the daily/weekend cron tick. Built for the weekend-onboarding
 * case where several new Protractor shops come online at once and need their
 * history pulled NOW.
 *
 * It deliberately reuses the existing, battle-tested machinery:
 *   - `loadIncompleteProtractorShops` (drain script) for the canonical
 *     "Protractor configured AND backfill not complete" candidate query.
 *   - `drainProtractorShopChunk` (drain script) for the per-shop drive, which
 *     wraps `runProtractorBackfill` and already honors the per-shop in-flight /
 *     stale lock AND the pLimit(5) Protractor rate limiter — so a concurrent
 *     cron tick can never double-run a shop or breach the API ceiling.
 *
 * The ONLY thing this layer adds on top of the drain is:
 *   1. A "recently onboarded" window filter (createdAt within N days), mirroring
 *      the Tekmetric `fastpath=newShops` window so the two providers agree on
 *      what "new shop" means. An explicit shopId override bypasses the window.
 *   2. An outer loop that keeps re-driving a shop that returns `incomplete`
 *      (i.e. hit the 30-min wall-clock cap mid-history) until it reports
 *      complete, hits a hard error, or trips a max-iteration safety cap.
 *
 * This module does NOT depend on the in-process cron scheduler
 * (`ENABLE_INPROCESS_CRON`) — it calls the backfill core directly.
 */

import { listShopsByQuery } from "@/lib/data/repositories/shops";
import {
  loadIncompleteProtractorShops,
  drainProtractorShopChunk,
  type ShopJob,
  type ShopOutcome,
} from "@/scripts/drain-protractor-backfill";

// Shops created within this many days are eligible for the sweep. Mirrors
// Tekmetric's NEW_SHOP_FASTPATH_DAYS (14) so "new shop" means the same window
// across providers. Env-tunable so the weekend window can be widened without a
// redeploy.
export const NEW_SHOP_SWEEP_DAYS = Math.max(
  1,
  Number(process.env.PROTRACTOR_NEW_SHOP_SWEEP_DAYS) || 14,
);

// Each sweep iteration is one `drainProtractorShopChunk` call, which itself
// runs `runProtractorBackfill` to completion or the 30-min wall-clock cap.
// A brand-new shop almost always finishes in a single iteration; this cap is
// the safety net for a shop with many years of dense history so the sweep
// can't loop a single shop forever.
export const MAX_SWEEP_ITERATIONS = Math.max(
  1,
  Number(process.env.PROTRACTOR_NEW_SHOP_SWEEP_MAX_ITERS) || 12,
);

// How many shops to drive concurrently. Kept conservative (each shop's drive
// holds a pLimit(5) on Protractor's API) and matches the drain script's
// default parallelism. The shared per-second behavior is governed by the
// per-shop limiter inside runProtractorBackfill, not here.
export const SWEEP_PARALLELISM = Math.max(
  1,
  Number(process.env.PROTRACTOR_NEW_SHOP_SWEEP_PARALLELISM) || 3,
);

export type SweepFinalState =
  | "complete"
  | "still_pending"
  | "error"
  | "stopped";

export interface SweepShopResult {
  shopId: number;
  name: string;
  finalState: SweepFinalState;
  iterations: number;
  chunksProcessed: number;
  totalJobsIndexed: number;
  error?: string;
  startedAt: Date;
  endedAt: Date;
}

export interface SweepSummary {
  candidateShopIds: number[];
  windowDays: number;
  usedExplicitShopIds: boolean;
  swept: number;
  completed: number;
  stillPending: number;
  errored: number;
  stopped: number;
  totalChunks: number;
  totalJobsIndexed: number;
  durationMs: number;
  perShop: SweepShopResult[];
}

export interface SweepOptions {
  /**
   * Explicit shopId allowlist for targeting just this weekend's shops. When
   * provided, the "recently onboarded" createdAt window is bypassed — the
   * operator is telling us exactly which shops to sweep. The shops are still
   * filtered to those that are actually incomplete (already-complete shops are
   * skipped, so the sweep stays safe to re-run).
   */
  shopIds?: number[];
  /** Override the createdAt window (days). Defaults to NEW_SHOP_SWEEP_DAYS. */
  windowDays?: number;
  /** Max drive iterations per shop. Defaults to MAX_SWEEP_ITERATIONS. */
  maxIterations?: number;
  /** Concurrent shops. Defaults to SWEEP_PARALLELISM. */
  parallelism?: number;
  /** Cooperative cancellation, checked between shops and drive iterations. */
  shouldStop?: () => boolean;
  /** Logger; defaults to a timestamped console.log. */
  log?: (msg: string) => void;
}

function defaultLog(msg: string) {
  console.log(`[${new Date().toISOString()}] [ProtractorNewShopSweep] ${msg}`);
}

/**
 * Resolve the candidate shop list: Protractor-configured + incomplete, scoped
 * to the recently-onboarded window — OR, when an explicit shopId list is given,
 * exactly those shops (still filtered to incomplete).
 */
export async function findNewShopSweepCandidates(
  options: Pick<SweepOptions, "shopIds" | "windowDays"> = {},
): Promise<{ jobs: ShopJob[]; usedExplicitShopIds: boolean; windowDays: number }> {
  const explicit =
    Array.isArray(options.shopIds) && options.shopIds.length > 0
      ? options.shopIds.filter((n) => Number.isFinite(n) && n > 0)
      : [];

  // `loadIncompleteProtractorShops` is the canonical "Protractor configured AND
  // backfill not complete" query (it also skips shops whose backfill_progress
  // row is already `completed: true`). Reusing it keeps the sweep's notion of
  // "incomplete" identical to the drain worker's.
  if (explicit.length > 0) {
    const jobs = await loadIncompleteProtractorShops(explicit);
    return {
      jobs,
      usedExplicitShopIds: true,
      windowDays: options.windowDays ?? NEW_SHOP_SWEEP_DAYS,
    };
  }

  const windowDays = options.windowDays ?? NEW_SHOP_SWEEP_DAYS;
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Mirror the Tekmetric fastpath query: shops created within the window.
  const recentShopIds = new Set<number>(
    (
      await listShopsByQuery({ createdAt: { $gte: cutoff } }, { shopId: 1 })
    ).map((s) => Number(s.shopId)),
  );

  const incomplete = await loadIncompleteProtractorShops();
  const jobs = incomplete.filter((j) => recentShopIds.has(Number(j.shopId)));

  return { jobs, usedExplicitShopIds: false, windowDays };
}

/**
 * Drive a single shop to completion: repeatedly run the per-shop drain (which
 * itself loops chunks via runProtractorBackfill) until the shop reports
 * complete, hits a hard error, trips the max-iteration cap, or is asked to
 * stop. `incomplete` (30-min wall-clock cap) and `ready`-style lock retries are
 * folded back into another iteration so the shop keeps moving.
 */
async function driveShopToCompletion(
  job: ShopJob,
  maxIterations: number,
  shouldStop: () => boolean,
  log: (msg: string) => void,
): Promise<SweepShopResult> {
  const startedAt = new Date();
  let iterations = 0;
  let chunksProcessed = 0;
  let totalJobsIndexed = 0;
  let lastOutcome: ShopOutcome | null = null;

  log(`SHOP_START shop=${job.shopId} (${job.name})`);

  while (iterations < maxIterations) {
    if (shouldStop()) {
      log(`SHOP_STOPPED shop=${job.shopId} (${job.name}) iter=${iterations}`);
      return {
        shopId: job.shopId,
        name: job.name,
        finalState: "stopped",
        iterations,
        chunksProcessed,
        totalJobsIndexed,
        startedAt,
        endedAt: new Date(),
      };
    }
    iterations++;

    const outcome = await drainProtractorShopChunk(job, { shouldStop });
    lastOutcome = outcome;
    chunksProcessed += outcome.chunksProcessed || 0;
    totalJobsIndexed += outcome.totalJobsIndexed || 0;

    log(
      `SHOP_ITER shop=${job.shopId} iter=${iterations} state=${outcome.finalState} ` +
        `chunks=${chunksProcessed} jobs=${totalJobsIndexed}`,
    );

    switch (outcome.finalState) {
      case "complete":
      case "completed_by_other":
        log(
          `SHOP_COMPLETE shop=${job.shopId} (${job.name}) iters=${iterations} ` +
            `chunks=${chunksProcessed} jobs=${totalJobsIndexed}`,
        );
        return {
          shopId: job.shopId,
          name: job.name,
          finalState: "complete",
          iterations,
          chunksProcessed,
          totalJobsIndexed,
          startedAt,
          endedAt: new Date(),
        };
      case "error":
        log(
          `SHOP_ERROR shop=${job.shopId} (${job.name}) err="${outcome.error}"`,
        );
        return {
          shopId: job.shopId,
          name: job.name,
          finalState: "error",
          iterations,
          chunksProcessed,
          totalJobsIndexed,
          error: outcome.error,
          startedAt,
          endedAt: new Date(),
        };
      case "stopped":
        return {
          shopId: job.shopId,
          name: job.name,
          finalState: "stopped",
          iterations,
          chunksProcessed,
          totalJobsIndexed,
          startedAt,
          endedAt: new Date(),
        };
      case "incomplete":
      case "lock_wait_timeout":
        // Wall-clock cap or a lock held by a concurrent cron for the whole
        // wait window. Loop again — the next iteration re-acquires the lock
        // (or waits it out) and continues from the persisted cursor.
        continue;
      default:
        continue;
    }
  }

  log(
    `SHOP_MAX_ITERS shop=${job.shopId} (${job.name}) gave up after ${maxIterations} ` +
      `iterations (last=${lastOutcome?.finalState}) chunks=${chunksProcessed} jobs=${totalJobsIndexed}`,
  );
  return {
    shopId: job.shopId,
    name: job.name,
    finalState: "still_pending",
    iterations,
    chunksProcessed,
    totalJobsIndexed,
    error: `Hit max-iteration cap (${maxIterations}); re-run sweep to continue`,
    startedAt,
    endedAt: new Date(),
  };
}

async function runWithParallelism(
  jobs: ShopJob[],
  parallelism: number,
  worker: (job: ShopJob) => Promise<SweepShopResult>,
  shouldStop: () => boolean,
): Promise<SweepShopResult[]> {
  const queue = [...jobs];
  const results: SweepShopResult[] = [];

  async function loop() {
    while (queue.length > 0) {
      if (shouldStop()) return;
      const job = queue.shift();
      if (!job) return;
      results.push(await worker(job));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(parallelism, jobs.length || 1) }, () => loop()),
  );
  return results;
}

/**
 * The one-shot sweep entry point. Resolves candidates, drives each to
 * completion, and returns a structured summary. Safe to re-run: already-complete
 * shops are filtered out by the candidate query, and the per-shop lock prevents
 * double-running a shop that a concurrent cron is already handling.
 */
export async function sweepNewProtractorShops(
  options: SweepOptions = {},
): Promise<SweepSummary> {
  const log = options.log ?? defaultLog;
  const shouldStop = options.shouldStop ?? (() => false);
  const parallelism = options.parallelism ?? SWEEP_PARALLELISM;
  const maxIterations = options.maxIterations ?? MAX_SWEEP_ITERATIONS;
  const startedAtMs = Date.now();

  const { jobs, usedExplicitShopIds, windowDays } =
    await findNewShopSweepCandidates({
      shopIds: options.shopIds,
      windowDays: options.windowDays,
    });

  log(
    `START candidates=${jobs.length} ` +
      (usedExplicitShopIds
        ? `mode=explicit shopIds=[${jobs.map((j) => j.shopId).join(",")}]`
        : `mode=window windowDays=${windowDays}`) +
      ` parallelism=${parallelism} maxIters=${maxIterations}`,
  );

  if (jobs.length === 0) {
    log("No incomplete recently-onboarded Protractor shops to sweep.");
    return {
      candidateShopIds: [],
      windowDays,
      usedExplicitShopIds,
      swept: 0,
      completed: 0,
      stillPending: 0,
      errored: 0,
      stopped: 0,
      totalChunks: 0,
      totalJobsIndexed: 0,
      durationMs: Date.now() - startedAtMs,
      perShop: [],
    };
  }

  const perShop = await runWithParallelism(
    jobs,
    parallelism,
    (job) => driveShopToCompletion(job, maxIterations, shouldStop, log),
    shouldStop,
  );

  const summary: SweepSummary = {
    candidateShopIds: jobs.map((j) => j.shopId),
    windowDays,
    usedExplicitShopIds,
    swept: perShop.length,
    completed: perShop.filter((r) => r.finalState === "complete").length,
    stillPending: perShop.filter((r) => r.finalState === "still_pending").length,
    errored: perShop.filter((r) => r.finalState === "error").length,
    stopped: perShop.filter((r) => r.finalState === "stopped").length,
    totalChunks: perShop.reduce((n, r) => n + r.chunksProcessed, 0),
    totalJobsIndexed: perShop.reduce((n, r) => n + r.totalJobsIndexed, 0),
    durationMs: Date.now() - startedAtMs,
    perShop,
  };

  log(
    `DONE swept=${summary.swept} complete=${summary.completed} ` +
      `pending=${summary.stillPending} errored=${summary.errored} ` +
      `stopped=${summary.stopped} chunks=${summary.totalChunks} ` +
      `jobs=${summary.totalJobsIndexed} elapsed=${(summary.durationMs / 1000 / 60).toFixed(1)}min`,
  );

  return summary;
}
