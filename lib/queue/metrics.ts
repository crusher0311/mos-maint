/**
 * Read-only queue state for observability surfaces (catchup-status and
 * the admin queue dashboard). Task #513.
 *
 * Returns null when the queue subsystem isn't enabled, so callers can
 * cleanly omit the queue section instead of fabricating zeros.
 */

import { getQueue, ALL_QUEUE_NAMES, type QueueName } from "./queues";

export type QueueCounts = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: number;
};

export type QueueSnapshot = {
  name: QueueName;
  counts: QueueCounts | null;
  error?: string;
};

export async function getQueueCounts(
  name: QueueName,
): Promise<QueueCounts | null> {
  const q = getQueue(name);
  if (!q) return null;
  try {
    // BullMQ's `getJobCounts` accepts the state names as positional args
    // and returns an object keyed by them.
    const c: any = await q.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
      "completed",
      "paused",
    );
    return {
      waiting: Number(c.waiting || 0),
      active: Number(c.active || 0),
      delayed: Number(c.delayed || 0),
      failed: Number(c.failed || 0),
      completed: Number(c.completed || 0),
      paused: Number(c.paused || 0),
    };
  } catch (err: any) {
    console.warn(
      `[Queue Metrics] getJobCounts failed for ${name}: ${err?.message || err}`,
    );
    return null;
  }
}

export async function getAllQueueSnapshots(): Promise<QueueSnapshot[]> {
  const out: QueueSnapshot[] = [];
  for (const name of ALL_QUEUE_NAMES) {
    try {
      const counts = await getQueueCounts(name);
      out.push({ name, counts });
    } catch (err: any) {
      out.push({ name, counts: null, error: String(err?.message || err) });
    }
  }
  return out;
}

export type FailedJobSummary = {
  id: string;
  name: string;
  failedReason: string | null;
  attemptsMade: number;
  timestamp: number;
  data: any;
};

/**
 * The "needs-human" bucket. Task #513 spec: dead-lettered jobs should
 * land in a visible bucket on the admin sync-health view.
 */
export async function getFailedJobs(
  name: QueueName,
  limit = 20,
): Promise<FailedJobSummary[] | null> {
  const q = getQueue(name);
  if (!q) return null;
  try {
    const jobs = await q.getFailed(0, Math.max(0, limit - 1));
    return jobs.map((j: any) => ({
      id: String(j.id),
      name: String(j.name),
      failedReason: j.failedReason ?? null,
      attemptsMade: Number(j.attemptsMade || 0),
      timestamp: Number(j.timestamp || 0),
      data: j.data,
    }));
  } catch (err: any) {
    console.warn(
      `[Queue Metrics] getFailed failed for ${name}: ${err?.message || err}`,
    );
    return null;
  }
}
