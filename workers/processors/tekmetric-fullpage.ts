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

  // Hard processor timeout — backstop for a hung downstream await.
  //
  // The chunk self-limits to SOFT_DEADLINE_MS (240s) by checking the clock
  // BETWEEN pages and per-RO, but that guard can NOT interrupt a single
  // `await` that never resolves (e.g. a normalized-ingestion or Mongo call
  // to a service that accepts the connection but never responds). The
  // in-process cron path is bounded for free by Render's `maxDuration=300`
  // request kill plus the 6-min inflight-lock TTL; the worker path has NO
  // such platform backstop. A hung await therefore keeps the BullMQ job
  // `active` indefinitely: the worker's event loop stays free and renews the
  // job lock forever, so the job never stalls, never fails, never completes —
  // and because the stable per-shop jobId (`tekmetric-fullpage_<shopId>`)
  // dedupes every re-enqueue, the cron can never re-drive the shop and there
  // is no in-process fallback. That silently wedged the canary after a single
  // chunk (one pickup, then permanent silence — no completion/failure/stall).
  //
  // Racing the chunk against a 300s deadline (matching the inline envelope)
  // converts that infinite hang into a job FAILURE, which BullMQ retries
  // (attempts: 5, exponential backoff) and ultimately dead-letters for an
  // operator — restoring liveness. The chunk persists progress per page and
  // upserts by natural key, so a timed-out run loses at most one partial page
  // and resumes from `fullPageNextPage` on the next attempt.
  const HARD_TIMEOUT_MS = 300_000;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () =>
        reject(
          new Error(
            `[Worker tekmetric-fullpage] shop=${shopId} hard timeout after ${HARD_TIMEOUT_MS}ms — chunk did not return (likely a hung downstream call); failing job so BullMQ retries and the cron can re-drive.`,
          ),
        ),
      HARD_TIMEOUT_MS,
    );
  });

  let result: any;
  try {
    result = await Promise.race([
      runFullPageBackfillChunk(db, shopId, tekmetricShopId),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // No in-processor re-enqueue: the job is still `active` here, so a
  // same-jobId add would be deduped to a no-op. When this job completes
  // it is removed (`removeOnComplete: true`); the cron's Pass-1 hand-off
  // re-enqueues the shop next tick to run the next chunk until
  // `complete:true`.
  return { complete: !!result?.complete, chunkResult: result };
}
