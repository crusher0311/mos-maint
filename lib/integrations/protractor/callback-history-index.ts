import type { Db } from "mongodb";
import { extractJobIndexFromWorkOrder, computeJobHash } from "@/lib/job-index";
import type { CallbackHistoryOutcome } from "./callback-outcomes";

/**
 * Evidence comes from the actual index operation, never from relay success or
 * the snapshot's jobsIndexed marker. Only bounded counters leave this function.
 */
export async function indexCallbackHistory(
  db: Db,
  shopId: number,
  workOrder: Parameters<typeof extractJobIndexFromWorkOrder>[1],
): Promise<CallbackHistoryOutcome> {
  let indexedJobs = 0;
  let changedJobs = 0;
  try {
    const entries = extractJobIndexFromWorkOrder(shopId, workOrder, "protractor");
    for (const entry of entries) {
      const filter = { shopId, workOrderId: entry.workOrderId, servicePackageId: entry.servicePackageId };
      const existing = await db.collection("job_index").findOne(filter);
      const contentHash = computeJobHash(entry);
      if (existing?.contentHash !== contentHash) {
        const result = await db.collection("job_index").updateOne(
          filter, { $set: { ...entry, contentHash } }, { upsert: true },
        );
        if (!result.acknowledged) throw new Error("Index write not acknowledged");
        changedJobs++;
      }
      indexedJobs++;
    }
    return {
      category: indexedJobs ? "applied_indexed" : "terminal_no_history",
      reason: indexedJobs ? "indexed" : "no_jobs",
      indexedJobs,
      changedJobs,
    };
  } catch {
    // Partial writes are evidence of a failure, not a fully applied callback.
    // Preserve the queue's existing non-retry behavior for indexing failures.
    return { category: "failed", reason: "indexing_failed", indexedJobs, changedJobs };
  }
}