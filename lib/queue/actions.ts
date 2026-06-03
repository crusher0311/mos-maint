/**
 * Write actions on the backfill queues (task #567).
 *
 * Kept separate from `metrics.ts` (read-only) so the mutation surface is
 * easy to audit. Today this is just the retry-from-failed action that
 * closes the script-only gap noted in the cutover runbook: an operator
 * can re-enqueue a dead-lettered job straight from the admin dashboard
 * instead of shelling into a one-off script.
 *
 * `job.retry()` moves a job out of the `failed` set back into `waiting`
 * with its attempt counter reset, so the worker picks it up again on the
 * next poll. Per-shop uniqueness still holds: the job keeps its original
 * jobId, so a retry can't fan out into duplicates.
 */

import { getQueue, type QueueName } from "./queues";

export type RetryFailedResult =
  | { ok: true; queue: QueueName; jobId: string }
  | {
      ok: false;
      queue: QueueName;
      reason: "queue_unavailable" | "not_found" | "not_failed" | "error";
      message?: string;
    };

export async function retryFailedJob(
  queue: QueueName,
  jobId: string,
): Promise<RetryFailedResult> {
  const q = getQueue(queue);
  if (!q) return { ok: false, queue, reason: "queue_unavailable" };
  try {
    const job = await q.getJob(jobId);
    if (!job) return { ok: false, queue, reason: "not_found" };
    const state = await job.getState();
    if (state !== "failed") {
      return {
        ok: false,
        queue,
        reason: "not_failed",
        message: `job is in state '${state}', only failed jobs can be retried`,
      };
    }
    await job.retry();
    return { ok: true, queue, jobId: String(job.id) };
  } catch (err: any) {
    return {
      ok: false,
      queue,
      reason: "error",
      message: String(err?.message || err),
    };
  }
}
