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
import { NormalizedIngestionService } from "@/lib/normalized-ingestion";
import pLimit from "p-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: NextRequest) {
  // Check if Protractor sync is disabled (e.g., on Render where IP isn't whitelisted)
  if (process.env.DISABLE_PROTRACTOR_SYNC === "true") {
    return NextResponse.json({ 
      ok: true, 
      message: "Protractor sync disabled via DISABLE_PROTRACTOR_SYNC environment variable",
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
    const shops = await db.collection("shops").find({
      $or: [
        { "protractor.apiKey": { $exists: true, $nin: [null, ""] } },
        { "protractorApiKey": { $exists: true, $nin: [null, ""] } },
        { "protractor.connectionId": { $exists: true, $nin: [null, ""] } },
        { "protractorConnectionId": { $exists: true, $nin: [null, ""] } }
      ]
    }).toArray();

    const results: { shopId: number; synced: number; removed: number; vehiclesUpdated?: number; error?: string }[] = [];
    const syncedVinsPerShop: { shopId: number; vins: string[] }[] = [];

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
        const shopSyncedVins: string[] = [];
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
              shopSyncedVins.push(vin);
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
        
        if (shopSyncedVins.length > 0) {
          syncedVinsPerShop.push({ shopId, vins: shopSyncedVins });
        }
        
        // Dual-write to normalized collections (pass full work order payloads)
        try {
          const workOrdersForNormalized = detailedWOs.filter(wo => wo.ServiceItem?.VIN);
          
          if (workOrdersForNormalized.length > 0) {
            const shop = await db.collection("shops").findOne({ shopId: String(shopId) });
            const enterpriseId = shop?.enterpriseId as string | undefined;
            
            const ingestionService = new NormalizedIngestionService(
              db,
              'protractor',
              shopId,
              enterpriseId,
              { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true }
            );
            
            const result = await ingestionService.ingestWorkOrderBatchWithAllEntities(workOrdersForNormalized);
            console.log(`[Cron] Protractor sync normalized: shop ${shopId}, WOs: ${result.workOrders.created}/${result.workOrders.updated}/${result.workOrders.skipped}, payments: ${result.payments.created}, inspections: ${result.inspections.created}, recommendations: ${result.recommendations.created}`);
          }
        } catch (normErr: any) {
          console.log(`[Cron] Protractor sync normalized ingestion error for shop ${shopId}:`, normErr.message);
        }
      } catch (err: any) {
        results.push({ shopId, synced: 0, removed: 0, error: err.message });
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[Cron] Protractor sync completed in ${duration}ms:`, results);

    // Fire-and-forget plan pre-generation for ALL dashboard-visible vehicles
    console.log(`[Cron] Starting Protractor pregeneration, CRON_SECRET set: ${!!CRON_SECRET}`);
    if (CRON_SECRET) {
      try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL 
          || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
          || `http://localhost:${process.env.PORT || 5000}`;
        
        console.log(`[Cron] Protractor pregeneration baseUrl: ${baseUrl}`);
        
        // Get fresh db connection for pregeneration (original may be stale after 8+ min sync)
        const freshDb = await getDb();
        
        // Get all Protractor shops - use same query as sync to include legacy field names
        const protractorShops = await freshDb.collection("shops")
          .find({ 
            $or: [
              { "protractor.apiKey": { $exists: true, $nin: [null, ""] } },
              { "protractorApiKey": { $exists: true, $nin: [null, ""] } },
              { "protractor.connectionId": { $exists: true, $nin: [null, ""] } },
              { "protractorConnectionId": { $exists: true, $nin: [null, ""] } }
            ]
          })
          .project({ _id: 0, shopId: 1, protractor: 1, protractorApiKey: 1, protractorConnectionId: 1 })
          .toArray();
        
        console.log(`[Cron] Found ${protractorShops.length} Protractor shops for pregeneration`);
        
        let triggeredCount = 0;
        for (const shop of protractorShops) {
          const shopId = shop.shopId;
          if (!shopId) continue;
          
          // Get top 50 vehicles by most recent work order (dashboard order)
          
          // Debug: count work orders for this shop
          const woCount = await freshDb.collection("work_orders").countDocuments({
            shopId: { $in: [shopId, String(shopId), Number(shopId)] }
          });
          console.log(`[Cron] Protractor Shop ${shopId}: Found ${woCount} work orders`);
          
          const recentVehicles = await freshDb.collection("work_orders")
            .aggregate([
              { $match: { shopId: { $in: [shopId, String(shopId), Number(shopId)] } } },
              { $sort: { updatedAt: -1 } },
              { $group: { _id: "$vin", lastUpdated: { $first: "$updatedAt" } } },
              { $sort: { lastUpdated: -1 } },
              { $limit: 50 },
            ])
            .toArray();
          
          console.log(`[Cron] Protractor Shop ${shopId}: Aggregated ${recentVehicles.length} unique VINs`);
          
          const vins = recentVehicles
            .map(v => v._id)
            .filter(v => v && typeof v === 'string' && v.length === 17);
          
          console.log(`[Cron] Protractor Shop ${shopId}: ${vins.length} valid VINs after filter`);
          
          if (vins.length > 0) {
            triggeredCount++;
            fetch(`${baseUrl}/api/internal/plan-pregenerate`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CRON_SECRET}`,
              },
              body: JSON.stringify({ shopId, vins }),
            }).catch(err => console.log(`[Cron] Plan pregenerate failed for shop ${shopId}:`, err.message));
          }
        }
        console.log(`[Cron] Triggered plan pre-generation for ${triggeredCount}/${protractorShops.length} Protractor shops with vehicles`);
      } catch (pregenerateErr: any) {
        console.error(`[Cron] Protractor pregenerate error:`, pregenerateErr.message);
      }
    }

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
