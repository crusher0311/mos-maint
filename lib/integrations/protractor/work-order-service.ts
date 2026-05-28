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
import { resolveProtractorConfig, protractorFetch } from "@/lib/integrations/protractor/client";
import { upsertProtractorWorkOrderSnapshot } from "@/lib/integrations/protractor";
import { touchDashboardUpdate } from "@/lib/data/repositories/shopware-cache";
import { getDb } from "@/lib/mongo";
import { NormalizedIngestionService } from "@/lib/integrations/core/normalized-ingestion";

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

          // Task #517 — Normalize on creation too, so a brand-new RO
          // (e.g. CAR Experts RO 3578) is visible in
          // `normalized_work_orders` immediately instead of waiting for
          // the next 2 AM cron tick.
          try {
            const db = await getDb();
            const shopDoc = await db.collection("shops").findOne(
              { shopId: { $in: [String(shopId), Number(shopId)] } },
              { projection: { enterpriseId: 1 } }
            );
            const enterpriseId = shopDoc?.enterpriseId as string | undefined;
            const ingestionService = new NormalizedIngestionService(
              db,
              'protractor',
              shopId,
              enterpriseId,
              { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true, ingestionVia: 'create-work-order' }
            );
            const r = await ingestionService.ingestWorkOrderWithAllEntities(woResult.data);
            console.log(`${prefix} Normalized WO ${workOrderId} action=${r.workOrder.action}`);
          } catch (normErr: any) {
            console.error(`${prefix} Normalize error (non-fatal):`, normErr?.message);
          }
        }
      }
    } catch (snapErr: any) {
      console.error(`${prefix} Snapshot error (non-fatal):`, snapErr?.message);
    }
  }

  try {
    await touchDashboardUpdate();
  } catch (err: any) {
    console.error(`${prefix} dashboard_updates bump failed:`, err?.message);
  }
}
