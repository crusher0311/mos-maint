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
import { runProtractorBackfill } from "@/lib/integrations/protractor-backfill";

const PARALLELISM = Math.max(1, Number(process.env.DRAIN_PARALLELISM) || 3);
const HEARTBEAT_MS = Math.max(
  5000,
  Number(process.env.DRAIN_HEARTBEAT_MS) || 30000
);
const SHOP_ID_FILTER = (process.env.DRAIN_SHOP_IDS || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

type ShopJob = {
  shopId: number;
  name: string;
};

type ShopOutcome = {
  shopId: number;
  name: string;
  chunksProcessed: number;
  totalJobsIndexed: number;
  finalState: "complete" | "incomplete" | "error" | "stopped";
  error?: string;
  startedAt: Date;
  endedAt: Date;
};

let stopRequested = false;

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function loadIncompleteShops(): Promise<ShopJob[]> {
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
    if (SHOP_ID_FILTER.length > 0 && !SHOP_ID_FILTER.includes(shopId)) continue;

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

async function drainShop(job: ShopJob): Promise<ShopOutcome> {
  const startedAt = new Date();
  log(`START shop=${job.shopId} (${job.name})`);

  if (stopRequested) {
    return {
      shopId: job.shopId,
      name: job.name,
      chunksProcessed: 0,
      totalJobsIndexed: 0,
      finalState: "stopped",
      startedAt,
      endedAt: new Date(),
    };
  }

  try {
    // runProtractorBackfill loops chunks to completion internally.
    // Default mode (no singlePass) self-recurses until the shop is done
    // or hits the 30-min wall-clock cap, whichever comes first.
    const result = await runProtractorBackfill(job.shopId);

    const finalState: ShopOutcome["finalState"] = result.error
      ? "error"
      : result.complete
        ? "complete"
        : "incomplete";

    log(
      `${finalState.toUpperCase()} shop=${job.shopId} (${job.name}) ` +
        `chunks=${result.chunksProcessed} jobs=${result.totalJobsIndexed}` +
        (result.error ? ` err="${String(result.error).slice(0, 200)}"` : "")
    );

    return {
      shopId: job.shopId,
      name: job.name,
      chunksProcessed: result.chunksProcessed || 0,
      totalJobsIndexed: result.totalJobsIndexed || 0,
      finalState,
      error: result.error,
      startedAt,
      endedAt: new Date(),
    };
  } catch (err: any) {
    const msg = err?.message ? String(err.message) : String(err);
    log(`ERROR shop=${job.shopId}: ${msg.slice(0, 200)}`);
    return {
      shopId: job.shopId,
      name: job.name,
      chunksProcessed: 0,
      totalJobsIndexed: 0,
      finalState: "error",
      error: msg.slice(0, 500),
      startedAt,
      endedAt: new Date(),
    };
  }
}

async function runWithParallelism<T>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<ShopOutcome>
): Promise<ShopOutcome[]> {
  const queue = [...items];
  const results: ShopOutcome[] = [];

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
  return results;
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

  const jobs = await loadIncompleteShops();
  log(`Found ${jobs.length} incomplete Protractor shops to drain`);
  if (jobs.length === 0) {
    log("Nothing to do. Exiting.");
    process.exit(0);
  }

  let outcomes: ShopOutcome[] = [];
  const startedAt = Date.now();
  const heartbeat = startHeartbeat(
    () =>
      `done=${outcomes.length}/${jobs.length} ` +
      `complete=${outcomes.filter((o) => o.finalState === "complete").length} ` +
      `error=${outcomes.filter((o) => o.finalState === "error").length} ` +
      `elapsed=${((Date.now() - startedAt) / 1000 / 60).toFixed(1)}min`
  );

  outcomes = await runWithParallelism(jobs, PARALLELISM, drainShop);
  clearInterval(heartbeat);

  const totalJobs = outcomes.reduce((s, o) => s + o.totalJobsIndexed, 0);
  const totalChunks = outcomes.reduce((s, o) => s + o.chunksProcessed, 0);
  const elapsedMin = ((Date.now() - startedAt) / 1000 / 60).toFixed(1);

  log("");
  log("===== DRAIN COMPLETE =====");
  log(`elapsed=${elapsedMin}min chunks=${totalChunks} jobs=${totalJobs}`);
  log(`shops complete:   ${outcomes.filter((o) => o.finalState === "complete").length}`);
  log(`shops incomplete: ${outcomes.filter((o) => o.finalState === "incomplete").length}`);
  log(`shops errored:    ${outcomes.filter((o) => o.finalState === "error").length}`);
  log(`shops stopped:    ${outcomes.filter((o) => o.finalState === "stopped").length}`);

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

main().catch((err) => {
  log(`FATAL: ${err?.message || String(err)}`);
  console.error(err);
  process.exit(2);
});
