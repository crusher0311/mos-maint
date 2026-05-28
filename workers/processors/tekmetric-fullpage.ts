/**
 * BullMQ processor for `tekmetric-fullpage` queue (task #513).
 *
 * Wraps the existing `runFullPageBackfillChunk` so the call site is
 * identical to the in-process cron path. The job stays on the queue
 * (not "completed") if the chunk reports `complete: false`, so the
 * next run picks up where this one stopped — same behavior the cron
 * route relies on today, just driven by a queue tick instead of a
 * scheduler tick.
 *
 * Per-shop concurrency is the queue's job: `jobId =
 * `tekmetric-fullpage:${shopId}`` (set in `lib/queue/producer.ts`)
 * guarantees only one in-flight job per shop. That replaces
 * `inflight-lock.ts` for queue-routed shops — see the cutover runbook
 * for the dual-path safety margins during rollout.
 */

import type { Job } from "bullmq";
import type { TekmetricFullPageJobData } from "@/lib/queue/producer";

export async function processTekmetricFullPage(
  job: Job<TekmetricFullPageJobData>,
): Promise<{ complete: boolean; chunkResult: unknown }> {
  const { shopId, tekmetricShopId, trigger } = job.data;
  console.log(
    `[Worker tekmetric-fullpage] shop=${shopId} tekmetricShopId=${tekmetricShopId} trigger=${trigger} attempt=${job.attemptsMade + 1}`,
  );

  // Import lazily so the worker boot doesn't pay for full-page-backfill's
  // dependency graph (Mongo client, Drizzle, etc.) until the first job
  // actually runs.
  const { runFullPageBackfillChunk } = await import(
    "@/lib/integrations/tekmetric/full-page-backfill"
  );
  const result: any = await runFullPageBackfillChunk(
    null as any,
    shopId,
    tekmetricShopId,
  );

  // If the chunk isn't done, re-enqueue at the back of the queue so
  // other shops get a turn. BullMQ's jobId-based uniqueness blocks a
  // duplicate from sneaking in while we're re-enqueueing.
  if (result && result.complete === false) {
    const { enqueueTekmetricFullPage } = await import("@/lib/queue/producer");
    await enqueueTekmetricFullPage({
      shopId,
      tekmetricShopId,
      enqueuedAt: new Date().toISOString(),
      trigger: "cron",
    });
  }

  return { complete: !!result?.complete, chunkResult: result };
}
