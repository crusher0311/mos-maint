/**
 * BullMQ processor for `tekmetric-prepass` queue (task #513).
 *
 * Wraps `runJobsPrePass` and the generic vehicles/customers pre-pass
 * paths from `lib/integrations/tekmetric/full-page-backfill.ts`. The
 * existing functions are already deadline-aware and resumable across
 * runs, so the processor's only job is to call them with a generous
 * per-attempt deadline and re-enqueue when not done.
 */

import type { Job } from "bullmq";
import type { TekmetricPrePassJobData } from "@/lib/queue/producer";

// Per-attempt wall-clock budget. Matches the cron route's envelope so
// the bookkeeping inside the pre-pass functions (page-bounded loops)
// behaves identically to the in-process path.
const ATTEMPT_DEADLINE_MS = 4 * 60 * 1000;

export async function processTekmetricPrePass(
  job: Job<TekmetricPrePassJobData>,
): Promise<{ done: boolean; variant: string }> {
  const { shopId, tekmetricShopId, variant } = job.data;
  console.log(
    `[Worker tekmetric-prepass] shop=${shopId} variant=${variant} attempt=${job.attemptsMade + 1}`,
  );

  const { getDb } = await import("@/lib/mongo");
  const db = await getDb();

  const deadlineMs = Date.now() + ATTEMPT_DEADLINE_MS;
  const ownerToken = `bullmq:${job.id}`;

  let done = false;
  if (variant === "jobs") {
    const { runJobsPrePass } = await import(
      "@/lib/integrations/tekmetric/full-page-backfill"
    );
    const result = await runJobsPrePass(
      db,
      shopId,
      tekmetricShopId,
      deadlineMs,
      ownerToken,
    );
    done = result.done;
  } else {
    // Vehicles and customers pre-passes go through the existing
    // module-internal `runEntityPrePass` via their public wrappers
    // (runVehiclesPrePass / runCustomersPrePass). Both are exported
    // from the same module.
    const mod: any = await import(
      "@/lib/integrations/tekmetric/full-page-backfill"
    );
    const fn =
      variant === "vehicles"
        ? mod.runVehiclesPrePass
        : mod.runCustomersPrePass;
    if (typeof fn !== "function") {
      throw new Error(
        `[Worker tekmetric-prepass] No prepass function exported for variant=${variant}`,
      );
    }
    const result = await fn(db, shopId, tekmetricShopId, deadlineMs, ownerToken);
    done = result.done;
  }

  if (!done) {
    const { enqueueTekmetricPrePass } = await import("@/lib/queue/producer");
    await enqueueTekmetricPrePass({
      shopId,
      tekmetricShopId,
      variant,
      enqueuedAt: new Date().toISOString(),
    });
  }

  return { done, variant };
}
