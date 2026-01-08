import { getDb } from "@/lib/mongo";
import { 
  getRepairOrders, 
  getVehicle, 
  getCustomer,
  getTekmetricWorkOrderStatus,
  TekmetricRepairOrderFull,
  TekmetricVehicle,
  TekmetricCustomer
} from "@/lib/tekmetric";

const ACTIVE_STATUS_IDS = [1, 2, 3, 4];
const TERMINAL_STATUSES = ["Invoice", "Invoiced", "Posted", "Deleted", "Void"];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES_PER_CYCLE = 1;
const TERMINAL_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export interface ShopSyncState {
  shopId: number;
  tekmetricShopId: number;
  lastSyncCursor: Date | null;
  overflowQueue: OverflowPage[];
  lastClosedSweepAt: Date | null;
  consecutiveAuthFailures: number;
  pausedUntil: Date | null;
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

async function getCachedVehicle(db: any, vehicleId: number): Promise<TekmetricVehicle | null> {
  const cached = await db.collection("tekmetric_vehicle_cache").findOne({
    vehicleId,
    cachedAt: { $gt: new Date(Date.now() - CACHE_TTL_MS) }
  });
  return cached?.data || null;
}

async function cacheVehicle(db: any, vehicleId: number, vehicle: TekmetricVehicle): Promise<void> {
  await db.collection("tekmetric_vehicle_cache").updateOne(
    { vehicleId },
    { 
      $set: { 
        vehicleId, 
        data: vehicle, 
        cachedAt: new Date() 
      } 
    },
    { upsert: true }
  );
}

async function getCachedCustomer(db: any, customerId: number): Promise<TekmetricCustomer | null> {
  const cached = await db.collection("tekmetric_customer_cache").findOne({
    customerId,
    cachedAt: { $gt: new Date(Date.now() - CACHE_TTL_MS) }
  });
  return cached?.data || null;
}

async function cacheCustomer(db: any, customerId: number, customer: TekmetricCustomer): Promise<void> {
  await db.collection("tekmetric_customer_cache").updateOne(
    { customerId },
    { 
      $set: { 
        customerId, 
        data: customer, 
        cachedAt: new Date() 
      } 
    },
    { upsert: true }
  );
}

export async function syncShopIncremental(
  shopId: number,
  tekmetricShopId: number,
  state: ShopSyncState
): Promise<IncrementalSyncResult> {
  const db = await getDb();
  const result: IncrementalSyncResult = {
    shopId,
    tekmetricShopId,
    synced: 0,
    removed: 0,
    fromCache: { vehicles: 0, customers: 0 },
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
    
    if (!response.last && pageToFetch < 10) {
      newOverflowQueue.push({
        page: pageToFetch + 1,
        updatedDateStart: updatedDateFilter,
        createdAt: new Date(),
      });
      result.pagesQueued = newOverflowQueue.length;
    }

    for (const ro of response.content) {
      let vehicle = await getCachedVehicle(db, ro.vehicleId);
      if (vehicle) {
        result.fromCache.vehicles++;
      } else {
        try {
          vehicle = await getVehicle(ro.vehicleId);
          await cacheVehicle(db, ro.vehicleId, vehicle);
        } catch (err) {
          console.log(`[Tekmetric Incremental] Failed to fetch vehicle ${ro.vehicleId}`);
          continue;
        }
      }

      let customer = await getCachedCustomer(db, ro.customerId);
      if (customer) {
        result.fromCache.customers++;
      } else {
        try {
          customer = await getCustomer(ro.customerId);
          await cacheCustomer(db, ro.customerId, customer);
        } catch (err) {
        }
      }

      if (vehicle?.vin) {
        await upsertWorkOrder(db, shopId, ro, vehicle, customer);
        result.synced++;
      }
    }

    const shouldSweepTerminal = !state.lastClosedSweepAt || 
      (Date.now() - state.lastClosedSweepAt.getTime()) > TERMINAL_SWEEP_INTERVAL_MS;

    if (shouldSweepTerminal && newOverflowQueue.length === 0) {
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
  ro: TekmetricRepairOrderFull,
  vehicle: TekmetricVehicle,
  customer?: TekmetricCustomer | null
): Promise<void> {
  const vin = vehicle.vin?.toUpperCase();
  if (!vin) return;

  const statusName = ro.repairOrderStatus?.name || ro.repairOrderStatus?.code || "Open";
  const statusCode = ro.repairOrderStatus?.code || "";
  const label = ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || "";

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
        odometer: ro.milesIn || ro.milesOut || vehicle.mileageIn || vehicle.mileageOut,
        createdDate: ro.createdDate,
        updatedDate: ro.updatedDate,
        completedDate: ro.completedDate,
        fetchedAt: new Date(),
        data: ro,
      },
      $setOnInsert: { dviDone: false, dviCompletedAt: null, lastInspection: null }
    },
    { upsert: true }
  );
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

export async function runIncrementalSyncCycle(): Promise<{
  results: IncrementalSyncResult[];
  duration: number;
}> {
  const db = await getDb();
  const startTime = Date.now();
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
      shopStates.push(state);
    }
  }

  for (let i = 0; i < shopStates.length; i++) {
    const state = shopStates[i];
    
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 5000 + Math.random() * 5000));
    }
    
    const result = await syncShopIncremental(state.shopId, state.tekmetricShopId, state);
    results.push(result);
  }

  return {
    results,
    duration: Date.now() - startTime,
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
}
