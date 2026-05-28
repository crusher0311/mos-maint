/**
 * BullMQ processor for `drain-tekmetric` queue (task #513).
 *
 * Replaces the long-running `scripts/drain-tekmetric-backfill.ts`
 * process. The drain script imports `backfillShopChunk` from the cron
 * route and loops every incomplete shop until done — we keep that
 * exact behavior, just driven by a queue job instead of a forever-loop
 * inside a dedicated Render Background Worker.
 *
 * Singleton: `enqueueDrain` uses `jobId = drain-tekmetric:all` for the
 * default no-allowlist case, so two cron ticks or two admin clicks can
 * never spawn parallel drains of the same shop set.
 */

import type { Job } from "bullmq";
import type { DrainJobData } from "@/lib/queue/producer";

// Per-attempt cap. The legacy drain script ran indefinitely; under
// BullMQ we cap each job and let the queue's retry/re-enqueue handle
// continuation. 20 min is long enough for a meaningful chunk of work
// but short enough that a wedged drain self-heals within the queue's
// 30-min stalled-visibility window.
const DRAIN_ATTEMPT_MAX_MS = 20 * 60 * 1000;

export async function processDrainTekmetric(
  job: Job<DrainJobData>,
): Promise<{ shopsProcessed: number; complete: boolean }> {
  const { shopIds } = job.data;
  console.log(
    `[Worker drain-tekmetric] starting attempt=${job.attemptsMade + 1} scope=${
      shopIds && shopIds.length > 0 ? shopIds.join(",") : "all-incomplete"
    }`,
  );

  const { getDb } = await import("@/lib/mongo");
  const { backfillShopChunk } = await import(
    "@/app/api/cron/tekmetric-backfill/route"
  );
  const db = await getDb();

  // Resolve the shop set: explicit allowlist, or "every shop with a
  // tekmetric mapping that isn't marked complete".
  let targetShopIds: number[];
  if (shopIds && shopIds.length > 0) {
    targetShopIds = shopIds.slice();
  } else {
    const rows = await db
      .collection("shops")
      .find({
        $or: [
          { "tekmetric.shopId": { $exists: true, $ne: null } },
          { tekmetricShopId: { $exists: true, $ne: null } },
        ],
        tekmetricBackfillComplete: { $ne: true },
      })
      .project({ shopId: 1, "tekmetric.shopId": 1, tekmetricShopId: 1 })
      .toArray();
    targetShopIds = rows.map((r: any) => Number(r.shopId)).filter(Number.isFinite);
  }

  const deadlineMs = Date.now() + DRAIN_ATTEMPT_MAX_MS;
  let shopsProcessed = 0;
  for (const shopId of targetShopIds) {
    if (Date.now() >= deadlineMs) break;
    try {
      await backfillShopChunk(db, shopId);
      shopsProcessed++;
    } catch (err: any) {
      console.error(
        `[Worker drain-tekmetric] shop=${shopId} chunk error: ${err?.message || err}`,
      );
      // Keep going — one bad shop shouldn't block the rest. Failed
      // chunks get retried by the regular tekmetric-fullpage queue or
      // by the next drain attempt.
    }
  }

  const complete = Date.now() < deadlineMs;
  if (!complete) {
    // Re-enqueue so the next worker tick picks up the remaining work.
    const { enqueueDrain } = await import("@/lib/queue/producer");
    await enqueueDrain({
      provider: "tekmetric",
      shopIds,
      enqueuedAt: new Date().toISOString(),
    });
  }

  return { shopsProcessed, complete };
}
