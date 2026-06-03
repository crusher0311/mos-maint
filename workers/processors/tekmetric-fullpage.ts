/**
 * BullMQ processor for `tekmetric-fullpage` queue (task #513).
 *
 * Wraps the existing `runFullPageBackfillChunk` so the call site is
 * identical to the in-process cron path. The chunk processes up to
 * MAX_PAGES_PER_RUN pages and returns `complete:false` while pages
 * remain. The processor returns normally either way, so the job
 * COMPLETES (and is removed — `removeOnComplete: true`); the cron's
 * fast Pass-1 hand-off re-enqueues the shop on the next tick to run the
 * next chunk. We deliberately do NOT re-enqueue from inside the
 * processor: the job is still `active` here, so a same-jobId add would
 * be deduped to a no-op — continuation is the cron's job.
 *
 * Per-shop concurrency is the queue's job: `jobId =
 * `tekmetric-fullpage_${shopId}`` (set in `lib/queue/producer.ts`)
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
  // The chunker dereferences `db.collection(...)` immediately, so it needs
  // a live Mongo handle — the cron's inline path resolves it once via
  // getDb() and threads it through (see runForShop in the cron route). The
  // worker resolves its own handle per job (same pattern as the prepass
  // processor).
  const { getDb } = await import("@/lib/mongo");
  const db = await getDb();
  const result: any = await runFullPageBackfillChunk(
    db,
    shopId,
    tekmetricShopId,
  );

  // No in-processor re-enqueue: the job is still `active` here, so a
  // same-jobId add would be deduped to a no-op. When this job completes
  // it is removed (`removeOnComplete: true`); the cron's Pass-1 hand-off
  // re-enqueues the shop next tick to run the next chunk until
  // `complete:true`.
  return { complete: !!result?.complete, chunkResult: result };
}
