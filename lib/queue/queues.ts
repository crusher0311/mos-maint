/**
 * BullMQ queue definitions for the long-running backfill workloads
 * (task #513).
 *
 * Queue inventory:
 *   - `tekmetric-fullpage`   — one job per shop chunk of `runFullPageBackfillChunk`
 *   - `tekmetric-prepass`    — jobs / vehicles / customers bulk pre-passes
 *   - `drain-tekmetric`      — long-running drain worker (replaces `scripts/drain-tekmetric-backfill.ts`)
 *   - `drain-protractor`     — long-running drain worker (replaces `scripts/drain-protractor-backfill.ts`)
 *
 * Per-shop concurrency: BullMQ's `Job.opts.jobId` is a uniqueness key.
 * Producers set `jobId = \`${queueName}_${shopId}\`` (and `_${variant}`
 * for the prepass queue) so a second enqueue for the same shop while
 * the first is still active or waiting is rejected by BullMQ. That
 * replaces `lib/integrations/tekmetric/inflight-lock.ts` for the ported
 * workloads — the queue itself is the lock.
 *
 * NB: the delimiter is "_", NOT ":". BullMQ THROWS "Custom Ids cannot
 * contain :" for any jobId containing a colon (it's Redis's key
 * separator). A colon delimiter made every enqueue fail and silently
 * fall back to the in-process path — the queue never received a job.
 *
 * Dead-lettering: every queue uses `removeOnComplete: true` and
 * `removeOnFail: false`. Failed jobs persist in the `failed` set
 * indefinitely until an operator marks them resolved (the "needs-human"
 * bucket the admin sync-health view reads). Completed jobs are removed
 * IMMEDIATELY — this is load-bearing, not cosmetic: these workloads are
 * resumable and re-driven by the cron under a STABLE per-shop jobId
 * (`runFullPageBackfillChunk` does MAX_PAGES_PER_RUN pages then returns
 * `complete:false`). If a completed chunk lingered (e.g. `age: 24h`), the
 * next tick's enqueue would dedupe against that lingering completed job
 * and the shop would stall after a single chunk until the TTL expired.
 * Removing on completion lets the next cron tick enqueue the next chunk.
 *
 * Retries: exponential backoff, capped attempts. Tekmetric's own rate
 * limiter (`shared-rate-limiter.ts`) is still in the call path, so the
 * retries here protect against transient infra blips, not against
 * upstream rate-limiting (which the limiter handles inline).
 */

import type { Queue as BullQueue } from "bullmq";
import { getRedisConnection } from "./connection";

export const QUEUE_NAMES = {
  TEKMETRIC_FULLPAGE: "tekmetric-fullpage",
  TEKMETRIC_PREPASS: "tekmetric-prepass",
  DRAIN_TEKMETRIC: "drain-tekmetric",
  DRAIN_PROTRACTOR: "drain-protractor",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: QueueName[] = Object.values(QUEUE_NAMES);

// Visibility timeout: how long BullMQ waits before considering an
// in-flight job stuck and re-queuing it. Replaces the 6-minute Mongo
// TTL on the old inflight-lock. Set to 30 min — longer than the 25-min
// route handler envelope so a healthy chunk completes inside, but
// short enough that a wedged worker self-heals within a single
// operator-debugging session.
export const STALLED_VISIBILITY_MS = 30 * 60 * 1000;

export const DEFAULT_JOB_OPTS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 30_000 },
  // MUST remove on completion: these jobs use a stable per-shop jobId and
  // are re-driven chunk-by-chunk by the cron. A lingering completed job
  // would dedupe-block the next chunk's enqueue. See the file header.
  removeOnComplete: true as const,
  removeOnFail: false as const,
};

const queueCache = new Map<QueueName, BullQueue>();

/**
 * Get (or lazily construct) a queue producer. Returns null when Redis
 * is not configured — every caller MUST handle null by falling back to
 * the legacy in-process path. Cached per process so we don't churn
 * BullMQ Queue instances per enqueue.
 */
export function getQueue(name: QueueName): BullQueue | null {
  const cached = queueCache.get(name);
  if (cached) return cached;

  const connection = getRedisConnection();
  if (!connection) return null;

  try {
    const { Queue } = require("bullmq") as typeof import("bullmq");
    const q = new Queue(name, {
      connection: connection as any,
      defaultJobOptions: DEFAULT_JOB_OPTS,
    });
    queueCache.set(name, q);
    return q;
  } catch (err: any) {
    console.error(
      `[Queue ${name}] Failed to construct BullMQ Queue: ${err?.message || err}`,
    );
    return null;
  }
}

/** Test-only seam. */
export function __resetQueueCacheForTest(): void {
  for (const q of queueCache.values()) {
    try {
      (q as any).close?.();
    } catch {}
  }
  queueCache.clear();
}
