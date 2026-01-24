import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  fetchWorkOrderById,
  fetchVehicleById,
  upsertProtractorWorkOrderSnapshot,
  upsertProtractorVehicleSnapshot,
} from "@/lib/integrations/protractor";
import pLimit from "p-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: NextRequest) {
  if (process.env.DISABLE_PROTRACTOR_SYNC === "true") {
    return NextResponse.json({ 
      ok: true, 
      message: "Protractor sync disabled",
      disabled: true 
    });
  }

  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const startTime = Date.now();

  try {
    const pendingCallbacks = await db.collection("protractor_callback_events").find({
      needsFetch: true,
      processed: true,
      fetchedAt: { $exists: false }
    }).limit(50).toArray();

    if (pendingCallbacks.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "No pending callbacks to process",
        processed: 0,
        duration: `${Date.now() - startTime}ms`
      });
    }

    console.log(`[Callback Sync] Processing ${pendingCallbacks.length} pending callbacks`);

    const results: { type: string; id: string; shopId: number; success: boolean; error?: string }[] = [];
    const limit = pLimit(3);

    const groupedByShop = pendingCallbacks.reduce((acc, cb) => {
      const shopId = cb.shopId;
      if (!acc[shopId]) acc[shopId] = [];
      acc[shopId].push(cb);
      return acc;
    }, {} as Record<number, typeof pendingCallbacks>);

    for (const [shopIdStr, callbacks] of Object.entries(groupedByShop)) {
      const shopId = Number(shopIdStr);
      const config = await resolveProtractorConfig(shopId);
      
      if (!config.configured) {
        console.log(`[Callback Sync] Shop ${shopId} not configured, skipping ${callbacks.length} callbacks`);
        await db.collection("protractor_callback_events").updateMany(
          { _id: { $in: callbacks.map(c => c._id) } },
          { $set: { fetchedAt: new Date(), fetchError: "Shop not configured" } }
        );
        continue;
      }

      await Promise.all(callbacks.map(callback => limit(async () => {
        try {
          if (callback.type === "WorkOrder" && callback.objectId) {
            const woResult = await fetchWorkOrderById(shopId, callback.objectId);
            
            if (woResult.ok && woResult.workOrder) {
              const wo = woResult.workOrder;
              await upsertProtractorWorkOrderSnapshot(shopId, wo);
              
              const vehicle = wo.ServiceItem;
              const vin = vehicle?.VIN?.toUpperCase();
              
              if (vin && vehicle) {
                await upsertProtractorVehicleSnapshot(shopId, vin, vehicle);
                
                const currentOdometer = wo.InUsage ?? vehicle.Usage ?? wo.Odometer ?? vehicle.Odometer;
                const stage = wo.WorkflowStage || wo.Status || "Open";
                
                const workOrderSource = {
                  provider: "protractor",
                  workOrderId: String(wo.ID),
                  workOrderNumber: wo.WorkOrderNumber,
                  status: stage,
                  addedAt: new Date(),
                };

                const existingVehicle = await db.collection("vehicles").findOne({
                  $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
                  vin,
                });

                if (existingVehicle) {
                  const existingSources = existingVehicle.status?.sources || [];
                  const sourceIndex = existingSources.findIndex(
                    (s: any) => s.provider === "protractor" && String(s.workOrderId) === String(wo.ID)
                  );
                  
                  let updatedSources;
                  if (sourceIndex >= 0) {
                    updatedSources = [...existingSources];
                    updatedSources[sourceIndex] = workOrderSource;
                  } else {
                    updatedSources = [...existingSources, workOrderSource];
                  }

                  await db.collection("vehicles").updateOne(
                    { _id: existingVehicle._id },
                    {
                      $set: {
                        year: vehicle.Year,
                        make: vehicle.Make,
                        model: vehicle.Model,
                        license: vehicle.LicensePlate,
                        lastMileage: currentOdometer,
                        updatedAt: new Date(),
                        protractorId: vehicle.ID,
                        "status.active": true,
                        "status.sources": updatedSources,
                        "status.updatedAt": new Date(),
                      },
                    }
                  );
                } else {
                  await db.collection("vehicles").insertOne({
                    shopId: String(shopId),
                    vin,
                    year: vehicle.Year,
                    make: vehicle.Make,
                    model: vehicle.Model,
                    license: vehicle.LicensePlate,
                    lastMileage: currentOdometer,
                    protractorId: vehicle.ID,
                    status: {
                      active: true,
                      sources: [workOrderSource],
                      updatedAt: new Date(),
                    },
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  });
                }
                
                console.log(`[Callback Sync] Shop ${shopId}: Synced WO ${wo.WorkOrderNumber} with VIN ${vin}`);
              }
              
              results.push({ type: "WorkOrder", id: callback.objectId, shopId, success: true });
            } else {
              results.push({ type: "WorkOrder", id: callback.objectId, shopId, success: false, error: woResult.error });
            }
          } else if (callback.type === "ServiceItem" && callback.objectId) {
            const vehicleResult = await fetchVehicleById(shopId, callback.objectId);
            
            if (vehicleResult.ok && vehicleResult.vehicle) {
              const vehicle = vehicleResult.vehicle;
              const vin = vehicle.VIN?.toUpperCase();
              
              if (vin) {
                await upsertProtractorVehicleSnapshot(shopId, vin, vehicle);
                
                await db.collection("vehicles").updateOne(
                  {
                    $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
                    vin
                  },
                  {
                    $set: {
                      year: vehicle.Year,
                      make: vehicle.Make,
                      model: vehicle.Model,
                      license: vehicle.LicensePlate,
                      lastMileage: vehicle.Usage || vehicle.Odometer,
                      protractorId: vehicle.ID,
                      updatedAt: new Date(),
                    }
                  },
                  { upsert: false }
                );
                
                console.log(`[Callback Sync] Shop ${shopId}: Updated vehicle ${vin}`);
              }
              
              results.push({ type: "ServiceItem", id: callback.objectId, shopId, success: true });
            } else {
              results.push({ type: "ServiceItem", id: callback.objectId, shopId, success: false, error: vehicleResult.error });
            }
          }

          await db.collection("protractor_callback_events").updateOne(
            { _id: callback._id },
            { $set: { fetchedAt: new Date(), needsFetch: false } }
          );
        } catch (err: any) {
          console.error(`[Callback Sync] Error processing callback:`, err.message);
          await db.collection("protractor_callback_events").updateOne(
            { _id: callback._id },
            { $set: { fetchedAt: new Date(), fetchError: err.message } }
          );
          results.push({ type: callback.type, id: callback.objectId, shopId, success: false, error: err.message });
        }
      })));
    }

    const duration = Date.now() - startTime;
    const successCount = results.filter(r => r.success).length;
    console.log(`[Callback Sync] Completed in ${duration}ms: ${successCount}/${results.length} successful`);

    return NextResponse.json({
      ok: true,
      duration: `${duration}ms`,
      processed: results.length,
      successful: successCount,
      results
    });
  } catch (err: any) {
    console.error("[Callback Sync] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
