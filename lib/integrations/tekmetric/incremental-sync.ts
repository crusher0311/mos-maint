import { getDb } from "@/lib/mongo";
import { 
  getRepairOrders, 
  getVehicle, 
  getCustomer,
  getTekmetricWorkOrderStatus,
  TekmetricRepairOrderFull,
  TekmetricVehicle,
  TekmetricCustomer
} from ".";
import { getRepairOrderInspectionsWithXAuth } from "./client";
import {
  classifyWebhookCoverage,
  selectPollCadence,
  isWebhookFirstDisabled,
} from "./webhook-coverage";

const ACTIVE_STATUS_IDS = [1, 2, 3, 4];
const TERMINAL_STATUSES = ["Invoice", "Invoiced", "Posted", "Deleted", "Void"];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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
const MAX_PAGES_PER_CYCLE = 3; // Process up to 3 pages (300 records) per shop per cycle
const MAX_QUEUED_PAGES = 20; // Max pages to queue for later processing
const TERMINAL_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// Wall-clock cap for one incremental cycle. The cron ticks every 2 minutes;
// without a cap, budget-starved cycles ran for HOURS and overlapped, piling
// load onto the web instance (observed 7-17h runs on 2026-08-11). When the
// deadline passes, remaining shops are skipped this tick — they simply run
// on the next one.
const CYCLE_DEADLINE_MS = Number(process.env.TEKMETRIC_INCREMENTAL_DEADLINE_MS || 90_000);

// Negative-cache backoff for failed vehicle/customer live fetches. Without
// this, an uncached vehicle whose fetch is denied by the background rate
// budget was retried on EVERY tick forever (~320k failed fetches/week).
// Backoff doubles per consecutive failure: 5m, 10m, 20m, ... capped at 4h.
const FETCH_FAIL_BASE_MS = 5 * 60 * 1000;
const FETCH_FAIL_MAX_MS = 4 * 60 * 60 * 1000;

export interface ShopSyncState {
  shopId: number;
  tekmetricShopId: number;
  lastSyncCursor: Date | null;
  overflowQueue: OverflowPage[];
  lastClosedSweepAt: Date | null;
  consecutiveAuthFailures: number;
  pausedUntil: Date | null;
  xAuthToken?: string | null;
  // Task #1089 (webhook-first): last webhook event received for this shop,
  // stamped by app/api/webhooks/tekmetric/route.ts. Used to decide whether
  // the shop can drop to the slow safety-net poll cadence.
  lastWebhookEventAt?: Date | null;
}

interface OverflowPage {
  page: number;
  updatedDateStart: string;
  createdAt: Date;
}

export interface IncrementalSyncResult {
  shopId: number;
  tekmetricShopId: number;
  synced: number;
  removed: number;
  fromCache: { vehicles: number; customers: number };
  // Task #1079: negative-cache observability. `negativeCacheHits` counts
  // vehicle/customer lookups short-circuited by an active fetch-failure
  // backoff (isFetchBackedOff); `liveFetches` counts live API attempts.
  // Together with `fromCache` they let the cycle completion log report the
  // negative-cache hit rate, confirming the retry storm stays gone.
  negativeCacheHits: { vehicles: number; customers: number };
  liveFetches: { vehicles: number; customers: number };
  pagesQueued: number;
  terminalSwept: boolean;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

async function getShopSyncState(db: any, shopId: number): Promise<ShopSyncState | null> {
  const shop = await db.collection("shops").findOne({
    shopId: { $in: [String(shopId), shopId] }
  });
  
  if (!shop) return null;
  
  const tekmetricShopId = shop.tekmetric?.shopId || shop.tekmetricShopId;
  if (!tekmetricShopId) return null;
  
  return {
    shopId,
    tekmetricShopId: Number(tekmetricShopId),
    lastSyncCursor: shop.tekmetric?.lastSyncCursor || null,
    overflowQueue: shop.tekmetric?.overflowQueue || [],
    lastClosedSweepAt: shop.tekmetric?.lastClosedSweepAt || null,
    consecutiveAuthFailures: shop.tekmetric?.consecutiveAuthFailures || 0,
    pausedUntil: shop.tekmetric?.pausedUntil || null,
    lastWebhookEventAt: shop.tekmetric?.lastWebhookEventAt || null,
  };
}

async function updateShopSyncState(
  db: any, 
  shopId: number, 
  updates: Partial<ShopSyncState>
): Promise<void> {
  const setFields: Record<string, any> = {};
  
  if (updates.lastSyncCursor !== undefined) {
    setFields["tekmetric.lastSyncCursor"] = updates.lastSyncCursor;
  }
  if (updates.overflowQueue !== undefined) {
    setFields["tekmetric.overflowQueue"] = updates.overflowQueue;
  }
  if (updates.lastClosedSweepAt !== undefined) {
    setFields["tekmetric.lastClosedSweepAt"] = updates.lastClosedSweepAt;
  }
  if (updates.consecutiveAuthFailures !== undefined) {
    setFields["tekmetric.consecutiveAuthFailures"] = updates.consecutiveAuthFailures;
  }
  if (updates.pausedUntil !== undefined) {
    setFields["tekmetric.pausedUntil"] = updates.pausedUntil;
  }
  setFields["tekmetric.lastSync"] = new Date();
  
  await db.collection("shops").updateOne(
    { shopId: { $in: [String(shopId), shopId] } },
    { $set: setFields }
  );
}

export async function getCachedVehicle(db: any, vehicleId: number): Promise<TekmetricVehicle | null> {
  const cached = await db.collection("tekmetric_vehicle_cache").findOne({
    vehicleId,
    cachedAt: { $gt: new Date(Date.now() - CACHE_TTL_MS) }
  });
  return cached?.data || null;
}

export async function cacheVehicle(db: any, vehicleId: number, vehicle: TekmetricVehicle): Promise<void> {
  await db.collection("tekmetric_vehicle_cache").updateOne(
    { vehicleId },
    { 
      $set: { 
        vehicleId, 
        data: vehicle, 
        cachedAt: new Date() 
      },
      // A successful fetch clears any negative-cache backoff state.
      $unset: { failCount: "", retryAfter: "" }
    },
    { upsert: true }
  );
}

// --- Negative cache for failed live fetches (vehicle + customer) ---
// Stored on the same cache doc (no `data` field) so the existing TTL index on
// `cachedAt` garbage-collects it. `retryAfter` gates the next live attempt;
// `failCount` drives exponential backoff.

function backoffMs(failCount: number): number {
  return Math.min(FETCH_FAIL_BASE_MS * Math.pow(2, Math.max(0, failCount - 1)), FETCH_FAIL_MAX_MS);
}

export async function isFetchBackedOff(db: any, collection: string, key: Record<string, number>): Promise<boolean> {
  const doc = await db.collection(collection).findOne(key, { projection: { retryAfter: 1, data: 1 } });
  return !!doc && !doc.data && doc.retryAfter && new Date() < new Date(doc.retryAfter);
}

export async function recordFetchFailure(db: any, collection: string, key: Record<string, number>): Promise<void> {
  // Atomic $inc so concurrent failures (cross-process) never lose counts;
  // retryAfter is then derived from the atomically assigned count.
  //
  // A failed refresh over an EXPIRED positive entry must also clear `data`,
  // for two reasons: (1) `isFetchBackedOff` treats any doc with `data` as a
  // positive entry and would never gate it, so the failed live fetch would
  // repeat every tick; (2) we bump `cachedAt` for the TTL index, and leaving
  // stale `data` behind would make it look fresh to getCachedVehicle/
  // getCachedCustomer. The expired data was unusable anyway (reads filter on
  // cachedAt).
  const doc = await db.collection(collection).findOneAndUpdate(
    key,
    {
      $inc: { failCount: 1 },
      $set: { ...key, cachedAt: new Date() },
      $unset: { data: "" },
    },
    { upsert: true, returnDocument: "after" }
  );
  const failCount = doc?.failCount ?? doc?.value?.failCount ?? 1;
  await db.collection(collection).updateOne(key, {
    $set: { retryAfter: new Date(Date.now() + backoffMs(failCount)) },
  });
}

// Jobs cache. Backfill only ever indexes terminal ROs (POSTED/INVOICED/
// COMPLETED) whose jobs payload doesn't change after the fact, so a long-ish
// TTL is safe and dramatically cuts the per-RO `/jobs` API fan-out — which
// is where the 14m43s/chunk wall-clock and the bulk of the 429 backoff time
// were coming from. A re-run of the same window (verification, post-error
// retry) now hits Mongo instead of Tekmetric for every RO whose jobs we've
// already seen.
const JOBS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function getCachedJobs(db: any, repairOrderId: number): Promise<any[] | null> {
  const cached = await db.collection("tekmetric_jobs_cache").findOne({
    repairOrderId,
    cachedAt: { $gt: new Date(Date.now() - JOBS_CACHE_TTL_MS) }
  });
  return Array.isArray(cached?.jobs) ? cached.jobs : null;
}

export async function cacheJobs(db: any, repairOrderId: number, jobs: any[]): Promise<void> {
  await db.collection("tekmetric_jobs_cache").updateOne(
    { repairOrderId },
    {
      $set: {
        repairOrderId,
        jobs,
        cachedAt: new Date(),
      }
    },
    { upsert: true }
  );
}

export async function getCachedCustomer(db: any, customerId: number): Promise<TekmetricCustomer | null> {
  const cached = await db.collection("tekmetric_customer_cache").findOne({
    customerId,
    cachedAt: { $gt: new Date(Date.now() - CACHE_TTL_MS) }
  });
  return cached?.data || null;
}

export async function cacheCustomer(db: any, customerId: number, customer: TekmetricCustomer): Promise<void> {
  await db.collection("tekmetric_customer_cache").updateOne(
    { customerId },
    { 
      $set: { 
        customerId, 
        data: customer, 
        cachedAt: new Date() 
      },
      // A successful fetch clears any negative-cache backoff state.
      $unset: { failCount: "", retryAfter: "" }
    },
    { upsert: true }
  );
}

export async function syncShopIncremental(
  shopId: number,
  tekmetricShopId: number,
  state: ShopSyncState,
  xAuthToken?: string | null,
  deadline?: number
): Promise<IncrementalSyncResult> {
  const db = await getDb();
  const result: IncrementalSyncResult = {
    shopId,
    tekmetricShopId,
    synced: 0,
    removed: 0,
    fromCache: { vehicles: 0, customers: 0 },
    negativeCacheHits: { vehicles: 0, customers: 0 },
    liveFetches: { vehicles: 0, customers: 0 },
    pagesQueued: 0,
    terminalSwept: false,
  };

  if (state.pausedUntil && new Date() < state.pausedUntil) {
    result.skipped = true;
    result.skipReason = `Paused until ${state.pausedUntil.toISOString()} due to auth failures`;
    return result;
  }

  try {
    const updatedDateStart = state.lastSyncCursor 
      ? new Date(state.lastSyncCursor.getTime() - 30000).toISOString()
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    let pageToFetch = 0;
    let updatedDateFilter = updatedDateStart;
    
    if (state.overflowQueue.length > 0) {
      const overflow = state.overflowQueue[0];
      pageToFetch = overflow.page;
      updatedDateFilter = overflow.updatedDateStart;
      console.log(`[Tekmetric Incremental] Shop ${shopId}: Processing overflow page ${pageToFetch}`);
    }

    const response = await getRepairOrders(tekmetricShopId, {
      repairOrderStatusId: ACTIVE_STATUS_IDS,
      page: pageToFetch,
      size: 100,
      sortDirection: 'DESC',
      updatedDateStart: updatedDateFilter,
    });

    console.log(`[Tekmetric Incremental] Shop ${shopId}: Fetched page ${pageToFetch}, got ${response.content.length} ROs (updated since ${updatedDateFilter})`);

    await updateShopSyncState(db, shopId, { consecutiveAuthFailures: 0 });

    let newOverflowQueue = [...state.overflowQueue];
    if (state.overflowQueue.length > 0) {
      newOverflowQueue.shift();
    }
    
    // Queue next pages if not at the end and within queue limits
    if (!response.last && newOverflowQueue.length < MAX_QUEUED_PAGES) {
      newOverflowQueue.push({
        page: pageToFetch + 1,
        updatedDateStart: updatedDateFilter,
        createdAt: new Date(),
      });
      result.pagesQueued = newOverflowQueue.length;
    }

    for (const ro of response.content) {
      // Honor the cycle deadline inside the per-RO loop too — each iteration
      // can cost multiple live API calls (with internal 429 retries), so
      // batch-boundary checks alone don't bound the cycle.
      if (deadline && Date.now() > deadline) {
        console.log(`[Tekmetric Incremental] Shop ${shopId}: deadline hit mid-page — remaining ROs picked up next tick`);
        break;
      }
      let vehicle = await getCachedVehicle(db, ro.vehicleId);
      if (vehicle) {
        result.fromCache.vehicles++;
      } else if (await isFetchBackedOff(db, "tekmetric_vehicle_cache", { vehicleId: ro.vehicleId })) {
        // Recently failed (rate budget denial or upstream error) — skip the
        // live fetch until the backoff expires instead of retrying every tick.
        result.negativeCacheHits.vehicles++;
        continue;
      } else {
        try {
          result.liveFetches.vehicles++;
          vehicle = await getVehicle(ro.vehicleId);
          await cacheVehicle(db, ro.vehicleId, vehicle);
        } catch (err) {
          console.log(`[Tekmetric Incremental] Failed to fetch vehicle ${ro.vehicleId} (backing off)`);
          await recordFetchFailure(db, "tekmetric_vehicle_cache", { vehicleId: ro.vehicleId });
          continue;
        }
      }

      let customer = await getCachedCustomer(db, ro.customerId);
      if (customer) {
        result.fromCache.customers++;
      } else if (await isFetchBackedOff(db, "tekmetric_customer_cache", { customerId: ro.customerId })) {
        // Customer is optional for upsert — proceed without it.
        result.negativeCacheHits.customers++;
      } else {
        try {
          result.liveFetches.customers++;
          customer = await getCustomer(ro.customerId, shopId);
          await cacheCustomer(db, ro.customerId, customer);
        } catch (err) {
          await recordFetchFailure(db, "tekmetric_customer_cache", { customerId: ro.customerId });
        }
      }

      if (vehicle?.vin) {
        await upsertWorkOrder(db, shopId, tekmetricShopId, ro, vehicle, customer, xAuthToken || state.xAuthToken);
        result.synced++;
      }
    }

    const shouldSweepTerminal = !state.lastClosedSweepAt || 
      (Date.now() - state.lastClosedSweepAt.getTime()) > TERMINAL_SWEEP_INTERVAL_MS;

    if (shouldSweepTerminal && newOverflowQueue.length === 0 && !(deadline && Date.now() > deadline)) {
      const swept = await sweepTerminalStatuses(db, shopId, tekmetricShopId);
      result.removed = swept;
      result.terminalSwept = true;
      await updateShopSyncState(db, shopId, { lastClosedSweepAt: new Date() });
    }

    await updateShopSyncState(db, shopId, {
      lastSyncCursor: new Date(),
      overflowQueue: newOverflowQueue,
    });

    return result;
  } catch (err: any) {
    const isAuthError = err.message?.includes('401') || err.message?.includes('Unauthorized');
    
    if (isAuthError) {
      const newFailures = state.consecutiveAuthFailures + 1;
      let pauseUntil: Date | null = null;
      
      if (newFailures >= 3) {
        pauseUntil = new Date(Date.now() + 60 * 60 * 1000);
        console.log(`[Tekmetric Incremental] Shop ${shopId}: Pausing sync for 1 hour due to repeated auth failures`);
      }
      
      await updateShopSyncState(db, shopId, {
        consecutiveAuthFailures: newFailures,
        pausedUntil: pauseUntil,
      });
    }
    
    result.error = err.message;
    return result;
  }
}

async function upsertWorkOrder(
  db: any,
  shopId: number,
  tekmetricShopId: number,
  ro: TekmetricRepairOrderFull,
  vehicle: TekmetricVehicle,
  customer?: TekmetricCustomer | null,
  xAuthToken?: string | null
): Promise<void> {
  const vin = vehicle.vin?.toUpperCase();
  if (!vin) return;

  const statusName = ro.repairOrderStatus?.name || ro.repairOrderStatus?.code || "Open";
  const statusCode = ro.repairOrderStatus?.code || "";
  const label = ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || "";

  const hasInspectionUrl = !!(ro as any).inspectionUrl;
  const inspectionShared = !!(ro as any).inspectionShareDate;
  const dviDetected = inferDviFromLabelOrJobs(label, (ro as any).jobs || []) || hasInspectionUrl || inspectionShared;
  const dviComplete = inspectionShared || /complete|done|finished/i.test(label);

  const existing = await db.collection("tekmetric_work_orders").findOne({
    shopId: { $in: [String(shopId), Number(shopId)] },
    workOrderId: String(ro.id)
  });

  const inspectionUrl = (ro as any).inspectionUrl || existing?.inspectionUrl || null;
  const inspectionShareDate = (ro as any).inspectionShareDate || existing?.inspectionShareDate || null;

  // Phase C: env-flag gate. Default ON. Flip TEKMETRIC_POLLING_FETCH_INSPECTIONS=false
  // per-env after the Inspection.Complete webhook handler has soaked. See
  // TEKMETRIC_5K_SCALING_PLAN.md Step 2 Phase C.
  const pollingFetchEnabled = process.env.TEKMETRIC_POLLING_FETCH_INSPECTIONS !== "false";
  let inspections: any[] | null = null;
  if (dviDetected && tekmetricShopId && xAuthToken && pollingFetchEnabled) {
    try {
      inspections = await getRepairOrderInspectionsWithXAuth(ro.id, tekmetricShopId, xAuthToken);
      if (inspections && inspections.length > 0) {
        console.log(`[Tekmetric Incremental] Fetched ${inspections.length} inspection(s) for RO ${ro.id} via stored x-auth-token`);
      }
    } catch (inspErr: any) {
      console.warn(`[Tekmetric Incremental] Inspection fetch failed for RO ${ro.id}: ${inspErr.message}`);
      inspections = null;
    }
  }

  const hasNewInspections = Array.isArray(inspections) && inspections.length > 0;
  const inspectionsToStore = hasNewInspections ? inspections! : (existing?.inspections || []);

  const odometer = ro.milesOut || ro.milesIn || vehicle.mileageOut || vehicle.mileageIn || null;

  await db.collection("tekmetric_work_orders").updateOne(
    { 
      shopId: { $in: [String(shopId), Number(shopId)] },
      workOrderId: String(ro.id)
    },
    { 
      $set: {
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
        odometer,
        createdDate: ro.createdDate,
        updatedDate: ro.updatedDate,
        completedDate: ro.completedDate,
        fetchedAt: new Date(),
        data: ro,
        dviDone: dviDetected || (existing?.dviDone === true),
        dviComplete: dviComplete || (existing?.dviComplete === true),
        inspectionUrl,
        inspectionShareDate,
        inspections: inspectionsToStore,
      },
      $setOnInsert: { dviCompletedAt: null, lastInspection: null }
    },
    { upsert: true }
  );

  // If this RO is terminal (Posted/Invoiced/Completed) and we haven't already
  // indexed its jobs into job_index, do it now. job_index is the authoritative
  // shop-history table that plan-build queries — without this, incremental sync
  // would leave a gap between "WO doc cached" and "job history available".
  const upperStatus = String(statusCode || "").toUpperCase();
  const isTerminal = ["POSTED", "INVOICED", "INVOICE", "COMPLETED", "CLOSED"].includes(upperStatus);

  // Opportunistic jobs-cache warming for already-indexed terminal ROs. The
  // indexing branch below already warms the cache via `indexTekmetricWorkOrderJobs`
  // when it runs, but an RO that's already indexed (jobsIndexed=true) skips
  // that branch — yet the incremental sync just paid to fetch a fresh `ro.jobs`
  // payload, so we may as well refresh the 30d TTL on `tekmetric_jobs_cache`.
  // We cache empty arrays too: a terminal RO with no jobs is a stable answer
  // and the next backfill run shouldn't pay another API call to re-confirm it.
  // This keeps backfill verification reruns of recently active shops hitting
  // Mongo instead of `/jobs?repairOrderId=…`. See task #57.
  if (isTerminal && existing?.jobsIndexed && Array.isArray((ro as any).jobs)) {
    try {
      await cacheJobs(db, ro.id, (ro as any).jobs);
    } catch (warmErr: any) {
      console.warn(`[Tekmetric Incremental] jobs cache warm failed for RO #${ro.repairOrderNumber}: ${warmErr?.message || warmErr}`);
    }
  }

  if (isTerminal && !existing?.jobsIndexed) {
    try {
      const { indexTekmetricWorkOrderJobs } = await import("./job-index");
      const jobsIndexed = await indexTekmetricWorkOrderJobs(
        shopId,
        tekmetricShopId,
        ro.id,
        ro.repairOrderNumber,
        {
          vin,
          year: vehicle.year,
          make: vehicle.make,
          model: vehicle.model,
          engine: vehicle.engine,
        },
        ro.completedDate || ro.postedDate || ro.updatedDate || new Date().toISOString(),
        odometer,
        { indexedVia: "poll" }
      );
      if (jobsIndexed > 0) {
        await db.collection("tekmetric_work_orders").updateOne(
          { shopId: { $in: [String(shopId), Number(shopId)] }, workOrderId: String(ro.id) },
          { $set: { jobsIndexed: true } }
        );
        console.log(`[Tekmetric Incremental] Indexed ${jobsIndexed} jobs into job_index for RO #${ro.repairOrderNumber}`);
      }
    } catch (err: any) {
      console.warn(`[Tekmetric Incremental] job_index population failed for RO #${ro.repairOrderNumber}: ${err.message}`);
    }
  }
}

async function sweepTerminalStatuses(
  db: any,
  shopId: number,
  tekmetricShopId: number
): Promise<number> {
  const cachedWOs = await db.collection("tekmetric_work_orders").find({
    shopId: { $in: [String(shopId), Number(shopId)] },
    status: { $nin: TERMINAL_STATUSES },
    fetchedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) }
  }).limit(50).toArray();

  let removedCount = 0;
  
  for (const cached of cachedWOs) {
    try {
      const status = await getTekmetricWorkOrderStatus(tekmetricShopId, cached.workOrderId);
      
      if (!status || TERMINAL_STATUSES.includes(status)) {
        await db.collection("tekmetric_work_orders").updateOne(
          { _id: cached._id },
          {
            $set: {
              status: status || "Invoiced",
              closedAt: new Date(),
              updatedAt: new Date()
            }
          }
        );
        removedCount++;
      }
    } catch (err) {
    }
  }
  
  return removedCount;
}

// Reduced from 5→3 concurrent shops after observing widespread 429s in
// production. Combined with the larger in-batch stagger and inter-batch pause
// below, this roughly halves the per-second burst into Tekmetric.
const CONCURRENT_SHOPS = 3;
const IN_BATCH_STAGGER_MS = 1000;   // was 400
const BETWEEN_BATCH_PAUSE_MS = 2500; // was 1000

// In-process overlap guard: the cron ticks every 2 minutes, but a
// budget-starved cycle can run far longer. Never let two cycles stack in the
// same process — the new tick simply skips (the running one covers the fleet).
let cycleInFlight = false;

// Fair-rotation cursor: where the next cycle starts in the (sorted) shop
// list. In-memory is sufficient — it survives across ticks in the long-lived
// web process and merely resets to 0 on deploy.
let rotationOffset = 0;

export async function runIncrementalSyncCycle(options?: {
  // Ownership enforcement (centralized so no caller can bypass it): when
  // TEKMETRIC_INCREMENTAL_ON_WORKER=true, the background worker service
  // owns the cycle and every OTHER caller (cron route, daily-all, the
  // integration adapter, scripts, manual invocations) becomes a no-op —
  // otherwise a web-process caller would run a duplicate cycle the
  // worker's in-process overlap guard cannot see, recreating the
  // user-vs-background contention this flag exists to eliminate. Only
  // workers/tekmetric-incremental-loop.ts passes `asWorkerOwner: true`.
  asWorkerOwner?: boolean;
}): Promise<{
  results: IncrementalSyncResult[];
  duration: number;
  skippedOverlap?: boolean;
  deadlineHit?: boolean;
  shopsDeferred?: number;
  skippedNotOwner?: boolean;
}> {
  if (
    process.env.TEKMETRIC_INCREMENTAL_ON_WORKER === "true" &&
    !options?.asWorkerOwner
  ) {
    console.log(
      `[Tekmetric Incremental] Cycle owned by the background worker (TEKMETRIC_INCREMENTAL_ON_WORKER=true) — skipping non-worker invocation`,
    );
    return { results: [], duration: 0, skippedNotOwner: true };
  }
  if (cycleInFlight) {
    console.log(`[Tekmetric Incremental] Previous cycle still running — skipping this tick`);
    return { results: [], duration: 0, skippedOverlap: true };
  }
  cycleInFlight = true;
  try {
    return await _runIncrementalSyncCycle();
  } finally {
    cycleInFlight = false;
  }
}

async function _runIncrementalSyncCycle(): Promise<{
  results: IncrementalSyncResult[];
  duration: number;
  deadlineHit?: boolean;
  shopsDeferred?: number;
}> {
  const db = await getDb();
  const startTime = Date.now();
  const deadline = startTime + CYCLE_DEADLINE_MS;
  const results: IncrementalSyncResult[] = [];

  const shops = await db.collection("shops").find({
    $or: [
      { "tekmetric.shopId": { $exists: true, $ne: null } },
      { tekmetricShopId: { $exists: true, $ne: null } }
    ]
  }).toArray();

  const shopStates: ShopSyncState[] = [];
  for (const shop of shops) {
    const state = await getShopSyncState(db, Number(shop.shopId));
    if (state) {
      state.xAuthToken = shop.tekmetric?.xAuthToken || null;
      shopStates.push(state);
    }
  }

  // Task #1089 (webhook-first sync): shops with confirmed, live webhook
  // coverage drop to the slow safety-net poll cadence; everyone else keeps
  // the fast 2-minute poll. Coverage requires auto-subscribe to be ON, a
  // healthy managed subscription row, AND a recent webhook event — all three,
  // so nothing can go stale silently. Skipped shops are reported in the
  // results (skipReason starts with "webhook_covered") so the cycle
  // completion log can show the API-demand reduction.
  const autoSubscribeEnabled = process.env.TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE === "true";
  const webhookFirstDisabled = isWebhookFirstDisabled();
  const subscribedOk = new Set<number>();
  if (autoSubscribeEnabled && !webhookFirstDisabled) {
    try {
      const subRows = await db.collection("tekmetric_webhook_subscriptions").find(
        { tekmetricShopId: { $in: shopStates.map(s => s.tekmetricShopId) } },
        { projection: { tekmetricShopId: 1, "lastResult.ok": 1 } }
      ).toArray();
      for (const row of subRows as any[]) {
        if (row?.lastResult?.ok === true) subscribedOk.add(Number(row.tekmetricShopId));
      }
    } catch (err: any) {
      // Fail open to the fast poll: if we can't read subscription health we
      // must not skip anyone.
      console.warn(`[Tekmetric Incremental] webhook subscription lookup failed (all shops fast-poll this tick): ${err?.message || err}`);
    }
  }

  const webhookSkipped: IncrementalSyncResult[] = [];
  const toPoll: ShopSyncState[] = [];
  for (const state of shopStates) {
    const coverage = classifyWebhookCoverage({
      autoSubscribeEnabled,
      subscriptionOk: subscribedOk.has(state.tekmetricShopId),
      lastWebhookEventAt: state.lastWebhookEventAt,
    });
    const cadence = selectPollCadence({
      coverage,
      lastSyncCursor: state.lastSyncCursor,
      webhookFirstDisabled,
    });
    if (cadence.poll) {
      toPoll.push(state);
    } else {
      webhookSkipped.push({
        shopId: state.shopId,
        tekmetricShopId: state.tekmetricShopId,
        synced: 0,
        removed: 0,
        fromCache: { vehicles: 0, customers: 0 },
        negativeCacheHits: { vehicles: 0, customers: 0 },
        liveFetches: { vehicles: 0, customers: 0 },
        pagesQueued: 0,
        terminalSwept: false,
        skipped: true,
        skipReason: cadence.skipReason,
      });
    }
  }
  if (webhookSkipped.length > 0) {
    console.log(`[Tekmetric Incremental] Webhook-first: ${webhookSkipped.length}/${shopStates.length} shops webhook-covered — skipped this tick (safety-net poll pending), ${toPoll.length} polled`);
  }
  results.push(...webhookSkipped);

  // Fair rotation: stable order, then start where the last cycle left off so
  // deadline-deferred tail shops are FIRST next tick instead of starved
  // forever (same-order restarts would otherwise never reach them).
  toPoll.sort((a, b) => a.shopId - b.shopId);
  const offset = toPoll.length > 0 ? rotationOffset % toPoll.length : 0;
  const rotated = toPoll.slice(offset).concat(toPoll.slice(0, offset));

  // Process shops in concurrent batches
  let deadlineHit = false;
  let shopsDeferred = 0;
  let processed = 0;
  for (let i = 0; i < rotated.length; i += CONCURRENT_SHOPS) {
    if (Date.now() > deadline) {
      deadlineHit = true;
      shopsDeferred = rotated.length - i;
      console.log(`[Tekmetric Incremental] Cycle deadline (${CYCLE_DEADLINE_MS}ms) hit — deferring ${shopsDeferred} shops to next tick (they run first)`);
      break;
    }
    const batch = rotated.slice(i, i + CONCURRENT_SHOPS);
    
    const batchPromises = batch.map(async (state, index) => {
      // Stagger within batch to avoid bursting Tekmetric on each batch start.
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, index * IN_BATCH_STAGGER_MS));
      }
      return syncShopIncremental(state.shopId, state.tekmetricShopId, state, state.xAuthToken, deadline);
    });
    processed += batch.length;

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Pause between batches to give Tekmetric's per-IP rate limit room to recover.
    if (i + CONCURRENT_SHOPS < rotated.length) {
      await new Promise(resolve => setTimeout(resolve, BETWEEN_BATCH_PAUSE_MS));
    }
  }

  // Advance the rotation cursor past the shops we processed so a
  // deadline-deferred tail goes first next cycle. On a full sweep this wraps
  // back to the same start point, which is fine. (The cursor rotates over the
  // polled subset; webhook-covered skips don't consume rotation slots.)
  if (toPoll.length > 0) {
    rotationOffset = (offset + processed) % toPoll.length;
  }

  return {
    results,
    duration: Date.now() - startTime,
    deadlineHit,
    shopsDeferred,
  };
}

export async function ensureCacheIndexes(): Promise<void> {
  const db = await getDb();
  
  await db.collection("tekmetric_vehicle_cache").createIndex(
    { vehicleId: 1 },
    { unique: true }
  );
  await db.collection("tekmetric_vehicle_cache").createIndex(
    { cachedAt: 1 },
    { expireAfterSeconds: 86400 }
  );
  
  await db.collection("tekmetric_customer_cache").createIndex(
    { customerId: 1 },
    { unique: true }
  );
  await db.collection("tekmetric_customer_cache").createIndex(
    { cachedAt: 1 },
    { expireAfterSeconds: 86400 }
  );

  // Jobs cache. TTL matches JOBS_CACHE_TTL_MS (30 days) — terminal RO job
  // payloads don't change, so a long TTL maximizes cache hit rate during
  // backfill verification reruns and post-error retries.
  await db.collection("tekmetric_jobs_cache").createIndex(
    { repairOrderId: 1 },
    { unique: true }
  );
  await db.collection("tekmetric_jobs_cache").createIndex(
    { cachedAt: 1 },
    { expireAfterSeconds: 30 * 24 * 60 * 60 }
  );
}
