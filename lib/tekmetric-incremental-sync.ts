import { 
  getRepairOrders, 
  getVehicle, 
  getCustomer,
  getTekmetricWorkOrderStatus,
  TekmetricRepairOrderFull,
  TekmetricVehicle,
  TekmetricCustomer
} from "@/lib/tekmetric";
import {
  upsertTekmetricWorkOrder,
  getShopByShopId,
  getShopTekmetricState,
  updateShopTekmetricSyncState,
  getTekmetricEnabledShops,
  getCachedVehicle,
  setCachedVehicle,
  getCachedCustomer,
  setCachedCustomer,
  sql
} from "@/lib/db";

const ACTIVE_STATUS_IDS = [1, 2, 3, 4];
const TERMINAL_STATUSES = ["Invoice", "Invoiced", "Posted", "Deleted", "Void"];
const MAX_PAGES_PER_CYCLE = 3;
const MAX_QUEUED_PAGES = 20;
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

export async function syncShopIncremental(
  shopId: number,
  tekmetricShopId: number,
  state: ShopSyncState
): Promise<IncrementalSyncResult> {
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

  const shop = await getShopByShopId(shopId);
  if (!shop) {
    result.error = `Shop ${shopId} not found`;
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

    await updateShopTekmetricSyncState(shopId, { consecutiveAuthFailures: 0 });

    let newOverflowQueue = [...state.overflowQueue];
    if (state.overflowQueue.length > 0) {
      newOverflowQueue.shift();
    }
    
    if (!response.last && newOverflowQueue.length < MAX_QUEUED_PAGES) {
      newOverflowQueue.push({
        page: pageToFetch + 1,
        updatedDateStart: updatedDateFilter,
        createdAt: new Date(),
      });
      result.pagesQueued = newOverflowQueue.length;
    }

    for (const ro of response.content) {
      let vehicle = await getCachedVehicle(ro.vehicleId) as TekmetricVehicle | null;
      if (vehicle) {
        result.fromCache.vehicles++;
      } else {
        try {
          vehicle = await getVehicle(ro.vehicleId);
          await setCachedVehicle(ro.vehicleId, vehicle as unknown as Record<string, unknown>);
        } catch (err) {
          console.log(`[Tekmetric Incremental] Failed to fetch vehicle ${ro.vehicleId}`);
          continue;
        }
      }

      let customer = await getCachedCustomer(ro.customerId) as TekmetricCustomer | null;
      if (customer) {
        result.fromCache.customers++;
      } else {
        try {
          customer = await getCustomer(ro.customerId);
          await setCachedCustomer(ro.customerId, customer as unknown as Record<string, unknown>);
        } catch (err) {
        }
      }

      if (vehicle?.vin) {
        await upsertWorkOrderPg(shop.id, shopId, ro, vehicle, customer);
        result.synced++;
      }
    }

    const shouldSweepTerminal = !state.lastClosedSweepAt || 
      (Date.now() - state.lastClosedSweepAt.getTime()) > TERMINAL_SWEEP_INTERVAL_MS;

    if (shouldSweepTerminal && newOverflowQueue.length === 0) {
      const swept = await sweepTerminalStatuses(shop.id, shopId, tekmetricShopId);
      result.removed = swept;
      result.terminalSwept = true;
      await updateShopTekmetricSyncState(shopId, { lastClosedSweepAt: new Date() });
    }

    await updateShopTekmetricSyncState(shopId, {
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
      
      await updateShopTekmetricSyncState(shopId, {
        consecutiveAuthFailures: newFailures,
        pausedUntil: pauseUntil,
      });
    }
    
    result.error = err.message;
    return result;
  }
}

async function upsertWorkOrderPg(
  shopUUID: string,
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

  await upsertTekmetricWorkOrder(shopUUID, shopId, {
    workOrderId: String(ro.id),
    workOrderNumber: ro.repairOrderNumber ? String(ro.repairOrderNumber) : null,
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
    vehicleSubmodel: vehicle.subModel,
    mileageIn: ro.milesIn || vehicle.mileageIn,
    mileageOut: ro.milesOut || vehicle.mileageOut,
    createdDate: ro.createdDate ? new Date(ro.createdDate) : null,
    closedDate: ro.completedDate ? new Date(ro.completedDate) : null,
    rawData: ro as unknown as Record<string, unknown>,
  });
}

async function sweepTerminalStatuses(
  shopUUID: string,
  shopId: number,
  tekmetricShopId: number
): Promise<number> {
  const cachedWOs = await sql<{id: string; work_order_id: string; status: string}[]>`
    SELECT id, work_order_id, status FROM tekmetric_work_orders
    WHERE shop_id = ${shopUUID}
    AND status NOT IN ('Invoice', 'Invoiced', 'Posted', 'Deleted', 'Void')
    AND synced_at < ${new Date(Date.now() - 5 * 60 * 1000)}
    LIMIT 50
  `;

  let removedCount = 0;
  
  for (const cached of cachedWOs) {
    try {
      const status = await getTekmetricWorkOrderStatus(tekmetricShopId, cached.work_order_id);
      
      if (!status || TERMINAL_STATUSES.includes(status)) {
        await sql`
          UPDATE tekmetric_work_orders
          SET status = ${status || 'Invoiced'},
              closed_date = NOW(),
              synced_at = NOW()
          WHERE id = ${cached.id}
        `;
        removedCount++;
      }
    } catch (err) {
    }
  }
  
  return removedCount;
}

const CONCURRENT_SHOPS = 5;

export async function runIncrementalSyncCycle(): Promise<{
  results: IncrementalSyncResult[];
  duration: number;
}> {
  const startTime = Date.now();
  const results: IncrementalSyncResult[] = [];

  const shops = await getTekmetricEnabledShops();

  const shopStates: ShopSyncState[] = [];
  for (const shop of shops) {
    if (!shop.shop_id) continue;
    const state = await getShopTekmetricState(Number(shop.shop_id));
    if (state && state.tekmetricShopId !== null) {
      shopStates.push({
        ...state,
        tekmetricShopId: state.tekmetricShopId,
        overflowQueue: state.overflowQueue as OverflowPage[],
      });
    }
  }

  for (let i = 0; i < shopStates.length; i += CONCURRENT_SHOPS) {
    const batch = shopStates.slice(i, i + CONCURRENT_SHOPS);
    
    const batchPromises = batch.map(async (state, index) => {
      if (index > 0) {
        await new Promise(resolve => setTimeout(resolve, index * 400));
      }
      return syncShopIncremental(state.shopId, state.tekmetricShopId, state);
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
    
    if (i + CONCURRENT_SHOPS < shopStates.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return {
    results,
    duration: Date.now() - startTime,
  };
}
