import sql from '@/lib/db/postgres';
import { enqueuePrefetch, PREFETCH_PRIORITY } from '@/lib/prefetch-queue';
import { updateCachedPlanMileage } from '@/lib/plan-cache';

export interface WebhookVehicleUpdate {
  vin: string;
  mileage?: number | null;
  customerId?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
}

export interface WebhookWorkOrderUpdate {
  roNumber: string;
  status: string;
  vin?: string | null;
  mileage?: number | null;
  customerId?: string | null;
}

export async function syncVehicleFromWebhook(
  shopId: string,
  update: WebhookVehicleUpdate
): Promise<{ updated: boolean; prefetchQueued: boolean }> {
  if (!update.vin) {
    return { updated: false, prefetchQueued: false };
  }
  
  const normalizedVin = update.vin.toUpperCase();
  
  const existing = await sql`
    SELECT v.id, v.last_mileage, s.shop_id as shop_id_str
    FROM vehicles v
    JOIN shops s ON v.shop_id = s.id
    WHERE s.shop_id = ${shopId}
      AND UPPER(v.vin) = ${normalizedVin}
    LIMIT 1
  `;
  
  if (existing[0]) {
    const vehicle = existing[0] as any;
    const oldMileage = vehicle.last_mileage;
    const newMileage = update.mileage;
    
    if (newMileage && newMileage > (oldMileage || 0)) {
      await sql`
        UPDATE vehicles
        SET last_mileage = ${newMileage},
            mileage_updated_at = NOW(),
            updated_at = NOW()
        WHERE id = ${vehicle.id}
      `;
      
      const shopIdNum = Number(shopId);
      const cacheResult = await updateCachedPlanMileage(normalizedVin, shopIdNum, newMileage);
      
      if (cacheResult.crossedInterval) {
        const shopUuid = await getShopUuid(shopId);
        if (shopUuid) {
          await enqueuePrefetch(shopUuid, normalizedVin, PREFETCH_PRIORITY.WEBHOOK_UPDATE, 'webhook_mileage_update');
        }
        return { updated: true, prefetchQueued: true };
      }
      
      return { updated: true, prefetchQueued: false };
    }
  } else if (update.mileage || update.year || update.make || update.model) {
    const shopUuid = await getShopUuid(shopId);
    if (shopUuid) {
      await sql`
        INSERT INTO vehicles (shop_id, vin, last_mileage, year, make, model, mileage_updated_at, created_at, updated_at)
        VALUES (${shopUuid}::uuid, ${normalizedVin}, ${update.mileage || null}, ${update.year || null}, ${update.make || null}, ${update.model || null}, NOW(), NOW(), NOW())
        ON CONFLICT (shop_id, vin) DO UPDATE SET
          last_mileage = COALESCE(EXCLUDED.last_mileage, vehicles.last_mileage),
          year = COALESCE(EXCLUDED.year, vehicles.year),
          make = COALESCE(EXCLUDED.make, vehicles.make),
          model = COALESCE(EXCLUDED.model, vehicles.model),
          mileage_updated_at = NOW(),
          updated_at = NOW()
      `;
      
      await enqueuePrefetch(shopUuid, normalizedVin, PREFETCH_PRIORITY.WEBHOOK_UPDATE, 'webhook_new_vehicle');
      return { updated: true, prefetchQueued: true };
    }
  }
  
  return { updated: false, prefetchQueued: false };
}

export async function syncWorkOrderFromWebhook(
  shopId: string,
  update: WebhookWorkOrderUpdate
): Promise<{ updated: boolean; prefetchQueued: boolean }> {
  const shopUuid = await getShopUuid(shopId);
  if (!shopUuid) {
    return { updated: false, prefetchQueued: false };
  }
  
  const isInProgress = ['In Progress', 'Waiting', 'Open', 'Estimate'].includes(update.status);
  
  await sql`
    INSERT INTO work_orders (shop_id, ro_number, status, vin, last_mileage, created_at, updated_at)
    VALUES (${shopUuid}::uuid, ${update.roNumber}, ${update.status}, ${update.vin?.toUpperCase() || null}, ${update.mileage || null}, NOW(), NOW())
    ON CONFLICT (shop_id, ro_number) DO UPDATE SET
      status = EXCLUDED.status,
      vin = COALESCE(EXCLUDED.vin, work_orders.vin),
      last_mileage = COALESCE(EXCLUDED.last_mileage, work_orders.last_mileage),
      updated_at = NOW()
  `;
  
  if (update.vin && isInProgress) {
    await enqueuePrefetch(shopUuid, update.vin.toUpperCase(), PREFETCH_PRIORITY.IN_PROGRESS_RO, 'webhook_in_progress_ro');
    return { updated: true, prefetchQueued: true };
  }
  
  if (update.vin && update.mileage) {
    await syncVehicleFromWebhook(shopId, {
      vin: update.vin,
      mileage: update.mileage,
    });
  }
  
  return { updated: true, prefetchQueued: false };
}

async function getShopUuid(shopId: string): Promise<string | null> {
  const rows = await sql`
    SELECT id FROM shops WHERE shop_id = ${shopId} LIMIT 1
  `;
  return rows[0]?.id || null;
}

export async function processAutoflowWebhook(
  shopId: string,
  payload: any
): Promise<{ vehiclesUpdated: number; workOrdersUpdated: number; prefetchQueued: number }> {
  let vehiclesUpdated = 0;
  let workOrdersUpdated = 0;
  let prefetchQueued = 0;
  
  const vehicle = payload.vehicle;
  const ticket = payload.ticket;
  
  if (vehicle?.vin) {
    const result = await syncVehicleFromWebhook(shopId, {
      vin: vehicle.vin,
      mileage: vehicle.mileage || ticket?.mileage,
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
    });
    if (result.updated) vehiclesUpdated++;
    if (result.prefetchQueued) prefetchQueued++;
  }
  
  if (ticket?.id || ticket?.invoice) {
    const result = await syncWorkOrderFromWebhook(shopId, {
      roNumber: String(ticket.invoice || ticket.id),
      status: ticket.status || 'Unknown',
      vin: vehicle?.vin,
      mileage: ticket.mileage || vehicle?.mileage,
    });
    if (result.updated) workOrdersUpdated++;
    if (result.prefetchQueued) prefetchQueued++;
  }
  
  return { vehiclesUpdated, workOrdersUpdated, prefetchQueued };
}
