#!/usr/bin/env tsx
/**
 * Tekmetric Backfill Drain Worker (Tier 3 "nuclear" option)
 *
 * Bypasses the cron HTTP endpoint entirely. Imports backfillShopChunk from
 * the route module and calls it in-process, looping each shop until its
 * backfill is complete. No 300s maxDuration ceiling, no per-tick chunk
 * budget, no shop rotation. Designed to drain all incomplete Tekmetric
 * shops in one continuous run.
 *
 * Usage (Render Shell, Pro tier recommended):
 *   tsx scripts/drain-tekmetric-backfill.ts
 *
 * Env knobs:
 *   DRAIN_PARALLELISM         (default 4)  shops processed concurrently
 *   DRAIN_MAX_CHUNKS_PER_SHOP (default 200) safety cap per shop
 *   DRAIN_HEARTBEAT_MS        (default 30000) status print cadence
 *   DRAIN_SHOP_IDS            (optional) comma-separated shopIds to limit to
 *
 * Safe to run alongside the existing cron (uses same Mongo progress
 * collection with upsert; chunk function is idempotent on RO content
 * hash).
 *
 * Stopping (two-stage):
 *   1. First SIGINT/SIGTERM — sets `stopRequested=true` and gives the
 *      in-flight chunks up to DRAIN_GRACEFUL_STOP_MS (default 30s) to
 *      return on their own. Workers won't pick up new shops.
 *   2. Second SIGINT (Ctrl-C twice) OR the 30s grace expires — calls
 *      `controller.abort()` on every per-worker AbortController. The
 *      signal is propagated into `backfillShopChunk` via
 *      `runWithTekmetricAbortSignal`, so every in-flight Tekmetric
 *      `fetch` rejects with AbortError, the chunk function throws, the
 *      worker's catch block returns "stopped", and the script exits
 *      within ~5s. Lease release runs in the main `finally` regardless.
 *
 * This two-stage stop exists because chunks can take 100+ minutes on
 * slow shops — without hard-cancel the script was effectively
 * un-killable (had to close the Render shell tab). See task #415.
 */

import { getDb } from "@/lib/mongo";
import { backfillShopChunk } from "@/app/api/cron/tekmetric-backfill/route";

const PARALLELISM = Math.max(1, Number(process.env.DRAIN_PARALLELISM) || 4);
const MAX_CHUNKS_PER_SHOP = Math.max(
  10,
  Number(process.env.DRAIN_MAX_CHUNKS_PER_SHOP) || 200
);
const HEARTBEAT_MS = Math.max(
  5000,
  Number(process.env.DRAIN_HEARTBEAT_MS) || 30000
);
const SHOP_ID_FILTER = (process.env.DRAIN_SHOP_IDS || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
// Grace period between first SIGINT (set stopRequested) and the
// hard-cancel that aborts every in-flight chunk's HTTP requests. A
// second SIGINT skips this wait and aborts immediately. Tunable for
// tests / unusual workloads.
const GRACEFUL_STOP_MS = Math.max(
  1000,
  Number(process.env.DRAIN_GRACEFUL_STOP_MS) || 30_000,
);
// Final hard exit if the abort+lease-release cleanup itself hangs. The
// AbortError path should let the script exit within ~5s; this is the
// last-resort hammer.
const HARD_EXIT_AFTER_ABORT_MS = Math.max(
  5000,
  Number(process.env.DRAIN_HARD_EXIT_MS) || 15_000,
);

// Lease TTL — the cron checks `tekmetric_drain_lock`'s `expiresAt`. We
// refresh it well before expiry so a healthy drain holds the lock
// indefinitely, but a crashed/killed drain auto-releases within
// LOCK_TTL_MS so the cron can resume on its own.
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_REFRESH_MS = 60 * 1000; // refresh every 60s
const LOCK_OWNER = `drain-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type ShopJob = {
  shopId: number;
  name: string;
  tekmetricShopId: number;
};

type ShopOutcome = {
  shopId: number;
  name: string;
  chunksRun: number;
  jobsIndexed: number;
  skipped: number;
  finalState: "complete" | "max-chunks" | "error" | "stopped";
  error?: string;
  startedAt: Date;
  endedAt: Date;
};

let stopRequested = false;
let hardCancelRequested = false;
let sigintCount = 0;
let gracefulStopTimer: NodeJS.Timeout | null = null;
let hardExitTimer: NodeJS.Timeout | null = null;
// Per-worker AbortController registry. Each worker creates one and
// re-uses it across every chunk it runs. On hard-cancel we walk this
// array and call `abort()` on each, which propagates into every
// in-flight Tekmetric `fetch` via runWithTekmetricAbortSignal.
const workerControllers: AbortController[] = [];

function triggerHardCancel(reason: string): void {
  if (hardCancelRequested) return;
  hardCancelRequested = true;
  stopRequested = true;
  log(`HARD-CANCEL ${reason}; aborting ${workerControllers.length} in-flight chunk(s)`);
  for (const c of workerControllers) {
    try {
      c.abort();
    } catch {}
  }
  // Insurance: if abort+cleanup doesn't unwind within
  // HARD_EXIT_AFTER_ABORT_MS, force-exit. The lease TTL means a missed
  // release self-heals on the cron's next pass.
  if (!hardExitTimer) {
    hardExitTimer = setTimeout(() => {
      log(`FORCE-EXIT cleanup did not finish within ${HARD_EXIT_AFTER_ABORT_MS}ms; exiting now`);
      process.exit(130);
    }, HARD_EXIT_AFTER_ABORT_MS);
    // Don't keep the event loop alive just for this timer.
    if (typeof hardExitTimer.unref === "function") hardExitTimer.unref();
  }
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function acquireDrainLock(): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  // Atomic acquire: succeed if no doc exists, OR if existing lease is
  // expired, OR if we already own it (defensive — same owner re-acquiring
  // shouldn't fail). Anything else (a fresh, valid lease owned by another
  // worker) means we refuse to start.
  const result = await db.collection("tekmetric_drain_lock").findOneAndUpdate(
    {
      _id: "global" as any,
      $or: [
        { expiresAt: { $lte: now } },
        { expiresAt: { $exists: false } },
        { owner: LOCK_OWNER },
      ],
    },
    {
      $set: {
        owner: LOCK_OWNER,
        acquiredAt: now,
        expiresAt,
        lastRefreshAt: now,
      },
    },
    { upsert: true, returnDocument: "after" }
  );

  // findOneAndUpdate with upsert+filter that doesn't match throws E11000
  // on the upsert attempt; the catch below surfaces it as a clear error.
  if (!result || (result as any).value === null) {
    // Re-read to find out who has it
    const existing = await db
      .collection("tekmetric_drain_lock")
      .findOne({ _id: "global" as any });
    throw new Error(
      `Could not acquire drain lock — held by owner=${existing?.owner} until ${existing?.expiresAt}`
    );
  }
  log(`Lock acquired owner=${LOCK_OWNER} expiresAt=${expiresAt.toISOString()}`);
}

async function refreshDrainLock(): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  const result = await db
    .collection("tekmetric_drain_lock")
    .updateOne(
      { _id: "global" as any, owner: LOCK_OWNER },
      { $set: { expiresAt, lastRefreshAt: now } }
    );
  if (result.matchedCount === 0) {
    log(
      `WARN lock refresh failed — we no longer own the lock. Stopping after in-flight chunks.`
    );
    stopRequested = true;
  }
}

async function releaseDrainLock(): Promise<void> {
  try {
    const db = await getDb();
    const result = await db
      .collection("tekmetric_drain_lock")
      .deleteOne({ _id: "global" as any, owner: LOCK_OWNER });
    log(`Lock released (deletedCount=${result.deletedCount})`);
  } catch (err: any) {
    log(`WARN failed to release lock: ${err?.message || String(err)}`);
  }
}

async function loadIncompleteShops(): Promise<ShopJob[]> {
  const db = await getDb();
  const shops = await db
    .collection("shops")
    .find({
      $or: [
        { "tekmetric.shopId": { $exists: true, $ne: null } },
        { tekmetricShopId: { $exists: true, $ne: null } },
      ],
      tekmetricBackfillComplete: { $ne: true },
    })
    .toArray();

  const jobs: ShopJob[] = [];
  for (const shop of shops) {
    const shopId = Number(shop.shopId);
    const tekmetricShopId =
      shop.tekmetric?.shopId ?? shop.tekmetricShopId ?? null;
    if (!tekmetricShopId) continue;
    if (SHOP_ID_FILTER.length > 0 && !SHOP_ID_FILTER.includes(shopId)) continue;

    const progress = await db
      .collection("tekmetric_backfill_progress")
      .findOne({ shopId });
    if (progress?.completed === true && progress?.logicVersion === 2) continue;
    // Skip shops in full-page reindex mode — the per-RO chunker no-ops for
    // them (returns complete=false with "deferred to full-page worker"), so
    // including them here just burns MAX_CHUNKS_PER_SHOP iterations doing
    // nothing per pass. Full-page work runs out of the web service's
    // in-process cron via /api/cron/tekmetric-fullpage-backfill.
    if (progress?.fullPageMode === true && progress?.completed !== true) {
      continue;
    }

    jobs.push({
      shopId,
      name: shop.name || shop.locationIdentifier || `Shop ${shopId}`,
      tekmetricShopId: Number(tekmetricShopId),
    });
  }

  // Sort: shops with the OLDEST cursor (most-behind) first so the longest
  // tail starts immediately rather than queuing behind near-done shops.
  // Falls back to shopId for stable ordering.
  const progressMap = new Map<number, Date | null>();
  const progressDocs = await db
    .collection("tekmetric_backfill_progress")
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
    if (ad !== bd) return ad - bd; // oldest cursor (smallest ts) first
    return a.shopId - b.shopId;
  });

  return jobs;
}

async function drainShop(job: ShopJob, signal: AbortSignal): Promise<ShopOutcome> {
  const db = await getDb();
  const startedAt = new Date();
  let chunksRun = 0;
  let jobsIndexed = 0;
  let skipped = 0;

  log(
    `START shop=${job.shopId} (${job.name}) tek=${job.tekmetricShopId}`
  );

  while (chunksRun < MAX_CHUNKS_PER_SHOP) {
    if (stopRequested || signal.aborted) {
      return {
        shopId: job.shopId,
        name: job.name,
        chunksRun,
        jobsIndexed,
        skipped,
        finalState: "stopped",
        startedAt,
        endedAt: new Date(),
      };
    }

    const chunkStart = Date.now();
    let result;
    try {
      result = await backfillShopChunk(
        db,
        job.shopId,
        job.tekmetricShopId,
        signal,
      );
    } catch (err: any) {
      const msg = err?.message ? String(err.message) : String(err);
      // Hard-cancel path: signal was aborted mid-chunk. Return "stopped"
      // instead of "error" so we don't pollute the failure metric with
      // operator-initiated cancellations.
      if (err?.name === "AbortError" || signal.aborted) {
        log(
          `STOPPED shop=${job.shopId} chunk=${chunksRun + 1} aborted mid-chunk`
        );
        return {
          shopId: job.shopId,
          name: job.name,
          chunksRun,
          jobsIndexed,
          skipped,
          finalState: "stopped",
          startedAt,
          endedAt: new Date(),
        };
      }
      log(
        `ERROR shop=${job.shopId} chunk=${chunksRun + 1}: ${msg.slice(0, 200)}`
      );
      // The chunk function records the error to the progress row and the
      // cron's auto-clear sweep will retry it on its next pass. Stop this
      // worker for this shop so we don't hammer a broken shop in a tight
      // loop; other shops continue draining in parallel.
      return {
        shopId: job.shopId,
        name: job.name,
        chunksRun,
        jobsIndexed,
        skipped,
        finalState: "error",
        error: msg.slice(0, 500),
        startedAt,
        endedAt: new Date(),
      };
    }

    chunksRun++;
    jobsIndexed += result.jobsIndexed || 0;
    skipped += result.skipped || 0;

    const elapsed = Date.now() - chunkStart;
    log(
      `CHUNK shop=${job.shopId} #${chunksRun} ` +
        `jobs=${result.jobsIndexed} skipped=${result.skipped} ` +
        `complete=${result.complete} elapsed=${(elapsed / 1000).toFixed(1)}s ` +
        `msg="${(result.message || "").slice(0, 120)}"`
    );

    if (result.complete) {
      log(
        `DONE shop=${job.shopId} (${job.name}) chunks=${chunksRun} jobs=${jobsIndexed} skipped=${skipped}`
      );
      return {
        shopId: job.shopId,
        name: job.name,
        chunksRun,
        jobsIndexed,
        skipped,
        finalState: "complete",
        startedAt,
        endedAt: new Date(),
      };
    }
  }

  log(
    `MAX_CHUNKS shop=${job.shopId} hit safety cap of ${MAX_CHUNKS_PER_SHOP}; will resume on next run`
  );
  return {
    shopId: job.shopId,
    name: job.name,
    chunksRun,
    jobsIndexed,
    skipped,
    finalState: "max-chunks",
    startedAt,
    endedAt: new Date(),
  };
}

async function runWithParallelism(
  items: ShopJob[],
  workers: number,
  fn: (item: ShopJob, signal: AbortSignal) => Promise<ShopOutcome>,
  results: ShopOutcome[]
): Promise<void> {
  const queue = [...items];

  async function workerLoop(workerId: number) {
    // One AbortController per worker, registered globally so the SIGINT
    // handler can call abort() on every in-flight chunk at once.
    const controller = new AbortController();
    workerControllers.push(controller);

    while (queue.length > 0) {
      if (stopRequested || controller.signal.aborted) return;
      const item = queue.shift();
      if (!item) return;
      try {
        const outcome = await fn(item, controller.signal);
        results.push(outcome);
      } catch (err: any) {
        if (err?.name === "AbortError" || controller.signal.aborted) {
          log(`WORKER_${workerId} aborted`);
          return;
        }
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
  log("===== Tekmetric Backfill Drain Worker =====");
  log(
    `parallelism=${PARALLELISM} maxChunksPerShop=${MAX_CHUNKS_PER_SHOP} ` +
      `heartbeatMs=${HEARTBEAT_MS} owner=${LOCK_OWNER} ` +
      (SHOP_ID_FILTER.length > 0
        ? `shopIdFilter=[${SHOP_ID_FILTER.join(",")}]`
        : "shopIdFilter=ALL_INCOMPLETE")
  );

  // Two-stage stop. See module docstring for the full contract.
  const onStopSignal = (sig: string) => {
    sigintCount++;
    if (sigintCount >= 2) {
      log(`${sig} received (2nd) — hard-cancelling in-flight chunks immediately`);
      triggerHardCancel(`second ${sig}`);
      return;
    }
    log(
      `${sig} received — graceful stop: finishing in-flight chunks (up to ${Math.round(GRACEFUL_STOP_MS / 1000)}s) then aborting. Press Ctrl-C again to skip the wait.`,
    );
    stopRequested = true;
    if (!gracefulStopTimer) {
      gracefulStopTimer = setTimeout(() => {
        triggerHardCancel(`graceful ${Math.round(GRACEFUL_STOP_MS / 1000)}s timeout`);
      }, GRACEFUL_STOP_MS);
      if (typeof gracefulStopTimer.unref === "function") gracefulStopTimer.unref();
    }
  };
  process.on("SIGINT", () => onStopSignal("SIGINT"));
  process.on("SIGTERM", () => onStopSignal("SIGTERM"));

  // Acquire drain lock BEFORE loading shops so cron can't sneak a tick in
  // between our load and our first chunk write.
  await acquireDrainLock();
  const lockRefresher = setInterval(() => {
    refreshDrainLock().catch((err) =>
      log(`WARN lock refresh threw: ${err?.message || String(err)}`)
    );
  }, LOCK_REFRESH_MS);

  const outcomes: ShopOutcome[] = [];
  let heartbeat: NodeJS.Timeout | null = null;
  const startedAt = Date.now();

  try {
    const jobs = await loadIncompleteShops();
    log(`Found ${jobs.length} incomplete shops to drain`);
    if (jobs.length === 0) {
      log("Nothing to do. Exiting.");
      clearInterval(lockRefresher);
      await releaseDrainLock();
      process.exit(0);
    }

    heartbeat = startHeartbeat(
      () =>
        `done=${outcomes.length}/${jobs.length} ` +
        `complete=${outcomes.filter((o) => o.finalState === "complete").length} ` +
        `error=${outcomes.filter((o) => o.finalState === "error").length} ` +
        `elapsed=${((Date.now() - startedAt) / 1000 / 60).toFixed(1)}min`
    );

    await runWithParallelism(jobs, PARALLELISM, drainShop, outcomes);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    clearInterval(lockRefresher);
    if (gracefulStopTimer) clearTimeout(gracefulStopTimer);
    if (hardExitTimer) clearTimeout(hardExitTimer);
    await releaseDrainLock();
  }

  const totalJobs = outcomes.reduce((s, o) => s + o.jobsIndexed, 0);
  const totalSkipped = outcomes.reduce((s, o) => s + o.skipped, 0);
  const totalChunks = outcomes.reduce((s, o) => s + o.chunksRun, 0);
  const elapsedMin = ((Date.now() - startedAt) / 1000 / 60).toFixed(1);

  log("");
  log("===== DRAIN COMPLETE =====");
  log(`elapsed=${elapsedMin}min chunks=${totalChunks} jobs=${totalJobs} skipped=${totalSkipped}`);
  log(`shops complete: ${outcomes.filter((o) => o.finalState === "complete").length}`);
  log(`shops errored:  ${outcomes.filter((o) => o.finalState === "error").length}`);
  log(`shops max-cap:  ${outcomes.filter((o) => o.finalState === "max-chunks").length}`);
  log(`shops stopped:  ${outcomes.filter((o) => o.finalState === "stopped").length}`);

  const errored = outcomes.filter((o) => o.finalState === "error");
  if (errored.length > 0) {
    log("");
    log("Errored shops:");
    for (const o of errored) {
      log(`  shop=${o.shopId} (${o.name}) chunks=${o.chunksRun} err="${o.error}"`);
    }
  }

  // Exit code: 0 if every shop hit a terminal state we expected, 1 if any
  // errored. max-chunks is OK (just means re-run to continue).
  process.exit(errored.length > 0 ? 1 : 0);
}

main().catch((err) => {
  log(`FATAL: ${err?.message || String(err)}`);
  console.error(err);
  process.exit(2);
});
