import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  fetchActiveWorkOrders,
  fetchWorkOrderById,
  upsertProtractorWorkOrderSnapshot,
} from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const startTime = Date.now();

  try {
    const shops = await db.collection("shops").find({
      $or: [
        { "protractor.apiKey": { $exists: true, $nin: [null, ""] } },
        { "protractorApiKey": { $exists: true, $nin: [null, ""] } },
        { "protractor.connectionId": { $exists: true, $nin: [null, ""] } },
        { "protractorConnectionId": { $exists: true, $nin: [null, ""] } }
      ]
    }).toArray();

    const results: { shopId: number; synced: number; removed: number; staleDeleted?: number; error?: string }[] = [];

    for (const shop of shops) {
      const shopId = Number(shop.shopId);
      const config = await resolveProtractorConfig(shopId);
      
      if (!config.configured) continue;

      try {
        const activeResult = await fetchActiveWorkOrders(shopId, { readInProgress: true });
        
        if (!activeResult.ok || !activeResult.workOrders) {
          results.push({ shopId, synced: 0, removed: 0, error: activeResult.error });
          continue;
        }

        const activeWOs = activeResult.workOrders;
        const activeGuids = new Set(activeWOs.map(wo => wo.ID));
        const activeWoNumbers = new Set(activeWOs.map(wo => wo.WorkOrderNumber));
        const INVOICED_STAGES = ["Invoiced", "Invoice", "Void", "Closed", "Complete", "Completed"];
        
        const stageCounts: Record<string, number> = {};
        for (const wo of activeWOs) {
          const stage = wo.WorkflowStage || (wo as any).Status || "Unknown";
          stageCounts[stage] = (stageCounts[stage] || 0) + 1;
        }
        console.log(`[Cron] Shop ${shopId} - WorkflowStage counts:`, stageCounts);

        for (const wo of activeWOs) {
          const vin = (wo as any).VIN || (wo as any).ServiceItem?.VIN;
          const stage = wo.WorkflowStage || (wo as any).Status || "";
          
          if (vin) {
            await upsertProtractorWorkOrderSnapshot(shopId, wo);
            
            if (INVOICED_STAGES.some(s => stage.toLowerCase().includes(s.toLowerCase()))) {
              await db.collection("protractor_work_orders").updateMany(
                {
                  shopId: { $in: [String(shopId), Number(shopId)] },
                  $or: [{ workOrderGuid: wo.ID }, { "data.ID": wo.ID }]
                },
                {
                  $set: {
                    workflowStage: "Invoiced",
                    status: "Invoiced",
                    closedAt: new Date(),
                    updatedAt: new Date()
                  }
                }
              );
            }
          }
        }

        // Delete stale records that don't have workflowStage (old cache format)
        const staleResult = await db.collection("protractor_work_orders").deleteMany({
          shopId: { $in: [String(shopId), Number(shopId)] },
          workflowStage: { $exists: false }
        });
        
        // Also delete records with null/empty workflowStage that aren't in active list
        const cachedWOs = await db.collection("protractor_work_orders").find({
          shopId: { $in: [String(shopId), Number(shopId)] },
          $or: [
            { workflowStage: { $nin: INVOICED_STAGES } },
            { workflowStage: null },
            { workflowStage: "" }
          ]
        }).toArray();

        let removedCount = staleResult.deletedCount || 0;
        for (const cached of cachedWOs) {
          const guid = cached.workOrderGuid || cached.workOrderId || cached.data?.ID;
          if (guid && !activeGuids.has(guid)) {
            await db.collection("protractor_work_orders").updateOne(
              { _id: cached._id },
              {
                $set: {
                  workflowStage: "Invoiced",
                  status: "Invoiced",
                  closedAt: new Date(),
                  updatedAt: new Date()
                }
              }
            );
            removedCount++;
          }
        }

        results.push({ shopId, synced: activeWOs.length, removed: removedCount, staleDeleted: staleResult.deletedCount });
      } catch (err: any) {
        results.push({ shopId, synced: 0, removed: 0, error: err.message });
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[Cron] Protractor sync completed in ${duration}ms:`, results);

    return NextResponse.json({
      ok: true,
      duration: `${duration}ms`,
      shops: results
    });
  } catch (err: any) {
    console.error("[Cron] Protractor sync error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
