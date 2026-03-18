import { getDb } from "@/lib/mongo";
import { 
  getRepairOrders, 
  getVehicle, 
  getCustomer,
  getRepairOrderInspections,
  TekmetricRepairOrderFull,
  TekmetricVehicle,
  TekmetricCustomer
} from "@/lib/tekmetric";

const ACTIVE_STATUS_IDS = [1, 2, 3, 4];

interface SyncResult {
  success: boolean;
  synced: number;
  error?: string;
}

export async function syncSingleShop(
  shopId: number | string, 
  tekmetricShopId: number
): Promise<SyncResult> {
  const db = await getDb();
  const numericShopId = Number(shopId);
  
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

    for (const ro of activeWOs) {
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
          const customer = await getCustomer(ro.customerId);
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
            },
            $setOnInsert: { dviDone: false, dviCompletedAt: null, lastInspection: null }
          },
          { upsert: true }
        );

        try {
          const inspections = await getRepairOrderInspections(ro.id);
          if (inspections.length > 0) {
            await db.collection("tekmetric_work_orders").updateOne(
              { shopId: { $in: [String(numericShopId), numericShopId] }, workOrderId: String(ro.id) },
              { $set: { dviDone: true, dviCompletedAt: new Date() } }
            );
          }
        } catch (err) {
        }
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
