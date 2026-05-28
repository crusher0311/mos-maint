/**
 * Backfill worker entry point (task #513).
 *
 * Long-running Node process that consumes the BullMQ backfill queues.
 * Designed to run as a separate Render service so backfill load can't
 * impact web-service request latency. Locally / in combined-mode dev,
 * `scripts/start-worker.ts` can run it alongside Next.
 *
 * Lifecycle:
 *   1. On boot, validate `REDIS_URL` is set. If not, log and exit 0 —
 *      this is intentionally not a hard failure so the worker service
 *      can be configured on Render before Redis is actually provisioned.
 *   2. Construct one BullMQ Worker per queue, each with its own
 *      concurrency cap. Concurrency is tuned per-queue so the Tekmetric
 *      shared rate limiter (which is the real throughput ceiling) stays
 *      the binding constraint — not the worker concurrency.
 *   3. Handle SIGTERM by closing every worker (BullMQ drains in-flight
 *      jobs before exiting). Render's default 30s grace period is enough
 *      for a chunk to checkpoint progress and return cleanly.
 */

import type { Worker as BullWorker, Job } from "bullmq";
import { getRedisConnection, isQueueEnabled } from "@/lib/queue/connection";
import { QUEUE_NAMES, STALLED_VISIBILITY_MS } from "@/lib/queue/queues";
import { processTekmetricFullPage } from "./processors/tekmetric-fullpage";
import { processTekmetricPrePass } from "./processors/tekmetric-prepass";
import { processDrainTekmetric } from "./processors/drain-tekmetric";
import { processDrainProtractor } from "./processors/drain-protractor";

// Concurrency per queue. The Tekmetric workloads are gated by the
// shared cross-process rate limiter (`shared-rate-limiter.ts`), so
// these caps just prevent us from queueing too many BullMQ jobs against
// one Redis instance — not from rate-limiting Tekmetric itself.
const CONCURRENCY = {
  [QUEUE_NAMES.TEKMETRIC_FULLPAGE]: 4,
  [QUEUE_NAMES.TEKMETRIC_PREPASS]: 6,
  [QUEUE_NAMES.DRAIN_TEKMETRIC]: 1, // singleton drain
  [QUEUE_NAMES.DRAIN_PROTRACTOR]: 1, // singleton drain
} as const;

const workers: BullWorker[] = [];

function buildWorker(
  name: string,
  processor: (job: Job) => Promise<unknown>,
  concurrency: number,
): BullWorker | null {
  const connection = getRedisConnection();
  if (!connection) return null;
  const { Worker } = require("bullmq") as typeof import("bullmq");
  const w = new Worker(name, processor, {
    connection: connection as any,
    concurrency,
    stalledInterval: STALLED_VISIBILITY_MS / 2,
    maxStalledCount: 3,
  });
  w.on("completed", (job) => {
    console.log(
      `[Worker ${name}] job ${job.id} completed in ${
        job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : "?"
      }ms`,
    );
  });
  w.on("failed", (job, err) => {
    console.error(
      `[Worker ${name}] job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${err?.message || err}`,
    );
  });
  w.on("error", (err) => {
    console.error(`[Worker ${name}] worker error: ${err?.message || err}`);
  });
  return w;
}

export async function startWorkers(): Promise<void> {
  if (!isQueueEnabled()) {
    console.log(
      "[Worker] REDIS_URL not set — worker exiting cleanly. Set REDIS_URL to enable the backfill queue.",
    );
    return;
  }
  console.log("[Worker] Starting backfill worker service…");

  const built = [
    buildWorker(
      QUEUE_NAMES.TEKMETRIC_FULLPAGE,
      processTekmetricFullPage,
      CONCURRENCY[QUEUE_NAMES.TEKMETRIC_FULLPAGE],
    ),
    buildWorker(
      QUEUE_NAMES.TEKMETRIC_PREPASS,
      processTekmetricPrePass,
      CONCURRENCY[QUEUE_NAMES.TEKMETRIC_PREPASS],
    ),
    buildWorker(
      QUEUE_NAMES.DRAIN_TEKMETRIC,
      processDrainTekmetric,
      CONCURRENCY[QUEUE_NAMES.DRAIN_TEKMETRIC],
    ),
    buildWorker(
      QUEUE_NAMES.DRAIN_PROTRACTOR,
      processDrainProtractor,
      CONCURRENCY[QUEUE_NAMES.DRAIN_PROTRACTOR],
    ),
  ].filter((w): w is BullWorker => w !== null);

  workers.push(...built);

  console.log(`[Worker] Started ${workers.length} BullMQ workers`);

  const shutdown = async (signal: string) => {
    console.log(`[Worker] Received ${signal}, draining workers…`);
    await Promise.allSettled(workers.map((w) => w.close()));
    console.log("[Worker] All workers closed");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Allow `tsx workers/worker.ts` to start the service directly.
// Guarded so importing this module from a test doesn't auto-start.
if (require.main === module) {
  startWorkers().catch((err) => {
    console.error("[Worker] Fatal error during startup:", err);
    process.exit(1);
  });
}
