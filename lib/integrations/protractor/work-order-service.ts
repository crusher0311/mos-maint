/**
 * Shared post-create helper for Protractor work orders.
 *
 * Both the dashboard route (`app/api/dashboard/protractor/create-work-order`)
 * and the extension route (`app/api/extension/protractor/create-work-order`)
 * need to do the same two best-effort follow-ups after a WO is created:
 *
 *   1. Re-fetch the WO and snapshot it into the dashboard cache so it appears
 *      in the unified dashboard immediately.
 *   2. Bump `dashboard_updates.lastUpdate` so any open dashboard tabs refresh.
 *
 * Keeping this in one place avoids the duplication that previously existed
 * between the two route files (Task #348 follow-up).
 */
import { getDb } from "@/lib/mongo";
import { resolveProtractorConfig, protractorFetch } from "@/lib/integrations/protractor/client";
import { upsertProtractorWorkOrderSnapshot } from "@/lib/integrations/protractor";

export async function finalizeProtractorWorkOrderCreation(
  shopId: number,
  workOrderId: string | null | undefined,
  opts: { logPrefix?: string } = {},
): Promise<void> {
  const prefix = opts.logPrefix || "[Protractor Create WO]";

  if (workOrderId) {
    try {
      const config = await resolveProtractorConfig(shopId);
      if (config.configured) {
        const woResult = await protractorFetch<any>(
          `/WorkOrder/${workOrderId}`,
          config,
          {},
          0,
          shopId,
        );
        if (woResult.ok && woResult.data) {
          await upsertProtractorWorkOrderSnapshot(shopId, woResult.data);
          console.log(`${prefix} Snapshotted WO ${workOrderId} to dashboard`);
        }
      }
    } catch (snapErr: any) {
      console.error(`${prefix} Snapshot error (non-fatal):`, snapErr?.message);
    }
  }

  try {
    const db = await getDb();
    await db.collection("dashboard_updates").updateOne(
      { _id: "lastUpdate" } as any,
      { $set: { timestamp: Date.now() } },
      { upsert: true },
    );
  } catch (err: any) {
    console.error(`${prefix} dashboard_updates bump failed:`, err?.message);
  }
}
