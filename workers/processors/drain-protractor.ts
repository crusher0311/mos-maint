/**
 * BullMQ processor for `drain-protractor` queue (task #513, refactored
 * in task #523).
 *
 * Mirrors `drain-tekmetric.ts`. Previously this processor spawned
 * `scripts/drain-protractor-backfill.ts` as a child process because that
 * script didn't expose a per-shop chunk entry point. The script now
 * exports `drainProtractorShopChunk` (and `loadIncompleteProtractorShops`),
 * so we call it directly in-process: one less process to start, logs stay
 * in the worker, and BullMQ can stall/cancel a stuck attempt via the
 * shared deadline predicate.
 *
 * Singleton: `enqueueDrain` uses `jobId = drain-protractor_all` for the
 * default no-allowlist case, so two cron ticks or two admin clicks can
 * never spawn parallel drains of the same shop set.
 */

import type { Job } from "bullmq";
import type { DrainJobData } from "@/lib/queue/producer";

// Per-attempt cap. The legacy drain script ran indefinitely; under
// BullMQ we cap each job and let the queue's retry/re-enqueue handle
// continuation. 20 min is long enough for a meaningful chunk of work
// but short enough that a wedged drain self-heals within the queue's
// 30-min stalled-visibility window. Matches drain-tekmetric.ts.
const DRAIN_ATTEMPT_MAX_MS = 20 * 60 * 1000;

export async function processDrainProtractor(
  job: Job<DrainJobData>,
): Promise<{ shopsProcessed: number; complete: boolean }> {
  const { shopIds } = job.data;
  console.log(
    `[Worker drain-protractor] starting attempt=${job.attemptsMade + 1} scope=${
      shopIds && shopIds.length > 0 ? shopIds.join(",") : "all-incomplete"
    }`,
  );

  const { loadIncompleteProtractorShops, drainProtractorShopChunk } =
    await import("@/scripts/drain-protractor-backfill");

  // Resolve the shop set: explicit allowlist (still filtered to shops
  // that are actually incomplete) or "every incomplete Protractor shop".
  const targetShops = await loadIncompleteProtractorShops(shopIds);

  // Deadline-based cooperative cancellation. The per-shop chunk function
  // checks this at its safe checkpoints (between attempts and during
  // lock-wait polling) so a single queue attempt can't run past its
  // budget.
  const deadlineMs = Date.now() + DRAIN_ATTEMPT_MAX_MS;
  const shouldStop = () => Date.now() >= deadlineMs;

  let shopsProcessed = 0;
  for (const shop of targetShops) {
    if (Date.now() >= deadlineMs) break;
    try {
      await drainProtractorShopChunk(shop, { shouldStop });
      shopsProcessed++;
    } catch (err: any) {
      console.error(
        `[Worker drain-protractor] shop=${shop.shopId} chunk error: ${err?.message || err}`,
      );
      // Keep going — one bad shop shouldn't block the rest. The shop's
      // own lease/idempotency layer makes a re-attempt safe on the next
      // drain.
    }
  }

  const complete = Date.now() < deadlineMs;
  if (!complete) {
    // Re-enqueue so the next worker tick picks up the remaining work.
    const { enqueueDrain } = await import("@/lib/queue/producer");
    await enqueueDrain({
      provider: "protractor",
      shopIds,
      enqueuedAt: new Date().toISOString(),
    });
  }

  return { shopsProcessed, complete };
}
