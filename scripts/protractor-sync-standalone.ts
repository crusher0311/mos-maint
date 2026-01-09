#!/usr/bin/env npx tsx
// Standalone Protractor Sync Worker - runs sync logic directly without HTTP calls
// Usage: npx tsx scripts/protractor-sync-standalone.ts

import { getDb } from "../lib/mongo";
import {
  resolveProtractorConfig,
  fetchActiveWorkOrders,
  fetchWorkOrderById,
  fetchVehicleById,
  upsertProtractorWorkOrderSnapshot,
  upsertProtractorVehicleSnapshot,
} from "../lib/integrations/protractor";
import { NormalizedIngestionService } from "../lib/normalized-ingestion";
import pLimit from "p-limit";

const BASE_SYNC_INTERVAL_MS = 60 * 1000; // 60 seconds for standalone
const MAX_SYNC_INTERVAL_MS = 300 * 1000; // 5 minutes max backoff

let consecutiveFailures = 0;
let totalSyncs = 0;
let successfulSyncs = 0;

function getAdaptiveInterval(): number {
  if (consecutiveFailures === 0) return BASE_SYNC_INTERVAL_MS;
  const backoffMultiplier = Math.min(Math.pow(2, consecutiveFailures), 5);
  return Math.min(BASE_SYNC_INTERVAL_MS * backoffMultiplier, MAX_SYNC_INTERVAL_MS);
}

async function runProtractorSync(): Promise<{ ok: boolean; duration: string; shops: any[] }> {
  const db = await getDb();
  const startTime = Date.now();
  const INVOICED_STAGES = ["Invoiced", "Invoice", "Void", "Closed", "Complete", "Completed"];

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
      
      const stageCounts: Record<string, number> = {};
      for (const wo of activeWOs) {
        const stage = wo.WorkflowStage || (wo as any).Status || "Unknown";
        stageCounts[stage] = (stageCounts[stage] || 0) + 1;
      }
      console.log(`[Sync] Shop ${shopId} - WorkflowStage counts:`, stageCounts);

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
              console.log(`[Sync] Failed to fetch WO ${wo.ID} details`);
            }
            return wo;
          })
        )
      );

      for (const wo of detailedWOs) {
        const stage = wo.WorkflowStage || (wo as any).Status || "";
        let vin = wo.ServiceItem?.VIN?.toUpperCase() || (wo as any).VIN?.toUpperCase();
        let vehicle = wo.ServiceItem;
        
        if (!vin && wo.ServiceItemID) {
          try {
            const vehicleResult = await fetchVehicleById(shopId, wo.ServiceItemID);
            if (vehicleResult.ok && vehicleResult.vehicle?.VIN) {
              vin = vehicleResult.vehicle.VIN.toUpperCase();
              vehicle = vehicleResult.vehicle;
            }
          } catch (err) {
            // Ignore
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
      
      // Dual-write to normalized collections
      try {
        const workOrdersForNormalized = detailedWOs.filter(wo => wo.ServiceItem?.VIN);
        
        if (workOrdersForNormalized.length > 0) {
          const shopDoc = await db.collection("shops").findOne({ shopId: String(shopId) });
          const enterpriseId = shopDoc?.enterpriseId as string | undefined;
          
          const ingestionService = new NormalizedIngestionService(
            db,
            'protractor',
            shopId,
            enterpriseId,
            { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true }
          );
          
          const result = await ingestionService.ingestWorkOrderBatchWithAllEntities(workOrdersForNormalized);
          console.log(`[Sync] Protractor normalized: shop ${shopId}, WOs: ${result.workOrders.created}/${result.workOrders.updated}/${result.workOrders.skipped}`);
        }
      } catch (normErr: any) {
        console.log(`[Sync] Normalized ingestion error for shop ${shopId}:`, normErr.message);
      }
    } catch (err: any) {
      results.push({ shopId, synced: 0, removed: 0, error: err.message });
    }
  }

  const duration = Date.now() - startTime;
  return { ok: true, duration: `${duration}ms`, shops: results };
}

async function runSync(): Promise<void> {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Running Protractor sync...`);
  
  try {
    const result = await runProtractorSync();
    console.log(`[${timestamp}] Sync complete:`, JSON.stringify(result, null, 2));
    consecutiveFailures = 0;
    successfulSyncs++;
  } catch (err: any) {
    console.error(`[${timestamp}] Sync failed:`, err.message);
    consecutiveFailures++;
  }
  
  totalSyncs++;
  
  if (totalSyncs % 10 === 0) {
    const successRate = ((successfulSyncs / totalSyncs) * 100).toFixed(1);
    console.log(`[${timestamp}] Stats: ${successfulSyncs}/${totalSyncs} successful (${successRate}%)`);
  }
}

async function main(): Promise<void> {
  console.log('Protractor Sync Worker (Standalone) started');
  console.log(`Base sync interval: ${BASE_SYNC_INTERVAL_MS / 1000} seconds`);
  console.log('Running sync logic directly (no HTTP server required)');
  console.log('');
  
  // Initial delay
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  while (true) {
    await runSync();
    const interval = getAdaptiveInterval();
    if (interval !== BASE_SYNC_INTERVAL_MS) {
      console.log(`[${new Date().toISOString()}] Adaptive backoff: waiting ${interval / 1000}s`);
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

main().catch(console.error);
