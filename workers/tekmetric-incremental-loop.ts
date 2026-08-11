/**
 * Worker-side Tekmetric incremental sync loop (task #1079).
 *
 * Option B for getting Tekmetric background sync off the web instance:
 * when `TEKMETRIC_INCREMENTAL_ON_WORKER=true`, the background worker
 * service runs the bounded incremental cycle on its own timer and the
 * web scheduler skips registering the `tekmetric-incremental-sync` cron
 * (see lib/cron/scheduler.cjs). One shared env var flips both sides, so
 * there is no window where the cycle runs twice or nowhere — as long as
 * the worker's power schedule has a daytime exception (the workers
 * normally auto-suspend weekday daytime; the incremental tick is bounded
 * to ~90s and must keep running during business hours).
 *
 * The loop is deliberately independent of BullMQ/Redis: it starts even
 * when REDIS_URL is unset, so the flag works on a worker that only does
 * cron-style work.
 *
 * Cadence: `TEKMETRIC_INCREMENTAL_WORKER_INTERVAL_MS` (default 30 min,
 * matching the web cron's `*​/30` schedule). Ticks are serialized — the
 * next timer is armed only after the current cycle returns, and
 * `runIncrementalSyncCycle` has its own in-process overlap guard.
 */

import { runWithTekmetricPriority, runWithTekmetricApiCallTracking } from "@/lib/integrations/tekmetric/client";
import {
  runIncrementalSyncCycle,
  ensureCacheIndexes,
} from "@/lib/integrations/tekmetric/incremental-sync";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

export function isIncrementalOnWorker(): boolean {
  return process.env.TEKMETRIC_INCREMENTAL_ON_WORKER === "true";
}

function intervalMs(): number {
  const v = parseInt(process.env.TEKMETRIC_INCREMENTAL_WORKER_INTERVAL_MS || "", 10);
  return Number.isFinite(v) && v >= 60_000 ? v : DEFAULT_INTERVAL_MS;
}

let started = false;
let stopped = false;
let timer: NodeJS.Timeout | null = null;

async function runOneTick(): Promise<void> {
  if (process.env.DISABLE_TEKMETRIC_SYNC === "true") {
    console.log("[Worker IncrementalSync] DISABLE_TEKMETRIC_SYNC=true — tick skipped");
    return;
  }
  await runWithTekmetricPriority("background", () =>
    runWithTekmetricApiCallTracking(async (apiCallCounter) => {
      try {
        await ensureCacheIndexes();
        const { results, duration, skippedOverlap, deadlineHit, shopsDeferred } =
          await runIncrementalSyncCycle({ asWorkerOwner: true });
        if (skippedOverlap) {
          console.log("[Worker IncrementalSync] Previous cycle still running — tick skipped");
          return;
        }
        const sum = (f: (r: (typeof results)[number]) => number) =>
          results.reduce((s, r) => s + f(r), 0);
        const totalSynced = sum((r) => r.synced);
        const totalRemoved = sum((r) => r.removed);
        const cacheV = sum((r) => r.fromCache.vehicles);
        const cacheC = sum((r) => r.fromCache.customers);
        const negV = sum((r) => r.negativeCacheHits?.vehicles ?? 0);
        const negC = sum((r) => r.negativeCacheHits?.customers ?? 0);
        const liveV = sum((r) => r.liveFetches?.vehicles ?? 0);
        const liveC = sum((r) => r.liveFetches?.customers ?? 0);
        const pagesQueued = sum((r) => r.pagesQueued);
        const errors = results.filter((r) => r.error).length;
        const skipped = results.filter((r) => r.skipped).length;
        const negTotal = negV + negC;
        const lookupTotal = negTotal + liveV + liveC + cacheV + cacheC;
        const negRatePct = lookupTotal > 0 ? Math.round((negTotal / lookupTotal) * 100) : 0;
        console.log(
          `[Worker IncrementalSync] cycle completed in ${duration}ms — API calls: ${apiCallCounter.count}: ` +
            `${totalSynced} synced, ${totalRemoved} removed, ${cacheV}/${cacheC} from cache, ` +
            `negative-cache hits ${negV}/${negC} (${negRatePct}% of ${lookupTotal} lookups), ` +
            `${liveV}/${liveC} live fetches, ${pagesQueued} pages queued, ${errors} errors, ${skipped} skipped` +
            (deadlineHit ? `, DEADLINE HIT (${shopsDeferred} shops deferred)` : ""),
        );
      } catch (err: any) {
        console.error(
          `[Worker IncrementalSync] cycle error (API calls made: ${apiCallCounter.count}):`,
          err?.message || err,
        );
      }
    }),
  );
}

export function startTekmetricIncrementalLoop(): boolean {
  if (!isIncrementalOnWorker()) return false;
  if (started) return true;
  started = true;
  const interval = intervalMs();
  console.log(
    `[Worker IncrementalSync] TEKMETRIC_INCREMENTAL_ON_WORKER=true — running incremental sync on the worker every ${Math.round(interval / 60000)}min (web cron skips it)`,
  );
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runOneTick().catch(() => {});
      arm();
    }, interval);
    // Don't keep the process alive solely for this timer if BullMQ workers
    // shut down; the worker entrypoint controls process lifetime.
    timer.unref?.();
  };
  // First tick shortly after boot so a deploy doesn't add a full interval
  // of staleness on top of the deploy itself.
  timer = setTimeout(async () => {
    await runOneTick().catch(() => {});
    arm();
  }, 15_000);
  timer.unref?.();
  return true;
}

export function stopTekmetricIncrementalLoop(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
