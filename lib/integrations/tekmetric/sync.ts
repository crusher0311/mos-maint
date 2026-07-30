import { getDb } from "@/lib/mongo";
import { 
  getRepairOrders, 
  getVehicle, 
  getCustomer,
  TekmetricRepairOrderFull,
  TekmetricVehicle,
  TekmetricCustomer
} from ".";

const ACTIVE_STATUS_IDS = [1, 2, 3, 4];

const DVI_LABEL_PATTERNS = [
  /\binsp/i,
  /\bdvi\b/i,
  /\bdigital\s*vehicle\s*inspect/i,
  /\bmulti[- ]?point/i,
  /\bcomplimentary\s+check/i,
  /\bcourtesy\s+check/i,
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

function inferDviFromLabelOrJobs(label: string, jobs: any[]): boolean {
  if (label && DVI_LABEL_PATTERNS.some(p => p.test(label))) return true;
  if (jobs && Array.isArray(jobs)) {
    return jobs.some((j: any) => DVI_JOB_NAME_PATTERNS.some(p => p.test(j.name || "")));
  }
  return false;
}

interface SyncResult {
  success: boolean;
  synced: number;
  error?: string;
  /**
   * True when this trigger was deliberately dropped because another
   * initial sync for the same shop is already in flight (task #966).
   * Callers must treat this as "someone else owns it" — NOT a failure.
   */
  skipped?: boolean;
  reason?: string;
}

// Yield the event loop + the shared Tekmetric rate budget every this
// many ROs. The initial sync is strictly serial (one API call and one
// Mongo write at a time — that bound is load-bearing, see task #966),
// but on the busy web process a tight serial loop over ~1000 ROs can
// still starve interactive requests of limiter slots; a short breather
// keeps user-facing calls interleaving with the sync.
const SYNC_YIELD_EVERY_ROS = 10;
const SYNC_YIELD_MS = 250;

export async function syncSingleShop(
  shopId: number | string, 
  tekmetricShopId: number
): Promise<SyncResult> {
  const db = await getDb();
  const numericShopId = Number(shopId);

  // Single-flight guard (task #966): overlapping triggers — a cron
  // re-tick, a fetch retry, a second admin click — become logged no-ops
  // instead of parallel storms against the shared rate limiter.
  const { acquireInitialSyncLock, releaseInitialSyncLock } = await import(
    "./initial-sync-lock"
  );
  const lock = await acquireInitialSyncLock(db, numericShopId);
  if (!lock.acquired) {
    const startedAgoSec = lock.startedAt
      ? Math.round((Date.now() - new Date(lock.startedAt).getTime()) / 1000)
      : null;
    console.log(
      `[Tekmetric Sync] THROTTLED: initial sync for shop ${shopId} already in flight ` +
        `(held by ${lock.heldBy || "unknown"}, started ${startedAgoSec === null ? "?" : `${startedAgoSec}s ago`}, ` +
        `lock expires ${lock.heldUntil ? new Date(lock.heldUntil).toISOString() : "?"}) — dropping duplicate trigger`,
    );
    return {
      success: false,
      synced: 0,
      skipped: true,
      reason: "in_flight",
    };
  }

  try {
    return await runInitialSync(db, shopId, numericShopId, tekmetricShopId);
  } finally {
    await releaseInitialSyncLock(db, numericShopId, lock.owner);
  }
}

async function runInitialSync(
  db: any,
  shopId: number | string,
  numericShopId: number,
  tekmetricShopId: number,
): Promise<SyncResult> {
  try {
    console.log(`[Tekmetric Sync] Starting initial sync for shop ${shopId} (Tekmetric: ${tekmetricShopId})`);
    
    const activeWOs: TekmetricRepairOrderFull[] = [];
    const vehicleCache = new Map<number, TekmetricVehicle>();
    const customerCache = new Map<number, TekmetricCustomer>();
    
    let page = 0;
    let hasMore = true;
    
    while (hasMore) {
      const response = await getRepairOrders(tekmetricShopId, {
        repairOrderStatusId: ACTIVE_STATUS_IDS,
        page,
        size: 100,
        sortDirection: 'DESC'
      });
      
      console.log(`[Tekmetric Sync] Shop ${shopId}: Fetched page ${page}, got ${response.content.length} ROs`);
      activeWOs.push(...response.content);
      
      hasMore = !response.last;
      page++;
      
      if (page > 10) break;
    }

    let rosProcessed = 0;
    for (const ro of activeWOs) {
      rosProcessed++;
      if (rosProcessed % SYNC_YIELD_EVERY_ROS === 0) {
        await new Promise((r) => setTimeout(r, SYNC_YIELD_MS));
      }
      if (!vehicleCache.has(ro.vehicleId)) {
        try {
          const vehicle = await getVehicle(ro.vehicleId);
          vehicleCache.set(ro.vehicleId, vehicle);
        } catch (err) {
          console.log(`[Tekmetric Sync] Failed to fetch vehicle ${ro.vehicleId}`);
          continue;
        }
      }
      
      if (!customerCache.has(ro.customerId)) {
        try {
          const customer = await getCustomer(ro.customerId, numericShopId);
          customerCache.set(ro.customerId, customer);
        } catch (err) {
        }
      }
      
      const vehicle = vehicleCache.get(ro.vehicleId);
      const customer = customerCache.get(ro.customerId);
      
      if (vehicle?.vin) {
        const vin = vehicle.vin.toUpperCase();
        const statusName = ro.repairOrderStatus?.name || ro.repairOrderStatus?.code || "Open";
        const statusCode = ro.repairOrderStatus?.code || "";
        const label = ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || "";
        
        const dviDetected = inferDviFromLabelOrJobs(label, (ro as any).jobs || []);

        const existing = await db.collection("tekmetric_work_orders").findOne({
          shopId: { $in: [String(numericShopId), numericShopId] },
          workOrderId: String(ro.id)
        });

        // Task #960 — tekmetric_work_orders date-field contract:
        //  - Sync writers (this file, incremental-sync.ts, cron/tekmetric-sync)
        //    stamp Tekmetric's own names: createdDate/updatedDate/completedDate
        //    (+ fetchedAt). They do NOT stamp updatedAt/createdAt.
        //  - Webhook + ro-context writers stamp app-side updatedAt/createdAt.
        // Readers that sort or date-gate must therefore check BOTH families,
        // e.g. sort { updatedAt: -1, updatedDate: -1, createdAt: -1, createdDate: -1 }
        // and read roDate as updatedAt ?? updatedDate ?? completedDate ?? createdAt ?? createdDate.
        await db.collection("tekmetric_work_orders").updateOne(
          { 
            shopId: { $in: [String(numericShopId), numericShopId] },
            workOrderId: String(ro.id)
          },
          { 
            $set: {
              shopId: numericShopId,
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
              dviDone: dviDetected || (existing?.dviDone === true),
            },
            $setOnInsert: { dviCompletedAt: null, lastInspection: null }
          },
          { upsert: true }
        );
      }
    }

    await db.collection("shops").updateOne(
      { shopId: { $in: [String(numericShopId), numericShopId] } },
      { $set: { "tekmetric.lastSync": new Date() } }
    );

    console.log(`[Tekmetric Sync] Completed initial sync for shop ${shopId}: ${activeWOs.length} ROs synced`);
    
    return {
      success: true,
      synced: activeWOs.length
    };
  } catch (err: any) {
    console.error(`[Tekmetric Sync] Error syncing shop ${shopId}:`, err.message);
    return {
      success: false,
      synced: 0,
      error: err.message
    };
  }
}
