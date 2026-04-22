import { NextRequest, NextResponse } from "next/server";
import pLimit from "p-limit";
import { getDb } from "@/lib/mongo";
import { fetchWorkOrderById } from "@/lib/integrations/protractor";
import { getTekmetricWorkOrderWithMileage } from "@/lib/tekmetric";

const BATCH_SIZE = 3; // Reduced from 5 to avoid rate limits
const BATCH_DELAY_MS = 3000; // Increased from 2000
const MAX_VEHICLES_PER_REQUEST = 20; // Reduced from 50 to limit API calls

// In-memory cache to avoid re-checking same work orders frequently
const recentlyCheckedOrders = new Map<string, { checkedAt: number; isClosed: boolean }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

function getCachedResult(workOrderId: string): { isClosed: boolean } | null {
  const cached = recentlyCheckedOrders.get(workOrderId);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return { isClosed: cached.isClosed };
  }
  return null;
}

function setCachedResult(workOrderId: string, isClosed: boolean) {
  recentlyCheckedOrders.set(workOrderId, { checkedAt: Date.now(), isClosed });
  // Clean up old entries periodically
  if (recentlyCheckedOrders.size > 500) {
    const now = Date.now();
    for (const [key, value] of recentlyCheckedOrders) {
      if (now - value.checkedAt > CACHE_TTL_MS) {
        recentlyCheckedOrders.delete(key);
      }
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    let shopId: string | number | undefined;
    
    try {
      const body = await request.json();
      shopId = body?.shopId;
    } catch {
      return NextResponse.json({ error: "Invalid or empty request body" }, { status: 400 });
    }
    
    if (!shopId) {
      return NextResponse.json({ error: "shopId required" }, { status: 400 });
    }

    const db = await getDb();

    const shop = await db.collection("shops").findOne({ 
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] 
    });
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const activeVehicles = await db.collection("vehicles").find({
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
      "status.active": true,
      "status.sources": { $exists: true, $ne: [] }
    }).limit(MAX_VEHICLES_PER_REQUEST).toArray();

    if (activeVehicles.length === 0) {
      return NextResponse.json({ checked: 0, closed: 0, mileageUpdated: 0 });
    }

    let checkedCount = 0;
    let closedCount = 0;
    let mileageUpdatedCount = 0;
    const closedOrders: { vin: string; workOrderId: string; provider: string; mileage?: number }[] = [];

    const workOrderChecks: Array<{
      vehicle: any;
      source: any;
      currentMileage: number;
    }> = [];

    for (const vehicle of activeVehicles) {
      const sources = vehicle.status?.sources || [];
      const currentMileage = vehicle.mileage || vehicle.odometer || vehicle.lastMileage || 0;
      
      for (const source of sources) {
        workOrderChecks.push({ vehicle, source, currentMileage });
      }
    }

    const limit = pLimit(BATCH_SIZE);
    
    for (let i = 0; i < workOrderChecks.length; i += BATCH_SIZE) {
      const batch = workOrderChecks.slice(i, i + BATCH_SIZE);
      
      const batchResults = await Promise.all(
        batch.map(({ vehicle, source, currentMileage }) =>
          limit(async () => {
            checkedCount++;
            let isClosed = false;
            let workOrderMileage: number | undefined;

            if (source.provider === "protractor") {
              try {
                const result = await fetchWorkOrderById(shopId!, String(source.workOrderId));
                if (result.ok && result.workOrder) {
                  const wo = result.workOrder;
                  const status = (wo.Status || wo.WorkflowStage || "").toUpperCase();
                  isClosed = status === "INVOICED" || status === "INVOICE" || 
                             status === "CLOSED" || status === "VOID";
                  workOrderMileage = wo.Odometer || wo.InUsage || wo.OutUsage ||
                                     (wo as any).ServiceItems?.[0]?.Odometer ||
                                     (wo as any).ServiceItem?.Odometer;
                }
              } catch (err) {
                console.error(`Error checking Protractor WO ${source.workOrderId}:`, err);
              }
            } else if (source.provider === "tekmetric" && shop.tekmetric?.shopId) {
              try {
                const woData = await getTekmetricWorkOrderWithMileage(source.workOrderId, shopId ? Number(shopId) : undefined);
                if (woData) {
                  const normalizedStatus = woData.status?.toUpperCase();
                  isClosed = normalizedStatus === "INVOICED" || normalizedStatus === "INVOICE" || 
                             normalizedStatus === "VOID" || normalizedStatus === "CLOSED";
                  workOrderMileage = woData.mileageOut ?? woData.mileageIn ?? undefined;
                }
              } catch (err) {
                console.error(`Error checking Tekmetric RO ${source.workOrderId}:`, err);
              }
            }

            return { vehicle, source, currentMileage, isClosed, workOrderMileage };
          })
        )
      );

      for (const result of batchResults) {
        const { vehicle, source, currentMileage, isClosed, workOrderMileage } = result;

        if (workOrderMileage && workOrderMileage > 0 && workOrderMileage > currentMileage) {
          await db.collection("vehicles").updateOne(
            { _id: vehicle._id },
            {
              $set: {
                mileage: workOrderMileage,
                mileageSource: source.provider,
                mileageUpdatedAt: new Date(),
                updatedAt: new Date()
              }
            }
          );
          mileageUpdatedCount++;
        }

        if (isClosed) {
          closedOrders.push({
            vin: vehicle.vin,
            workOrderId: String(source.workOrderId),
            provider: source.provider,
            mileage: workOrderMileage
          });
          
          if (source.provider === "protractor") {
            await db.collection("protractor_work_orders").updateMany(
              {
                $and: [
                  { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
                  { $or: [
                    { workOrderGuid: source.workOrderId },
                    { "data.ID": source.workOrderId }
                  ]}
                ]
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

      if (i + BATCH_SIZE < workOrderChecks.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    for (const order of closedOrders) {
      const vehicle = await db.collection("vehicles").findOne({
        $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
        vin: order.vin
      });

      if (vehicle) {
        const existingSources = vehicle.status?.sources || [];
        const updatedSources = existingSources.filter(
          (s: any) => !(s.provider === order.provider && String(s.workOrderId) === order.workOrderId)
        );

        const hasActiveSources = updatedSources.length > 0;

        await db.collection("vehicles").updateOne(
          { _id: vehicle._id },
          {
            $set: {
              "status.active": hasActiveSources,
              "status.sources": updatedSources,
              ...(hasActiveSources ? {} : { "status.lastClosedAt": new Date() }),
              updatedAt: new Date()
            }
          }
        );

        if (!hasActiveSources) {
          closedCount++;
        }
      }
    }

    return NextResponse.json({
      checked: checkedCount,
      closed: closedCount,
      mileageUpdated: mileageUpdatedCount,
      closedOrders: closedOrders.map(o => `${o.vin} (${o.provider} #${o.workOrderId})`)
    });

  } catch (error: any) {
    console.error("Check closed orders error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
