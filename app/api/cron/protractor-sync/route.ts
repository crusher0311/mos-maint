import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  fetchActiveWorkOrders,
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
      "protractor.apiKey": { $exists: true, $ne: null }
    }).toArray();

    const results: { shopId: number; synced: number; removed: number; error?: string }[] = [];

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

        for (const wo of activeWOs) {
          if (wo.VIN) {
            await upsertProtractorWorkOrderSnapshot(shopId, wo);
          }
        }

        const cachedWOs = await db.collection("protractor_work_orders").find({
          shopId: { $in: [String(shopId), Number(shopId)] },
          workflowStage: { $nin: ["Invoiced", "Void", "Closed"] }
        }).toArray();

        let removedCount = 0;
        for (const cached of cachedWOs) {
          const guid = cached.workOrderGuid || cached.data?.ID;
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

        results.push({ shopId, synced: activeWOs.length, removed: removedCount });
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
