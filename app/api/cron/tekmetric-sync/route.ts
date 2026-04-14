import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { 
  getRepairOrders, 
  getVehicle, 
  getCustomer,
  TekmetricRepairOrderFull,
  TekmetricVehicle,
  TekmetricCustomer
} from "@/lib/tekmetric";
import { resetTekmetricApiCallCount, getRepairOrderInspections, flattenInspectionTasks } from "@/lib/integrations/tekmetric/client";
import { 
  indexTekmetricWorkOrderJobs, 
  checkAndRunBackfillForNewShops 
} from "@/lib/tekmetric-job-index";
import { NormalizedIngestionService } from "@/lib/normalized-ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

// Early exit if Tekmetric sync is disabled for this deployment
function isSyncDisabled() {
  return process.env.DISABLE_TEKMETRIC_SYNC === "true";
}

const ACTIVE_STATUS_IDS = [1, 2, 3, 4];
const TERMINAL_STATUSES = ["Invoice", "Invoiced", "Posted", "Deleted", "Void"];

const DVI_LABEL_PATTERNS = [
  /\binsp/i,
  /\bdvi\b/i,
  /\bdigital\s*vehicle\s*inspect/i,
  /\bmulti[- ]?point/i,
  /\bcomplimentary\s+check/i,
  /\bcourtesy\s+check/i,
];

const DVI_COMPLETE_LABEL_PATTERNS = [
  /\binsp.*\b(sent|complete|done|approved|reviewed)\b/i,
  /\bdvi.*\b(sent|complete|done|approved|reviewed)\b/i,
  /\b(sent|complete|done|approved|reviewed).*\binsp/i,
];

const DVI_JOB_NAME_PATTERNS = [
  /\bdigital\s*(vehicle\s*)?inspect/i,
  /\bdvi\b/i,
  /\bmulti[- ]?point\s*inspect/i,
  /\bcomplimentary\s*inspect/i,
  /\bcourtesy\s*(check|inspect)/i,
  /\bvisual\s*inspect/i,
  /\bsafety\s*inspect/i,
  /\bfull\s*inspect/i,
];

function inferDviFromLabel(label: string): { hasDvi: boolean; dviComplete: boolean } {
  if (!label) return { hasDvi: false, dviComplete: false };
  const hasDvi = DVI_LABEL_PATTERNS.some(p => p.test(label));
  const dviComplete = DVI_COMPLETE_LABEL_PATTERNS.some(p => p.test(label));
  return { hasDvi, dviComplete };
}

function inferDviFromJobs(jobs: any[]): boolean {
  if (!jobs || !Array.isArray(jobs)) return false;
  return jobs.some((job: any) => {
    const name = job.name || "";
    return DVI_JOB_NAME_PATTERNS.some(p => p.test(name));
  });
}

interface TekmetricWorkOrderSnapshot {
  shopId: number | string;
  workOrderId: string;
  workOrderNumber: number;
  vin: string;
  status: string;
  statusCode?: string;
  label?: string;
  labelColor?: string;
  customerId: number;
  vehicleId: number;
  customerName?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleEngine?: string;
  odometer?: number;
  createdDate?: string;
  updatedDate?: string;
  completedDate?: string;
  fetchedAt: Date;
  data?: TekmetricRepairOrderFull;
  dviDone?: boolean;
  dviComplete?: boolean;
  inspections?: any[];
  inspectionUrl?: string | null;
  inspectionShareDate?: string | null;
}

interface InspectionStatusFromRO {
  hasInspectionUrl: boolean;
  inspectionShared: boolean;
  inspectionShareDate: string | null;
  inspectionUrl: string | null;
}

async function upsertTekmetricWorkOrderSnapshot(
  db: any,
  shopId: number,
  ro: TekmetricRepairOrderFull,
  vehicle: TekmetricVehicle,
  customer?: TekmetricCustomer,
  inspections?: any[] | null,
  inspectionStatus?: InspectionStatusFromRO
) {
  const vin = vehicle.vin?.toUpperCase();
  if (!vin) return;

  const statusName = ro.repairOrderStatus?.name || ro.repairOrderStatus?.code || "Open";
  const statusCode = ro.repairOrderStatus?.code || "";
  const label = ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || "";
  
  const labelDvi = inferDviFromLabel(label);
  const jobsHaveDvi = inferDviFromJobs((ro as any).jobs || []);
  const hasActualInspections = Array.isArray(inspections) && inspections.length > 0;
  const hasInspectionFromRO = inspectionStatus?.hasInspectionUrl || inspectionStatus?.inspectionShared;
  const dviDetected = labelDvi.hasDvi || labelDvi.dviComplete || jobsHaveDvi || hasActualInspections || !!hasInspectionFromRO;
  const dviComplete = labelDvi.dviComplete || !!inspectionStatus?.inspectionShared;

  const snapshot: TekmetricWorkOrderSnapshot = {
    shopId,
    workOrderId: String(ro.id),
    workOrderNumber: ro.repairOrderNumber,
    vin,
    status: statusName,
    statusCode,
    label,
    labelColor: ro.color || "",
    customerId: ro.customerId,
    vehicleId: ro.vehicleId,
    customerName: customer ? `${customer.firstName || ""} ${customer.lastName || ""}`.trim() : undefined,
    vehicleYear: vehicle.year,
    vehicleMake: vehicle.make,
    vehicleModel: vehicle.model,
    vehicleEngine: vehicle.engine,
    odometer: ro.milesIn || ro.milesOut || vehicle.mileageIn || vehicle.mileageOut,
    createdDate: ro.createdDate,
    updatedDate: ro.updatedDate,
    completedDate: ro.completedDate,
    fetchedAt: new Date(),
    data: ro,
    dviDone: dviDetected,
    dviComplete,
    inspections: hasActualInspections ? inspections! : [],
    inspectionUrl: inspectionStatus?.inspectionUrl || null,
    inspectionShareDate: inspectionStatus?.inspectionShareDate || null,
  };

  const existing = await db.collection("tekmetric_work_orders").findOne({
    shopId: { $in: [String(shopId), Number(shopId)] },
    workOrderId: String(ro.id)
  });
  
  if (!snapshot.inspections?.length && existing?.inspections?.length > 0) {
    snapshot.inspections = existing.inspections;
  }
  
  if (!snapshot.inspectionUrl && existing?.inspectionUrl) {
    snapshot.inspectionUrl = existing.inspectionUrl;
  }
  if (!snapshot.inspectionShareDate && existing?.inspectionShareDate) {
    snapshot.inspectionShareDate = existing.inspectionShareDate;
    snapshot.dviComplete = true;
  }
  
  if (existing?.dviDone && !dviDetected) {
    snapshot.dviDone = true;
    if (!snapshot.inspections?.length) {
      snapshot.inspections = existing.inspections || [];
    }
  }
  if (existing?.dviComplete) {
    snapshot.dviComplete = true;
  }
  
  await db.collection("tekmetric_work_orders").updateOne(
    { 
      shopId: { $in: [String(shopId), Number(shopId)] },
      workOrderId: String(ro.id)
    },
    { 
      $set: snapshot,
      $setOnInsert: { dviCompletedAt: null, lastInspection: null }
    },
    { upsert: true }
  );
}

export async function GET(req: NextRequest) {
  // Check if sync is disabled for this deployment
  if (isSyncDisabled()) {
    return NextResponse.json({
      ok: true,
      message: "Tekmetric sync disabled via DISABLE_TEKMETRIC_SYNC environment variable",
      disabled: true
    });
  }

  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const startTime = Date.now();
  resetTekmetricApiCallCount();

  try {
    const shops = await db.collection("shops").find({
      $or: [
        { "tekmetric.shopId": { $exists: true, $ne: null } },
        { tekmetricShopId: { $exists: true, $ne: null } }
      ]
    }).toArray();

    const results: { shopId: number; tekmetricShopId: number; synced: number; removed: number; jobsIndexed?: number; inspections?: number; error?: string }[] = [];
    const syncedVinsPerShop: { shopId: number; vins: string[] }[] = [];
    
    await checkAndRunBackfillForNewShops();

    for (const shop of shops) {
      const shopId = Number(shop.shopId);
      const tekmetricShopId = shop.tekmetric?.shopId || shop.tekmetricShopId;
      
      if (!tekmetricShopId) continue;

      try {
        const activeWOs: TekmetricRepairOrderFull[] = [];
        const vehicleCache = new Map<number, TekmetricVehicle>();
        const customerCache = new Map<number, TekmetricCustomer>();
        const shopSyncedVins: string[] = [];
        
        let page = 0;
        let hasMore = true;
        
        while (hasMore) {
          const response = await getRepairOrders(tekmetricShopId, {
            repairOrderStatusId: ACTIVE_STATUS_IDS,
            page,
            size: 100,
            sortDirection: 'DESC'
          });
          
          console.log(`[Tekmetric] Shop ${shopId}: Fetched page ${page}, got ${response.content.length} ROs`);
          activeWOs.push(...response.content);
          
          hasMore = !response.last;
          page++;
          
          if (page > 10) break;
        }

        const statusCounts: Record<string, number> = {};
        for (const ro of activeWOs) {
          const status = ro.repairOrderStatus?.name || ro.repairOrderStatus?.code || "Unknown";
          statusCounts[status] = (statusCounts[status] || 0) + 1;
        }
        console.log(`[Tekmetric] Shop ${shopId} - Status counts:`, statusCounts);

        let dviCount = 0;
        for (const ro of activeWOs) {
          if (!vehicleCache.has(ro.vehicleId)) {
            try {
              const vehicle = await getVehicle(ro.vehicleId);
              vehicleCache.set(ro.vehicleId, vehicle);
            } catch (err) {
              console.log(`[Tekmetric] Failed to fetch vehicle ${ro.vehicleId}`);
              continue;
            }
          }
          
          if (!customerCache.has(ro.customerId)) {
            try {
              const customer = await getCustomer(ro.customerId);
              customerCache.set(ro.customerId, customer);
            } catch (err) {
            }
          }
          
          const vehicle = vehicleCache.get(ro.vehicleId);
          const customer = customerCache.get(ro.customerId);
          
          if (vehicle?.vin) {
            const hasInspectionUrl = !!(ro as any).inspectionUrl;
            const inspectionShared = !!(ro as any).inspectionShareDate;
            const label = ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || "";
            const labelDvi = inferDviFromLabel(label);
            const jobDvi = inferDviFromJobs((ro as any).jobs || []);
            const hasDviSignal = hasInspectionUrl || inspectionShared || labelDvi.hasDvi || labelDvi.dviComplete || jobDvi;
            
            let inspections: any[] | null = null;
            if (hasDviSignal) {
              dviCount++;
              try {
                inspections = await getRepairOrderInspections(ro.id, tekmetricShopId);
                if (inspections && inspections.length > 0) {
                  console.log(`[Tekmetric] Shop ${shopId}: Fetched ${inspections.length} inspection(s) for RO ${ro.id}`);
                }
              } catch (inspErr: any) {
                console.warn(`[Tekmetric] Shop ${shopId}: Inspection fetch failed for RO ${ro.id}: ${inspErr.message}`);
                inspections = null;
              }
            }
            
            await upsertTekmetricWorkOrderSnapshot(db, shopId, ro, vehicle, customer, inspections, {
              hasInspectionUrl,
              inspectionShared,
              inspectionShareDate: (ro as any).inspectionShareDate || null,
              inspectionUrl: (ro as any).inspectionUrl || null,
            });
            shopSyncedVins.push(vehicle.vin.toUpperCase());
          }
        }

        const activeWoIds = new Set(activeWOs.map(wo => String(wo.id)));
        
        const cachedWOs = await db.collection("tekmetric_work_orders").find({
          shopId: { $in: [String(shopId), Number(shopId)] },
          status: { $nin: TERMINAL_STATUSES }
        }).toArray();

        let removedCount = 0;
        let indexedJobsCount = 0;
        for (const cached of cachedWOs) {
          if (!activeWoIds.has(cached.workOrderId)) {
            await db.collection("tekmetric_work_orders").updateOne(
              { _id: cached._id },
              {
                $set: {
                  status: "Invoiced",
                  closedAt: new Date(),
                  updatedAt: new Date()
                }
              }
            );
            removedCount++;
            
            const retryCount = cached.jobIndexRetryCount || 0;
            if (cached.vin && !cached.jobsIndexed && retryCount < 3) {
              try {
                const jobsIndexed = await indexTekmetricWorkOrderJobs(
                  shopId,
                  tekmetricShopId,
                  Number(cached.workOrderId),
                  cached.workOrderNumber,
                  {
                    vin: cached.vin,
                    year: cached.vehicleYear,
                    make: cached.vehicleMake,
                    model: cached.vehicleModel,
                    engine: cached.vehicleEngine
                  },
                  cached.completedDate || new Date().toISOString()
                );
                
                if (jobsIndexed > 0) {
                  indexedJobsCount += jobsIndexed;
                  await db.collection("tekmetric_work_orders").updateOne(
                    { _id: cached._id },
                    { $set: { jobsIndexed: true, jobIndexRetryCount: 0 } }
                  );
                  console.log(`[Tekmetric] Indexed ${jobsIndexed} jobs for WO #${cached.workOrderNumber}`);
                } else {
                  await db.collection("tekmetric_work_orders").updateOne(
                    { _id: cached._id },
                    { $set: { jobsIndexed: true } }
                  );
                }
              } catch (err: any) {
                console.log(`[Tekmetric] Failed to index jobs for WO ${cached.workOrderId} (attempt ${retryCount + 1}): ${err.message}`);
                await db.collection("tekmetric_work_orders").updateOne(
                  { _id: cached._id },
                  { 
                    $inc: { jobIndexRetryCount: 1 },
                    $set: { jobIndexLastError: err.message, jobIndexLastAttempt: new Date() }
                  }
                );
              }
            }
          }
        }

        await db.collection("shops").updateOne(
          { shopId: String(shopId) },
          { $set: { "tekmetric.lastSync": new Date() } }
        );

        console.log(`[Tekmetric] Shop ${shopId}: ${dviCount} ROs with inspections out of ${activeWOs.length} active`);
        
        results.push({ 
          shopId, 
          tekmetricShopId, 
          synced: activeWOs.length, 
          removed: removedCount,
          jobsIndexed: indexedJobsCount,
          inspections: dviCount
        });
        
        if (shopSyncedVins.length > 0) {
          const uniqueVins = [...new Set(shopSyncedVins)];
          syncedVinsPerShop.push({ shopId, vins: uniqueVins });
        }
        
        // Dual-write to normalized collections (enrich ROs with cached vehicle/customer data)
        try {
          const workOrdersForNormalized = activeWOs
            .filter(ro => vehicleCache.has(ro.vehicleId) && vehicleCache.get(ro.vehicleId)?.vin)
            .map(ro => {
              const vehicle = vehicleCache.get(ro.vehicleId);
              const customer = customerCache.get(ro.customerId);
              return {
                ...ro,
                vehicle: vehicle,
                customer: customer,
              };
            });
          
          if (workOrdersForNormalized.length > 0) {
            const shop = await db.collection("shops").findOne({ shopId: String(shopId) });
            const enterpriseId = shop?.enterpriseId as string | undefined;
            
            const ingestionService = new NormalizedIngestionService(
              db,
              'tekmetric',
              shopId,
              enterpriseId,
              { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true }
            );
            
            const result = await ingestionService.ingestWorkOrderBatchWithAllEntities(workOrdersForNormalized);
            console.log(`[Cron] Tekmetric sync normalized: shop ${shopId}, WOs: ${result.workOrders.created}/${result.workOrders.updated}/${result.workOrders.skipped}, payments: ${result.payments.created}, inspections: ${result.inspections.created}, recommendations: ${result.recommendations.created}`);
          }
        } catch (normErr: any) {
          console.log(`[Cron] Tekmetric sync normalized ingestion error for shop ${shopId}:`, normErr.message);
        }
      } catch (err: any) {
        console.error(`[Tekmetric] Shop ${shopId} sync error:`, err.message);
        results.push({ 
          shopId, 
          tekmetricShopId, 
          synced: 0, 
          removed: 0, 
          error: err.message 
        });
      }
    }

    const apiCallCount = resetTekmetricApiCallCount();
    const duration = Date.now() - startTime;
    console.log(`[Cron] Tekmetric sync completed in ${duration}ms — API calls made: ${apiCallCount} (budget: 600/min):`, results);

    // Fire-and-forget plan pre-generation for ALL dashboard-visible vehicles
    if (CRON_SECRET) {
      try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL 
          || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
          || `http://localhost:${process.env.PORT || 5000}`;
        
        // Get all Tekmetric shops - use tekmetric.shopId as the shop identifier
        const tekmetricShops = await db.collection("shops")
          .find({ "tekmetric.shopId": { $exists: true, $ne: null } })
          .project({ _id: 0, shopId: 1, tekmetric: 1 })
          .toArray();
        
        console.log(`[Cron] Found ${tekmetricShops.length} Tekmetric shops for pregeneration`);
        
        const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "mos-prefetch-worker-2024";
        
        let triggeredCount = 0;
        for (const shop of tekmetricShops) {
          const internalShopId = shop.shopId;
          const tekShopId = shop.tekmetric?.shopId;
          if (!internalShopId) continue;
          
          try {
            // Use the internal prefetch-vehicles endpoint (handles active vehicle priority)
            const vehiclesRes = await fetch(`${baseUrl}/api/internal/prefetch-vehicles?shopId=${internalShopId}&limit=50`, {
              headers: { 'x-internal-secret': INTERNAL_SECRET }
            });
            
            if (!vehiclesRes.ok) {
              console.log(`[Cron] Shop ${internalShopId}: Failed to fetch vehicles (${vehiclesRes.status})`);
              continue;
            }
            
            const { rows } = await vehiclesRes.json();
            const vins = (rows || [])
              .map((v: any) => v.vin)
              .filter((v: string) => v && v.length === 17);
            
            console.log(`[Cron] Shop ${internalShopId} (tek: ${tekShopId}): ${vins.length} VINs for pregeneration`);
            
            if (vins.length > 0) {
              triggeredCount++;
              fetch(`${baseUrl}/api/internal/plan-pregenerate`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${CRON_SECRET}`,
                },
                body: JSON.stringify({ shopId: internalShopId, vins }),
              }).catch(err => console.log(`[Cron] Plan pregenerate failed for shop ${internalShopId}:`, err.message));
            }
          } catch (shopErr: any) {
            console.log(`[Cron] Shop ${internalShopId} pregenerate error:`, shopErr.message);
          }
        }
        console.log(`[Cron] Triggered plan pre-generation for ${triggeredCount}/${tekmetricShops.length} Tekmetric shops with vehicles`);
      } catch (pregenerateErr: any) {
        console.error(`[Cron] Tekmetric pregenerate error:`, pregenerateErr.message);
      }
    }

    return NextResponse.json({
      ok: true,
      duration: `${duration}ms`,
      tekmetricApiCalls: apiCallCount,
      shops: results
    });
  } catch (err: any) {
    const finalApiCalls = resetTekmetricApiCallCount();
    console.error(`[Cron] Tekmetric sync error (API calls made: ${finalApiCalls}):`, err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
