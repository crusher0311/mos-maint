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
import {
  evaluateProtractorOutboundPolicy,
  logProtractorPolicyDenial,
} from "@/lib/integrations/protractor/outbound-policy.cjs";
import { selectBackfillWorkerKinds } from "./worker-registration";
import {
  startTekmetricIncrementalLoop,
  stopTekmetricIncrementalLoop,
} from "./tekmetric-incremental-loop";

// Concurrency per queue. The Tekmetric workloads share the cross-process
// rate limiter (`shared-rate-limiter.ts`), so when too many full-page /
// pre-pass chunks run at once they all contend for the same ~5 RPS budget:
// callers starve waiting for a token (logged as "rate limit budget
// exhausted (waited 30000ms)"), the chunk blows its 300s hard timeout, the
// job fails all retries, and the shop never makes progress. Keeping these
// low keeps the shared rate limiter — not BullMQ fan-out — the binding
// constraint. Tunable via env so the throttle can be adjusted in prod
// WITHOUT a code deploy (set e.g. WORKER_CONCURRENCY_TEKMETRIC_FULLPAGE=1
// to ease off further, or back to 4 to push harder).
function concurrencyFromEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const CONCURRENCY: Record<string, number> = {
  [QUEUE_NAMES.TEKMETRIC_FULLPAGE]: concurrencyFromEnv(
    "WORKER_CONCURRENCY_TEKMETRIC_FULLPAGE",
    2,
  ),
  [QUEUE_NAMES.TEKMETRIC_PREPASS]: concurrencyFromEnv(
    "WORKER_CONCURRENCY_TEKMETRIC_PREPASS",
    3,
  ),
  [QUEUE_NAMES.DRAIN_TEKMETRIC]: 1, // singleton drain
  [QUEUE_NAMES.DRAIN_PROTRACTOR]: 1, // singleton drain
};

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
  // Task #1079: the incremental-sync loop is independent of BullMQ/Redis —
  // start it (when flagged on) even if the queue isn't configured, so the
  // worker can own the cron-style tick regardless of queue rollout state.
  const incrementalLoopStarted = startTekmetricIncrementalLoop();

  if (!isQueueEnabled()) {
    if (incrementalLoopStarted) {
      console.log(
        "[Worker] REDIS_URL not set — no BullMQ workers, but the Tekmetric incremental loop is running; keeping the process alive.",
      );
      // The loop's timers are unref'd; hold the process open explicitly.
      setInterval(() => {}, 60 * 60 * 1000);
      return;
    }
    console.log(
      "[Worker] REDIS_URL not set — worker exiting cleanly. Set REDIS_URL to enable the backfill queue.",
    );
    return;
  }
  console.log("[Worker] Starting backfill worker service…");
  const protractorPolicy = evaluateProtractorOutboundPolicy(process.env);
  const selectedWorkerKinds = new Set(selectBackfillWorkerKinds(protractorPolicy.allowed));
  if (!protractorPolicy.allowed) {
    logProtractorPolicyDenial(protractorPolicy, "worker_registration");
  }

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
    ...(selectedWorkerKinds.has("drain-protractor")
      ? [buildWorker(
          QUEUE_NAMES.DRAIN_PROTRACTOR,
          processDrainProtractor,
          CONCURRENCY[QUEUE_NAMES.DRAIN_PROTRACTOR],
        )]
      : []),
  ].filter((w): w is BullWorker => w !== null);

  workers.push(...built);

  console.log(`[Worker] Started ${workers.length} BullMQ workers`);

  const shutdown = async (signal: string) => {
    console.log(`[Worker] Received ${signal}, draining workers…`);
    stopTekmetricIncrementalLoop();
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
