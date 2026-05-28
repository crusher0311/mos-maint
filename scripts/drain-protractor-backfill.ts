#!/usr/bin/env tsx
/**
 * Protractor Backfill Drain Worker
 *
 * Counterpart to scripts/drain-tekmetric-backfill.ts. Walks every
 * incomplete Protractor shop to completion in one long-running process.
 *
 * Simpler than the Tekmetric drain because runProtractorBackfill(shopId)
 * already self-recurses chunk-by-chunk to completion in a single call,
 * AND it has its own per-shop atomic lock with 30-min stale-lock recovery.
 * That means concurrent cron + drain on the same shop is already safe
 * (the second caller bails with "Already in progress"), so this script
 * does NOT need a global drain lock.
 *
 * Usage:
 *   tsx scripts/drain-protractor-backfill.ts
 *   npm run drain:protractor-backfill
 *
 * Env knobs:
 *   DRAIN_PARALLELISM    (default 3)  shops processed concurrently
 *                                     (lower than Tekmetric's 4: each
 *                                     runProtractorBackfill call holds a
 *                                     pLimit(5) on Protractor's API)
 *   DRAIN_HEARTBEAT_MS   (default 30000) status print cadence
 *   DRAIN_SHOP_IDS       (optional) comma-separated shopIds to limit to
 */

import { getDb } from "@/lib/mongo";
import { runProtractorBackfill } from "@/lib/integrations/protractor/sync";

const PARALLELISM = Math.max(1, Number(process.env.DRAIN_PARALLELISM) || 3);
const HEARTBEAT_MS = Math.max(
  5000,
  Number(process.env.DRAIN_HEARTBEAT_MS) || 30000
);
const SHOP_ID_FILTER = (process.env.DRAIN_SHOP_IDS || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

export type ShopJob = {
  shopId: number;
  name: string;
};

export type ShopOutcome = {
  shopId: number;
  name: string;
  chunksProcessed: number;
  totalJobsIndexed: number;
  finalState:
    | "complete"
    | "incomplete"
    | "error"
    | "stopped"
    | "completed_by_other"
    | "lock_wait_timeout";
  error?: string;
  startedAt: Date;
  endedAt: Date;
};

// Per-shop lock-wait knobs. The Protractor cron (daily 02:00 UTC + Sat/Sun
// boost at :05/:20/:35/:50) calls runProtractorBackfill without singlePass,
// so when it grabs a shop's per-shop lock it can hold it for up to the
// 30-min wall-clock cap inside runProtractorBackfill. The drain script
// therefore needs to be willing to wait that long instead of bailing
// immediately on "Already in progress".
const LOCK_WAIT_POLL_MS = Math.max(
  5000,
  Number(process.env.DRAIN_LOCK_POLL_MS) || 30000
);
const LOCK_WAIT_MAX_MS = Math.max(
  60000,
  Number(process.env.DRAIN_LOCK_WAIT_MAX_MS) || 45 * 60 * 1000
);
// runProtractorBackfill considers a lock stale after 30 min with no
// `lastActivityAt` update. Mirror that here so the drain doesn't try to
// poll past a dead lock indefinitely.
const STALE_LOCK_THRESHOLD_MS = 30 * 60 * 1000;

let stopRequested = false;

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export async function loadIncompleteProtractorShops(
  filterShopIds?: number[]
): Promise<ShopJob[]> {
  const filter =
    filterShopIds && filterShopIds.length > 0 ? filterShopIds : SHOP_ID_FILTER;
  const db = await getDb();
  const shops = await db
    .collection("shops")
    .find({
      $or: [
        { "protractor.connectionId": { $exists: true, $ne: null } },
        { protractorConnectionId: { $exists: true, $ne: null } },
      ],
      protractorBackfillComplete: { $ne: true },
    })
    .toArray();

  const jobs: ShopJob[] = [];
  for (const shop of shops) {
    const shopId = Number(shop.shopId);
    if (filter.length > 0 && !filter.includes(shopId)) continue;

    // Skip shops already marked complete in backfill_progress (defensive —
    // protractorBackfillComplete on the shops doc is the canonical signal,
    // but a progress row with `completed:true` is the same outcome.)
    const progress = await db
      .collection("backfill_progress")
      .findOne({ shopId });
    if (progress?.completed === true) continue;

    jobs.push({
      shopId,
      name: shop.name || shop.locationIdentifier || `Shop ${shopId}`,
    });
  }

  // Sort: shops with the OLDEST cursor (most-behind) first.
  const progressMap = new Map<number, Date | null>();
  const progressDocs = await db
    .collection("backfill_progress")
    .find(
      { shopId: { $in: jobs.map((j) => j.shopId) } },
      { projection: { shopId: 1, currentChunkEnd: 1 } }
    )
    .toArray();
  for (const p of progressDocs) {
    progressMap.set(
      Number(p.shopId),
      p.currentChunkEnd ? new Date(p.currentChunkEnd) : null
    );
  }
  jobs.sort((a, b) => {
    const ad = progressMap.get(a.shopId)?.getTime() ?? Date.now();
    const bd = progressMap.get(b.shopId)?.getTime() ?? Date.now();
    if (ad !== bd) return ad - bd;
    return a.shopId - b.shopId;
  });

  return jobs;
}

function isLockHeldError(err: string | undefined): boolean {
  if (!err) return false;
  return /already in progress/i.test(err);
}

/**
 * Poll `backfill_progress` until either:
 *   - the lock is released (inProgress !== true)            → "ready"
 *   - the lock is stale (no lastActivityAt > 30 min)        → "ready"
 *   - the shop completes on its own (completed === true)    → "completed"
 *   - we hit LOCK_WAIT_MAX_MS                                → "timeout"
 *   - SIGINT/SIGTERM                                          → "stopped"
 */
async function waitForLockOrCompletion(
  shopId: number,
  shouldStop: () => boolean
): Promise<"ready" | "completed" | "timeout" | "stopped"> {
  const db = await getDb();
  const startedAt = Date.now();
  let pollCount = 0;
  while (Date.now() - startedAt < LOCK_WAIT_MAX_MS) {
    if (shouldStop()) return "stopped";
    await new Promise((r) => setTimeout(r, LOCK_WAIT_POLL_MS));
    pollCount++;
    const doc = await db.collection("backfill_progress").findOne({ shopId });
    if (!doc) return "ready"; // no progress doc yet, lock can be acquired
    if (doc.completed === true) return "completed";
    const lastActivityAt = doc.lastActivityAt
      ? new Date(doc.lastActivityAt).getTime()
      : 0;
    const isStale =
      lastActivityAt > 0 &&
      Date.now() - lastActivityAt > STALE_LOCK_THRESHOLD_MS;
    if (doc.inProgress !== true || isStale) return "ready";
    if (pollCount % 4 === 0) {
      const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
      const lockAgeMin = lastActivityAt
        ? ((Date.now() - lastActivityAt) / 60000).toFixed(1)
        : "?";
      log(
        `WAITING shop=${shopId} cron-holds-lock waited=${elapsedMin}min lockAge=${lockAgeMin}min`
      );
    }
  }
  return "timeout";
}

export type DrainProtractorShopChunkOptions = {
  /**
   * Cooperative cancellation. Returns true when the caller wants the
   * per-shop drain to stop at the next safe checkpoint. Defaults to the
   * CLI's module-level SIGINT/SIGTERM flag so the standalone script keeps
   * its existing graceful-stop behavior. The BullMQ processor passes a
   * deadline-based predicate so each queue attempt is bounded.
   */
  shouldStop?: () => boolean;
};

export async function drainProtractorShopChunk(
  job: ShopJob,
  options: DrainProtractorShopChunkOptions = {}
): Promise<ShopOutcome> {
  const shouldStop = options.shouldStop ?? (() => stopRequested);
  const startedAt = new Date();
  log(`START shop=${job.shopId} (${job.name})`);

  let chunksProcessed = 0;
  let totalJobsIndexed = 0;
  let attempt = 0;
  const MAX_ATTEMPTS = 8;

  while (attempt < MAX_ATTEMPTS) {
    if (shouldStop()) {
      return {
        shopId: job.shopId,
        name: job.name,
        chunksProcessed,
        totalJobsIndexed,
        finalState: "stopped",
        startedAt,
        endedAt: new Date(),
      };
    }
    attempt++;

    let result: Awaited<ReturnType<typeof runProtractorBackfill>>;
    try {
      // runProtractorBackfill loops chunks to completion internally.
      // Default mode (no singlePass) self-recurses until the shop is done
      // or hits the 30-min wall-clock cap, whichever comes first.
      result = await runProtractorBackfill(job.shopId);
    } catch (err: any) {
      const msg = err?.message ? String(err.message) : String(err);
      log(`ERROR shop=${job.shopId}: ${msg.slice(0, 200)}`);
      return {
        shopId: job.shopId,
        name: job.name,
        chunksProcessed,
        totalJobsIndexed,
        finalState: "error",
        error: msg.slice(0, 500),
        startedAt,
        endedAt: new Date(),
      };
    }

    chunksProcessed += result.chunksProcessed || 0;
    totalJobsIndexed += result.totalJobsIndexed || 0;

    // Cron is currently holding the per-shop lock. Wait it out instead of
    // bailing — once the cron's chunk run finishes (or times out at 30
    // min), we'll re-attempt and grab the lock ourselves.
    if (result.error && isLockHeldError(result.error)) {
      log(
        `LOCKED shop=${job.shopId} (${job.name}) cron has lock — polling for release (attempt ${attempt}/${MAX_ATTEMPTS})`
      );
      const waitResult = await waitForLockOrCompletion(job.shopId, shouldStop);
      if (waitResult === "completed") {
        log(
          `COMPLETED_BY_OTHER shop=${job.shopId} (${job.name}) — cron finished it while we waited`
        );
        return {
          shopId: job.shopId,
          name: job.name,
          chunksProcessed,
          totalJobsIndexed,
          finalState: "completed_by_other",
          startedAt,
          endedAt: new Date(),
        };
      }
      if (waitResult === "timeout") {
        log(
          `LOCK_WAIT_TIMEOUT shop=${job.shopId} (${job.name}) waited ${(LOCK_WAIT_MAX_MS / 60000).toFixed(0)}min`
        );
        return {
          shopId: job.shopId,
          name: job.name,
          chunksProcessed,
          totalJobsIndexed,
          finalState: "lock_wait_timeout",
          error: "Lock held by other process for full wait window",
          startedAt,
          endedAt: new Date(),
        };
      }
      if (waitResult === "stopped") {
        return {
          shopId: job.shopId,
          name: job.name,
          chunksProcessed,
          totalJobsIndexed,
          finalState: "stopped",
          startedAt,
          endedAt: new Date(),
        };
      }
      // waitResult === "ready" — fall through and retry the loop
      continue;
    }

    // Real error from inside the backfill (not a lock issue).
    if (result.error) {
      log(
        `ERROR shop=${job.shopId} (${job.name}) chunks=${chunksProcessed} jobs=${totalJobsIndexed} err="${String(result.error).slice(0, 200)}"`
      );
      return {
        shopId: job.shopId,
        name: job.name,
        chunksProcessed,
        totalJobsIndexed,
        finalState: "error",
        error: result.error,
        startedAt,
        endedAt: new Date(),
      };
    }

    const finalState: ShopOutcome["finalState"] = result.complete
      ? "complete"
      : "incomplete";
    log(
      `${finalState.toUpperCase()} shop=${job.shopId} (${job.name}) chunks=${chunksProcessed} jobs=${totalJobsIndexed}`
    );
    return {
      shopId: job.shopId,
      name: job.name,
      chunksProcessed,
      totalJobsIndexed,
      finalState,
      startedAt,
      endedAt: new Date(),
    };
  }

  log(
    `MAX_ATTEMPTS shop=${job.shopId} (${job.name}) — gave up after ${MAX_ATTEMPTS} lock-wait cycles`
  );
  return {
    shopId: job.shopId,
    name: job.name,
    chunksProcessed,
    totalJobsIndexed,
    finalState: "lock_wait_timeout",
    error: `Exceeded ${MAX_ATTEMPTS} lock-wait retries`,
    startedAt,
    endedAt: new Date(),
  };
}

async function runWithParallelism<T>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<ShopOutcome>,
  results: ShopOutcome[]
): Promise<void> {
  const queue = [...items];

  async function workerLoop(workerId: number) {
    while (queue.length > 0) {
      if (stopRequested) return;
      const item = queue.shift();
      if (!item) return;
      try {
        const outcome = await fn(item);
        results.push(outcome);
      } catch (err: any) {
        log(
          `WORKER_${workerId} unexpected error: ${err?.message || String(err)}`
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: workers }, (_, i) => workerLoop(i + 1))
  );
}

function startHeartbeat(getStats: () => string): NodeJS.Timeout {
  return setInterval(() => {
    log(`HEARTBEAT ${getStats()}`);
  }, HEARTBEAT_MS);
}

async function main() {
  log("===== Protractor Backfill Drain Worker =====");
  log(
    `parallelism=${PARALLELISM} heartbeatMs=${HEARTBEAT_MS} ` +
      (SHOP_ID_FILTER.length > 0
        ? `shopIdFilter=[${SHOP_ID_FILTER.join(",")}]`
        : "shopIdFilter=ALL_INCOMPLETE")
  );

  process.on("SIGINT", () => {
    log("SIGINT received — finishing in-flight shops then exiting");
    stopRequested = true;
  });
  process.on("SIGTERM", () => {
    log("SIGTERM received — finishing in-flight shops then exiting");
    stopRequested = true;
  });

  const jobs = await loadIncompleteProtractorShops();
  log(`Found ${jobs.length} incomplete Protractor shops to drain`);
  if (jobs.length === 0) {
    log("Nothing to do. Exiting.");
    process.exit(0);
  }

  const outcomes: ShopOutcome[] = [];
  const startedAt = Date.now();
  const heartbeat = startHeartbeat(
    () =>
      `done=${outcomes.length}/${jobs.length} ` +
      `complete=${outcomes.filter((o) => o.finalState === "complete" || o.finalState === "completed_by_other").length} ` +
      `error=${outcomes.filter((o) => o.finalState === "error").length} ` +
      `lockWait=${outcomes.filter((o) => o.finalState === "lock_wait_timeout").length} ` +
      `elapsed=${((Date.now() - startedAt) / 1000 / 60).toFixed(1)}min`
  );

  await runWithParallelism(
    jobs,
    PARALLELISM,
    (job) => drainProtractorShopChunk(job),
    outcomes
  );
  clearInterval(heartbeat);

  const totalJobs = outcomes.reduce((s, o) => s + o.totalJobsIndexed, 0);
  const totalChunks = outcomes.reduce((s, o) => s + o.chunksProcessed, 0);
  const elapsedMin = ((Date.now() - startedAt) / 1000 / 60).toFixed(1);

  log("");
  log("===== DRAIN COMPLETE =====");
  log(`elapsed=${elapsedMin}min chunks=${totalChunks} jobs=${totalJobs}`);
  log(`shops complete (by us):     ${outcomes.filter((o) => o.finalState === "complete").length}`);
  log(`shops complete (by cron):   ${outcomes.filter((o) => o.finalState === "completed_by_other").length}`);
  log(`shops incomplete:           ${outcomes.filter((o) => o.finalState === "incomplete").length}`);
  log(`shops errored:              ${outcomes.filter((o) => o.finalState === "error").length}`);
  log(`shops lock-wait-timeout:    ${outcomes.filter((o) => o.finalState === "lock_wait_timeout").length}`);
  log(`shops stopped:              ${outcomes.filter((o) => o.finalState === "stopped").length}`);

  const errored = outcomes.filter((o) => o.finalState === "error");
  if (errored.length > 0) {
    log("");
    log("Errored shops:");
    for (const o of errored) {
      log(`  shop=${o.shopId} (${o.name}) err="${o.error}"`);
    }
  }

  const incomplete = outcomes.filter((o) => o.finalState === "incomplete");
  if (incomplete.length > 0) {
    log("");
    log("Incomplete shops (hit 30-min wall-clock cap; rerun to continue):");
    for (const o of incomplete) {
      log(`  shop=${o.shopId} (${o.name}) chunks=${o.chunksProcessed} jobs=${o.totalJobsIndexed}`);
    }
  }

  process.exit(errored.length > 0 ? 1 : 0);
}

// Only run the standalone drain loop when invoked directly as a CLI
// (`tsx scripts/drain-protractor-backfill.ts` / `npm run
// drain:protractor-backfill`). When the BullMQ worker imports this module
// for `drainProtractorShopChunk`, argv[1] is the worker entry point, so
// main() stays dormant and never kicks off a competing forever-loop.
const invokedAsCli =
  !!process.argv[1] && /drain-protractor-backfill(\.[cm]?[jt]s)?$/.test(process.argv[1]);

if (invokedAsCli) {
  main().catch((err) => {
    log(`FATAL: ${err?.message || String(err)}`);
    console.error(err);
    process.exit(2);
  });
}
