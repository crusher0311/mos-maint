/**
 * BullMQ processor for `drain-tekmetric` queue (task #513).
 *
 * Replaces the long-running `scripts/drain-tekmetric-backfill.ts`
 * process. The drain script imports `backfillShopChunk` from the cron
 * route and loops every incomplete shop until done — we keep that
 * exact behavior, just driven by a queue job instead of a forever-loop
 * inside a dedicated Render Background Worker.
 *
 * Singleton: `enqueueDrain` uses `jobId = drain-tekmetric_all` for the
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

// Poisoned-shop guard (task #946). A shop whose chunk fails on every
// drain pass used to be re-picked by every drain job forever, burning
// API quota and wall clock without ever making progress. We track
// consecutive chunk failures per shop in `tekmetric_backfill_progress`
// (`drainConsecutiveFailures`) and, past this threshold, mark the shop
// poisoned (`drainPoisoned`, `drainPoisonedReason`, `drainPoisonedAt`)
// and skip it in subsequent passes with an [OPS-ALERT] so on-call can
// investigate. Any successful chunk fully resets the counter and clears
// the flag, so a transient bad spell self-heals. On-call can also clear
// `drainPoisoned` manually to force a retry.
const DRAIN_POISON_THRESHOLD = Math.max(
  2,
  Number(process.env.TEKMETRIC_DRAIN_POISON_THRESHOLD) || 5,
);

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

  // Poisoned-shop guard: skip shops already flagged as poisoned so the
  // drain doesn't re-walk a permanently failing shop on every pass.
  const progressCol = db.collection("tekmetric_backfill_progress");
  const poisonedRows = await progressCol
    .find({ shopId: { $in: targetShopIds }, drainPoisoned: true })
    .project({ shopId: 1, drainPoisonedReason: 1 })
    .toArray();
  const poisonedIds = new Set(poisonedRows.map((r: any) => Number(r.shopId)));
  if (poisonedIds.size > 0) {
    console.warn(
      `[Worker drain-tekmetric] skipping ${poisonedIds.size} poisoned shop(s): ${[...poisonedIds].join(",")} (clear drainPoisoned in tekmetric_backfill_progress to retry)`,
    );
  }

  const deadlineMs = Date.now() + DRAIN_ATTEMPT_MAX_MS;
  let shopsProcessed = 0;
  for (const shopId of targetShopIds) {
    if (Date.now() >= deadlineMs) break;
    if (poisonedIds.has(shopId)) continue;
    try {
      await backfillShopChunk(db, shopId);
      shopsProcessed++;
      // Success fully resets the consecutive-failure streak and clears
      // any poison flag (self-heal after a transient bad spell).
      await progressCol
        .updateOne(
          { shopId },
          {
            $set: { drainConsecutiveFailures: 0 },
            $unset: { drainPoisoned: "", drainPoisonedReason: "", drainPoisonedAt: "" },
          },
        )
        .catch(() => {});
    } catch (err: any) {
      const reason = String(err?.message || err);
      console.error(
        `[Worker drain-tekmetric] shop=${shopId} chunk error: ${reason}`,
      );
      // Keep going — one bad shop shouldn't block the rest. Failed
      // chunks get retried by the regular tekmetric-fullpage queue or
      // by the next drain attempt — unless the shop keeps failing, in
      // which case we flag it poisoned and stop re-picking it.
      try {
        const updated: any = await progressCol.findOneAndUpdate(
          { shopId },
          {
            $inc: { drainConsecutiveFailures: 1 },
            $set: {
              drainLastFailureAt: new Date(),
              drainLastFailureReason: reason.slice(0, 500),
            },
            $setOnInsert: { shopId },
          },
          { upsert: true, returnDocument: "after" },
        );
        const failures =
          updated?.value?.drainConsecutiveFailures ??
          updated?.drainConsecutiveFailures ??
          1;
        if (failures >= DRAIN_POISON_THRESHOLD) {
          await progressCol.updateOne(
            { shopId },
            {
              $set: {
                drainPoisoned: true,
                drainPoisonedAt: new Date(),
                drainPoisonedReason: `${failures} consecutive drain chunk failures; last: ${reason.slice(0, 300)}`,
              },
            },
          );
          poisonedIds.add(shopId);
          console.error(
            `[Worker drain-tekmetric] [OPS-ALERT] shop=${shopId} poisoned after ${failures} consecutive chunk failures — skipping until drainPoisoned is cleared in tekmetric_backfill_progress. Last error: ${reason.slice(0, 300)}`,
          );
        }
      } catch (trackErr: any) {
        console.warn(
          `[Worker drain-tekmetric] shop=${shopId} failed to record failure streak: ${trackErr?.message || trackErr}`,
        );
      }
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
