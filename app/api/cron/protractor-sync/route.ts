/**
 * Protractor Daily Sync Cron Job
 *
 * SCHEDULE: Daily at 2:00 AM EST via external scheduler (e.g., Render cron)
 *
 * This endpoint is called ONCE daily as a sanity check to catch any work orders
 * or vehicles that may have been missed by webhooks. Real-time updates are
 * handled by the Protractor webhook handler at /api/webhooks/protractor/[token].
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
import { NormalizedIngestionService } from "@/lib/integrations/core/normalized-ingestion";
import { attributeRevenueFromWorkOrder } from "@/lib/enterprise";
import { extractJobIndexFromWorkOrder, computeJobHash } from "@/lib/job-index";
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
          
          const queueWoStage = (result.workOrder.WorkflowStage || "").toLowerCase();
          const queueIsCompleted = result.workOrder.Completed || 
            ["invoiced", "invoice", "posted", "completed", "closed"].some(s => queueWoStage.includes(s));

          if (queueIsCompleted) {
            const vin = (result.workOrder.ServiceItem?.VIN || result.workOrder.ServiceItem?.Lookup || '')?.toUpperCase() || null;
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

              try {
                const jobEntries = extractJobIndexFromWorkOrder(shopId, result.workOrder, "protractor");
                let queueIndexed = 0;
                for (const entry of jobEntries) {
                  const contentHash = computeJobHash(entry);
                  const filter = { shopId, workOrderId: entry.workOrderId, servicePackageId: entry.servicePackageId };
                  const existing = await db.collection("job_index").findOne(filter);
                  if (existing?.contentHash === contentHash) continue;
                  await db.collection("job_index").updateOne(filter, { $set: { ...entry, contentHash } }, { upsert: true });
                  queueIndexed++;
                }
                if (queueIndexed > 0) {
                  console.log(`[Queue] Indexed ${queueIndexed} jobs for WO ${objectId}`);
                }
                await db.collection("protractor_work_orders").updateMany(
                  { shopId: { $in: [String(shopId), Number(shopId)] }, workOrderId: objectId },
                  { $set: { jobsIndexed: true, jobsIndexedAt: new Date() } }
                );
              } catch (e) {
                console.error(`[Queue] Job indexing error for WO ${objectId}:`, e);
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

    // pLimit(4) across shops — see lib/cron/jobs.cjs comment on protractor-sync.
    // Previously this was a sequential `for (const shop of shops)` loop that
    // only reached the first 5 of 27 shops before the scheduler aborted at
    // 5 min. With 4-way concurrency + the 25-min scheduler timeout we cover
    // the full fleet on every tick. Each Protractor shop has its own API
    // creds so there is no shared rate-limit ceiling to coordinate.
    const shopLimit = pLimit(4);
    await Promise.all(shops.map((shop) => shopLimit(async () => {
      const shopId = Number(shop.shopId);
      const config = await resolveProtractorConfig(shopId);
      
      if (!config.configured) return;

      try {
        const activeResult = await fetchActiveWorkOrders(shopId, { readInProgress: true });
        
        if (!activeResult.ok || !activeResult.workOrders) {
          results.push({ shopId, synced: 0, removed: 0, error: activeResult.error });
          return;
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

        // Streaming fetch+process to bound heap: previously we built a full
        // `detailedWOs` array via Promise.all then iterated. With up to 5,000
        // active WOs per shop × pLimit(4) shops in parallel and ~100KB-1MB per
        // hydrated WO, that array regularly OOM'd the Render process (V8 SIGABRT,
        // heap 12.6 GB). We now fetch each detail, process it, hand it to the
        // normalized ingestion service, and let it be GC'd before moving on.
        // Peak heap is now O(pLimit) hydrated WOs per shop instead of O(5000).
        let syncedCount = 0;

        // Resolve shop/enterprise once for per-WO normalized ingestion.
        let ingestionService: NormalizedIngestionService | null = null;
        try {
          const shopDoc = await db.collection("shops").findOne({ shopId: String(shopId) });
          const enterpriseId = shopDoc?.enterpriseId as string | undefined;
          ingestionService = new NormalizedIngestionService(
            db,
            'protractor',
            shopId,
            enterpriseId,
            { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true }
          );
        } catch (e: any) {
          console.log(`[Cron] Protractor sync: failed to init normalized ingestion for shop ${shopId}:`, e.message);
        }

        const processOne = async (wo: any) => {
          const stage = wo.WorkflowStage || (wo as any).Status || "";
          let vin = wo.ServiceItem?.VIN?.toUpperCase() || wo.ServiceItem?.Lookup?.toUpperCase() || (wo as any).VIN?.toUpperCase();
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

              // Atomic source-array merge. The previous read-modify-write
              // (findOne → splice in app code → updateOne) was safe only
              // because processing was sequential. With the streaming
              // pLimit(3) refactor, two WOs for the same VIN can land in
              // parallel and would race on `status.sources`, dropping an
              // entry. We now (1) `$pull` any existing entry for this exact
              // (provider, workOrderId) and (2) `$push` the fresh one, both
              // as atomic Mongo ops. Different WOs for the same VIN no
              // longer collide; identical (shop, WO) repeats are idempotent.
              const vehicleFilter = {
                vin,
                $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
              };

              await db.collection("vehicles").updateOne(
                vehicleFilter,
                {
                  $pull: {
                    "status.sources": {
                      provider: "protractor",
                      workOrderId: String(wo.ID),
                    },
                  },
                } as any
              );

              await db.collection("vehicles").updateOne(
                vehicleFilter,
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
                    "status.updatedAt": new Date(),
                  },
                  $push: { "status.sources": workOrderSource } as any,
                  $setOnInsert: {
                    shopId: String(shopId),
                    vin,
                    createdAt: new Date(),
                  },
                },
                { upsert: true }
              );
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

              if (vin) {
                const alreadyIndexed = await db.collection("protractor_work_orders").findOne({
                  shopId: { $in: [String(shopId), Number(shopId)] },
                  $or: [{ workOrderGuid: wo.ID }, { "data.ID": wo.ID }],
                  jobsIndexed: true
                });
                if (!alreadyIndexed) {
                  try {
                    const jobEntries = extractJobIndexFromWorkOrder(shopId, wo, "protractor");
                    let syncIndexed = 0;
                    for (const entry of jobEntries) {
                      const contentHash = computeJobHash(entry);
                      const filter = { shopId, workOrderId: entry.workOrderId, servicePackageId: entry.servicePackageId };
                      const existing = await db.collection("job_index").findOne(filter);
                      if (existing?.contentHash === contentHash) continue;
                      await db.collection("job_index").updateOne(filter, { $set: { ...entry, contentHash } }, { upsert: true });
                      syncIndexed++;
                    }
                    if (syncIndexed > 0) {
                      console.log(`[Cron] Protractor shop ${shopId}: Indexed ${syncIndexed} jobs for invoiced WO ${wo.WorkOrderNumber || wo.ID}`);
                    }
                    await db.collection("protractor_work_orders").updateMany(
                      { shopId: { $in: [String(shopId), Number(shopId)] }, $or: [{ workOrderGuid: wo.ID }, { "data.ID": wo.ID }] },
                      { $set: { jobsIndexed: true, jobsIndexedAt: new Date() } }
                    );
                  } catch (e: any) {
                    console.error(`[Cron] Job indexing error for WO ${wo.ID}:`, e.message);
                  }
                }
              }
            }
          }

          // Per-WO normalized ingestion (replaces the old post-loop batch call).
          // Keeping this inline means we never hold all hydrated WOs in memory.
          if (ingestionService && wo.ServiceItem?.VIN) {
            try {
              await ingestionService.ingestWorkOrderWithAllEntities(wo);
            } catch (normErr: any) {
              console.log(`[Cron] Protractor sync normalized ingestion error for shop ${shopId} WO ${wo.ID}:`, normErr.message);
            }
          }

          syncedCount++;
        };

        await Promise.all(activeWOs.map((stubWO) =>
          limit(async () => {
            let detailedWO: any = stubWO;
            try {
              const detailResult = await fetchWorkOrderById(shopId, stubWO.ID);
              if (detailResult.ok && detailResult.workOrder) {
                detailedWO = detailResult.workOrder;
              }
            } catch (err) {
              console.log(`[Cron] Failed to fetch WO ${stubWO.ID} details`);
            }
            await processOne(detailedWO);
            // Drop reference so V8 can reclaim the hydrated WO before the next
            // task runs through this slot.
            detailedWO = null;
          })
        ));

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

        results.push({ shopId, synced: syncedCount, removed: removedCount, vehiclesUpdated });
        
        if (shopSyncedVins.length > 0) {
          syncedVinsPerShop.push({ shopId, vins: shopSyncedVins });
        }
        
        // Normalized ingestion is now per-WO inside processOne above so the
        // hydrated work-order payload is GC'd as soon as it's been ingested.
        // The prior batch call here built a full `detailedWOs` array in heap,
        // which on fat shops + pLimit(4)-parallel sync was the dominant
        // contributor to the V8 OOM SIGABRT crashes.
        console.log(`[Cron] Protractor sync shop ${shopId}: processed=${syncedCount} vehiclesUpdated=${vehiclesUpdated} (streaming)`);
      } catch (err: any) {
        results.push({ shopId, synced: 0, removed: 0, error: err.message });
      }
    })));

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
