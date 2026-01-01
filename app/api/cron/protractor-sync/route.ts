import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  fetchActiveWorkOrders,
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

    const results: { shopId: number; synced: number; removed: number; vehiclesUpdated?: number; error?: string }[] = [];

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
        const INVOICED_STAGES = ["Invoiced", "Invoice", "Void", "Closed", "Complete", "Completed"];
        
        const stageCounts: Record<string, number> = {};
        for (const wo of activeWOs) {
          const stage = wo.WorkflowStage || (wo as any).Status || "Unknown";
          stageCounts[stage] = (stageCounts[stage] || 0) + 1;
        }
        console.log(`[Cron] Shop ${shopId} - WorkflowStage counts:`, stageCounts);

        let vehiclesUpdated = 0;
        const limit = pLimit(3);

        const detailedWOs = await Promise.all(
          activeWOs.map((wo) =>
            limit(async () => {
              try {
                const detailResult = await fetchWorkOrderById(shopId, wo.ID);
                if (detailResult.ok && detailResult.workOrder) {
                  return detailResult.workOrder;
                }
              } catch (err) {
                console.log(`[Cron] Failed to fetch WO ${wo.ID} details`);
              }
              return wo;
            })
          )
        );

        for (const wo of detailedWOs) {
          const stage = wo.WorkflowStage || (wo as any).Status || "";
          let vin = wo.ServiceItem?.VIN?.toUpperCase() || (wo as any).VIN?.toUpperCase();
          let vehicle = wo.ServiceItem;
          
          // Fallback: If VIN is missing but ServiceItemID exists, fetch vehicle details separately
          if (!vin && wo.ServiceItemID) {
            try {
              const vehicleResult = await fetchVehicleById(shopId, wo.ServiceItemID);
              if (vehicleResult.ok && vehicleResult.vehicle?.VIN) {
                vin = vehicleResult.vehicle.VIN.toUpperCase();
                vehicle = vehicleResult.vehicle;
                console.log(`[Cron] Shop ${shopId} - Recovered VIN ${vin} for WO ${wo.WorkOrderNumber} via ServiceItemID fallback`);
              }
            } catch (err) {
              console.log(`[Cron] Shop ${shopId} - Failed to fetch vehicle for WO ${wo.WorkOrderNumber}:`, err);
            }
          }
          
          if (vin) {
            await upsertProtractorWorkOrderSnapshot(shopId, wo);
            
            if (vehicle) {
              await upsertProtractorVehicleSnapshot(shopId, vin, vehicle);
              
              const currentOdometer = (wo as any).InUsage ?? vehicle.Usage ?? (wo as any).Odometer ?? vehicle.Odometer;
              
              const workOrderSource = {
                provider: "protractor",
                workOrderId: String(wo.ID),
                workOrderNumber: wo.WorkOrderNumber,
                status: stage || "Open",
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
              vehiclesUpdated++;
            }
            
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

        const cachedWOs = await db.collection("protractor_work_orders").find({
          shopId: { $in: [String(shopId), Number(shopId)] },
          $or: [
            { workflowStage: { $nin: INVOICED_STAGES } },
            { workflowStage: null },
            { workflowStage: "" }
          ]
        }).toArray();

        let removedCount = 0;
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

        results.push({ shopId, synced: detailedWOs.length, removed: removedCount, vehiclesUpdated });
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
