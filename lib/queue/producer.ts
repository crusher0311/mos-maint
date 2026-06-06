/**
 * Producer helpers — the only place the rest of the codebase should
 * touch BullMQ (task #513).
 *
 * Each helper returns a tagged result so the caller can branch cleanly:
 *
 *   - `{ enqueued: true,  jobId }` — handed off to the queue. The caller
 *     MUST NOT also run the in-process path; the worker owns it now.
 *   - `{ enqueued: false, reason: "flag_off" }` — feature flag not on for
 *     this shop. The caller continues with the legacy in-process path.
 *   - `{ enqueued: false, reason: "duplicate" }` — BullMQ rejected the
 *     enqueue because an identical jobId is already active/waiting.
 *     The caller should treat this as success (someone else has it).
 *   - `{ enqueued: false, reason: "queue_unavailable" }` — Redis is down
 *     or BullMQ failed to construct the Queue. We fail OPEN here — the
 *     caller falls back to the in-process path. Without that fallback,
 *     a Redis outage would freeze every flagged shop's backfill.
 *
 * The `jobId` strategy is intentional and load-bearing: it's the
 * cross-process per-shop concurrency guarantee that replaces
 * `inflight-lock.ts` for the ported workloads.
 */

import { shouldUseQueueForShop } from "./feature-flag";
import { getQueue, QUEUE_NAMES, type QueueName } from "./queues";

export type EnqueueResult =
  | { enqueued: true; jobId: string; queue: QueueName }
  | {
      enqueued: false;
      reason: "flag_off" | "duplicate" | "queue_unavailable";
      queue: QueueName;
    };

export type TekmetricFullPageJobData = {
  shopId: number;
  tekmetricShopId: number;
  enqueuedAt: string;
  /** Source of this enqueue, for log triage. */
  trigger: "cron" | "admin" | "webhook" | "manual";
};

export type TekmetricPrePassVariant = "jobs" | "vehicles" | "customers";

export type TekmetricPrePassJobData = {
  shopId: number;
  tekmetricShopId: number;
  variant: TekmetricPrePassVariant;
  enqueuedAt: string;
};

export type DrainJobData = {
  provider: "tekmetric" | "protractor";
  /** Optional shop allowlist; empty = drain all incomplete shops. */
  shopIds?: number[];
  enqueuedAt: string;
};

async function safeAdd(
  queueName: QueueName,
  jobName: string,
  data: unknown,
  jobId: string,
): Promise<EnqueueResult> {
  const q = getQueue(queueName);
  if (!q) {
    return { enqueued: false, reason: "queue_unavailable", queue: queueName };
  }
  try {
    // Self-heal dead-lettered shops. Queues run `removeOnFail: false`, so a
    // job that exhausts its retries persists in the `failed` set forever
    // under this stable per-shop jobId. A plain `q.add` with the same jobId
    // is a no-op against an existing job (BullMQ dedupes), so the cron's
    // re-drive could never resurrect a failed shop — it stayed stuck until a
    // human hit the admin "retry". Here we detect that case and move the
    // failed job back to `waiting` so the worker re-runs it on the next poll.
    //
    // Completed jobs can't collide (removeOnComplete: true removes them
    // immediately), so any pre-existing job is active/waiting/delayed/paused
    // (a genuine "someone else has it" duplicate) OR failed (our stuck case).
    const existing = await q.getJob(jobId);
    if (existing) {
      let state: string | undefined;
      try {
        state = await existing.getState();
      } catch {
        // If we can't read state, fall through to the duplicate branch — we
        // never want this best-effort re-drive to throw away an enqueue.
      }
      if (state === "failed") {
        try {
          await existing.retry();
          console.log(
            `[Queue ${queueName}] re-drove dead-lettered job jobId=${jobId} (failed -> waiting)`,
          );
          return {
            enqueued: true,
            jobId: String(existing.id),
            queue: queueName,
          };
        } catch {
          // Race: another producer already re-drove this job, so `retry()`
          // throws ("job is not in the failed state"). The queue now owns it
          // (waiting/active), so report a duplicate — NEVER fall open to the
          // in-process path here, which would double-run the chunk.
          return { enqueued: false, reason: "duplicate", queue: queueName };
        }
      }
      // Active / waiting / delayed / paused — a real in-flight duplicate.
      return { enqueued: false, reason: "duplicate", queue: queueName };
    }
    const job = await q.add(jobName, data, { jobId });
    // BullMQ returns the existing job (same instance, same id) when a
    // duplicate is rejected — but it also returns a job object for a
    // brand-new enqueue. The way to detect a duplicate is to inspect
    // the returned timestamp: if it's not "just now", we lost the race.
    // Easier and more reliable: check if the returned id matches what
    // we asked for and trust BullMQ's uniqueness. The only failure
    // mode is duplicate, which throws in some BullMQ versions — we
    // catch that below.
    return { enqueued: true, jobId: String(job.id), queue: queueName };
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/duplicat|already exists/i.test(msg)) {
      return { enqueued: false, reason: "duplicate", queue: queueName };
    }
    console.error(
      `[Queue ${queueName}] enqueue error for jobId=${jobId}: ${msg}`,
    );
    return { enqueued: false, reason: "queue_unavailable", queue: queueName };
  }
}

export async function enqueueTekmetricFullPage(
  data: TekmetricFullPageJobData,
): Promise<EnqueueResult> {
  if (!shouldUseQueueForShop(data.shopId)) {
    return {
      enqueued: false,
      reason: "flag_off",
      queue: QUEUE_NAMES.TEKMETRIC_FULLPAGE,
    };
  }
  // NOTE: BullMQ forbids ":" in a custom jobId (it's Redis's key
  // separator) and THROWS "Custom Ids cannot contain :". Use "_" as the
  // field delimiter — a colon here silently routed every shop back to the
  // in-process path (caught as queue_unavailable) and the queue never
  // received a single job.
  const jobId = `${QUEUE_NAMES.TEKMETRIC_FULLPAGE}_${data.shopId}`;
  return safeAdd(QUEUE_NAMES.TEKMETRIC_FULLPAGE, "chunk", data, jobId);
}

export async function enqueueTekmetricPrePass(
  data: TekmetricPrePassJobData,
): Promise<EnqueueResult> {
  if (!shouldUseQueueForShop(data.shopId)) {
    return {
      enqueued: false,
      reason: "flag_off",
      queue: QUEUE_NAMES.TEKMETRIC_PREPASS,
    };
  }
  // jobId includes variant so the three pre-pass variants for one shop
  // can run concurrently — they hit different Tekmetric endpoints and
  // contend only on the shared rate limiter.
  // "_" delimiter — BullMQ forbids ":" in custom jobIds (see fullpage note).
  const jobId = `${QUEUE_NAMES.TEKMETRIC_PREPASS}_${data.shopId}_${data.variant}`;
  return safeAdd(QUEUE_NAMES.TEKMETRIC_PREPASS, data.variant, data, jobId);
}

export async function enqueueDrain(
  data: DrainJobData,
): Promise<EnqueueResult> {
  const queueName =
    data.provider === "tekmetric"
      ? QUEUE_NAMES.DRAIN_TEKMETRIC
      : QUEUE_NAMES.DRAIN_PROTRACTOR;
  // Drain is a singleton per provider — at most one in-flight drain run
  // per provider across the fleet. The shop allowlist is part of the
  // jobId so two distinct admin-triggered drains for different shop
  // subsets can coexist, but the no-allowlist "drain everything" job
  // collapses to one.
  const tag = (data.shopIds && data.shopIds.length > 0
    ? data.shopIds.slice().sort((a, b) => a - b).join("-")
    : "all");
  // "_" delimiter — BullMQ forbids ":" in custom jobIds (see fullpage note).
  const jobId = `${queueName}_${tag}`;
  return safeAdd(queueName, "drain", data, jobId);
}
