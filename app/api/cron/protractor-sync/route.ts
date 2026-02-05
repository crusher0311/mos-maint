/**
 * Protractor Daily Sync Cron Job
 * 
 * SCHEDULE: Daily at 2:00 AM EST via external scheduler (e.g., Render cron)
 * 
 * This endpoint is called ONCE daily as a sanity check to catch any work orders
 * or vehicles that may have been missed by webhooks. Real-time updates are
 * handled by the Protractor webhook handler at /api/webhooks/protractor/[token].
 * 
 * The frequent sync worker (protractor-sync-worker.ts) has been DISABLED to
 * avoid excessive API requests (~170K+/day). This cron approach reduces
 * Protractor API usage by ~99%.
 * 
 * To manually trigger: GET /api/cron/protractor-sync with Authorization: Bearer {CRON_SECRET}
 */
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
import { attributeRevenueFromWorkOrder } from "@/lib/enterprise";
import pLimit from "p-limit";
import { Db } from "mongodb";

const QUEUE_BATCH_SIZE = 50;
const MAX_ATTEMPTS = 3;

async function processWebhookQueue(db: Db): Promise<{ processed: number; failed: number }> {
  // Process unprocessed GET callback events (webhooks)
  // These are logged immediately when received, processed here with priority
  const pendingItems = await db.collection("protractor_callback_events")
    .find({ 
      method: "GET",
      processed: false,
      $or: [
        { attempts: { $exists: false } },
        { attempts: { $lt: MAX_ATTEMPTS } }
      ]
    })
    .sort({ priority: 1, receivedAt: 1 })
    .limit(QUEUE_BATCH_SIZE)
    .toArray();

  if (pendingItems.length === 0) {
    return { processed: 0, failed: 0 };
  }

  let processed = 0;
  let failed = 0;

  for (const item of pendingItems) {
    try {
      await db.collection("protractor_callback_events").updateOne(
        { _id: item._id },
        { 
          $set: { processingStartedAt: new Date() },
          $inc: { attempts: 1 }
        }
      );

      const { shopId, objectType, objectId, operation } = item;

      if (objectType === "ServiceItem" && objectId) {
        const result = await fetchVehicleById(shopId, objectId);
        if (result.ok && result.vehicle?.VIN) {
          await upsertProtractorVehicleSnapshot(shopId, result.vehicle.VIN, result.vehicle);
          
          await db.collection("protractor_callback_events").updateOne(
            { objectId, objectType, processed: false },
            { $set: { processed: true, processedAt: new Date(), vin: result.vehicle.VIN } }
          );
        }
      }

      if (objectType === "WorkOrder" && objectId) {
        const result = await fetchWorkOrderById(shopId, objectId);
        if (result.ok && result.workOrder) {
          await upsertProtractorWorkOrderSnapshot(shopId, result.workOrder);
          
          if (result.workOrder.Completed) {
            const vin = result.workOrder.ServiceItem?.VIN?.toUpperCase();
            if (vin) {
              const savedWO = await db.collection("protractor_work_orders").findOne({
                shopId,
                workOrderId: objectId
              });
              
              if (savedWO && savedWO.packageSummaries?.length > 0) {
                try {
                  const attribution = await attributeRevenueFromWorkOrder(
                    shopId,
                    objectId,
                    vin,
                    savedWO.packageSummaries,
                    "protractor"
                  );
                  if (attribution.matched > 0) {
                    console.log(`[Queue] Revenue attribution: ${attribution.matched} jobs, $${attribution.revenue.toFixed(2)}`);
                  }
                } catch (e) {
                  // Revenue attribution is non-critical
                }
              }
            }
          }
          
          await db.collection("protractor_callback_events").updateOne(
            { objectId, objectType, processed: false },
            { $set: { processed: true, processedAt: new Date(), workOrderNumber: result.workOrder.WorkOrderNumber } }
          );
        }
      }

      // Mark as processed on success
      await db.collection("protractor_callback_events").updateOne(
        { _id: item._id },
        { $set: { processed: true, processedAt: new Date() } }
      );

      processed++;

    } catch (error: any) {
      // Mark with error - will retry on next cron run if under MAX_ATTEMPTS
      await db.collection("protractor_callback_events").updateOne(
        { _id: item._id },
        { 
          $set: { 
            lastError: error.message,
            lastErrorAt: new Date()
          }
        }
      );

      failed++;
    }
  }

  return { processed, failed };
}

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

  // Process high-priority webhook queue first
  try {
    const queueResult = await processWebhookQueue(db);
    console.log(`[Cron] Processed webhook queue: ${queueResult.processed} items, ${queueResult.failed} failed`);
  } catch (queueErr: any) {
    console.error("[Cron] Webhook queue processing error:", queueErr.message);
  }

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
        
        const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "mos-prefetch-worker-2024";
        
        let triggeredCount = 0;
        for (const shop of protractorShops) {
          const shopId = shop.shopId;
          if (!shopId) continue;
          
          try {
            // Use the internal prefetch-vehicles endpoint (handles vehicle priority + mileage filtering)
            const vehiclesRes = await fetch(`${baseUrl}/api/internal/prefetch-vehicles?shopId=${shopId}&limit=50`, {
              headers: { 'x-internal-secret': INTERNAL_SECRET }
            });
            
            if (!vehiclesRes.ok) {
              console.log(`[Cron] Protractor Shop ${shopId}: Failed to fetch vehicles (${vehiclesRes.status})`);
              continue;
            }
            
            const { rows } = await vehiclesRes.json();
            const vins = (rows || [])
              .map((v: any) => v.vin)
              .filter((v: string) => v && v.length === 17);
            
            console.log(`[Cron] Protractor Shop ${shopId}: ${vins.length} VINs for pregeneration`);
            
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
          } catch (shopErr: any) {
            console.log(`[Cron] Protractor Shop ${shopId} pregenerate error:`, shopErr.message);
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
