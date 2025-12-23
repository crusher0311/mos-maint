import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { fetchWorkOrderById } from "@/lib/integrations/protractor";
import { getTekmetricWorkOrderWithMileage } from "@/lib/tekmetric";

export async function POST(request: NextRequest) {
  try {
    const { shopId } = await request.json();
    
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
    }).toArray();

    if (activeVehicles.length === 0) {
      return NextResponse.json({ checked: 0, closed: 0, mileageUpdated: 0 });
    }

    let checkedCount = 0;
    let closedCount = 0;
    let mileageUpdatedCount = 0;
    const closedOrders: { vin: string; workOrderId: string; provider: string; mileage?: number }[] = [];

    for (const vehicle of activeVehicles) {
      const sources = vehicle.status?.sources || [];
      let currentMileage = vehicle.mileage || vehicle.odometer || vehicle.lastMileage || 0;
      
      for (const source of sources) {
        checkedCount++;
        
        let isClosed = false;
        let workOrderMileage: number | undefined;
        
        if (source.provider === "protractor") {
          try {
            const result = await fetchWorkOrderById(shopId, String(source.workOrderId));
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
            const woData = await getTekmetricWorkOrderWithMileage(source.workOrderId);
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
          currentMileage = workOrderMileage;
          mileageUpdatedCount++;
        }

        if (isClosed) {
          closedOrders.push({
            vin: vehicle.vin,
            workOrderId: String(source.workOrderId),
            provider: source.provider,
            mileage: workOrderMileage
          });
        }
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
