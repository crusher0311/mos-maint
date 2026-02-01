import sql from "@/lib/db/postgres";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import { resolveAutoflowConfig, fetchDviWithCache } from "@/lib/integrations/autoflow";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";
import {
  resolveProtractorConfig,
  fetchVehicleWithCache as fetchProtractorVehicle,
  fetchDeferredWorkWithCache as fetchProtractorDeferredWork,
  fetchCannedJobsWithCache,
  type ProtractorDeferredWork,
} from "@/lib/integrations/protractor";
import {
  resolveAutoVitalsConfig,
  fetchAutoVitalsInspectionByVin,
} from "@/lib/integrations/autovitals";

const CACHE_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours
const PROTRACTOR_CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours
const DVI_CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days

export interface PlanCacheData {
  vin: string;
  shopId: number;
  mileage: number | null;
  vehicle: {
    year: number | null;
    make: string | null;
    model: string | null;
    engine: string | null;
  };
  oemItemCount: number;
  carfaxRecordCount: number;
  dviCount: number;
  deferredWorkCount: number;
  serviceHistoryCount: number;
  createdAt: Date;
  expiresAt: Date;
  prefetched: boolean;
}

async function getShopUuid(shopId: number): Promise<string | null> {
  const rows = await sql`SELECT id FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1`;
  return rows[0]?.id as string | null;
}

export async function getPlanCache(vin: string, shopId: number): Promise<PlanCacheData | null> {
  const shopUuid = await getShopUuid(shopId);
  if (!shopUuid) return null;
  
  const vinUpper = vin.toUpperCase();
  const cacheKey = `plan:${vinUpper}`;
  
  const rows = await sql`
    SELECT data, expires_at, created_at
    FROM plan_prefetch_cache
    WHERE shop_id = ${shopUuid}::uuid
      AND vin = ${vinUpper}
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1
  `;
  
  if (rows.length === 0) return null;
  
  const row = rows[0];
  const data = row.data as any;
  
  return {
    vin: data.vin || vinUpper,
    shopId: data.shopId || shopId,
    mileage: data.mileage,
    vehicle: data.vehicle || { year: null, make: null, model: null, engine: null },
    oemItemCount: data.oemItemCount || 0,
    carfaxRecordCount: data.carfaxRecordCount || 0,
    dviCount: data.dviCount || 0,
    deferredWorkCount: data.deferredWorkCount || 0,
    serviceHistoryCount: data.serviceHistoryCount || 0,
    createdAt: new Date(row.created_at as string),
    expiresAt: new Date(row.expires_at as string),
    prefetched: data.prefetched || false,
  };
}

export async function setPlanCache(data: Omit<PlanCacheData, 'createdAt' | 'expiresAt'>): Promise<void> {
  const shopUuid = await getShopUuid(data.shopId);
  if (!shopUuid) return;
  
  const vinUpper = data.vin.toUpperCase();
  const cacheKey = `plan:${vinUpper}`;
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
  
  const jsonData = {
    ...data,
    vin: vinUpper,
  };
  
  await sql`
    INSERT INTO plan_prefetch_cache (id, cache_key, shop_id, vin, data, priority, expires_at, created_at)
    VALUES (gen_random_uuid(), ${cacheKey}, ${shopUuid}::uuid, ${vinUpper}, ${jsonData as any}::jsonb, 1, ${expiresAt}, NOW())
    ON CONFLICT (cache_key, shop_id) DO UPDATE SET
      data = EXCLUDED.data,
      expires_at = EXCLUDED.expires_at,
      created_at = NOW()
  `;
}

export async function prefetchPlanData(
  shopId: number,
  vin: string,
  mileage: number | null
): Promise<{
  success: boolean;
  duration: number;
  results: Record<string, string>;
}> {
  const startTime = Date.now();
  const results: Record<string, string> = {};
  const vinUpper = vin.toUpperCase();

  try {
    let oemData: any = { items: [], vehicle: null };
    try {
      oemData = await getMaintenanceScheduleCached(vinUpper);
      results.dataone = oemData.items?.length > 0 ? `${oemData.items.length} items` : "no_items";
    } catch (err: any) {
      results.dataone = `error: ${err.message}`;
    }

    const promises: Promise<void>[] = [];

    promises.push(
      (async () => {
        try {
          const carfaxCfg = await resolveCarfaxConfig(shopId);
          if (carfaxCfg.configured) {
            const carfax = await fetchCarfaxWithCache(shopId, vinUpper, CACHE_TTL_MS);
            results.carfax = (carfax as any).ok ? `${(carfax as any).serviceRecords?.length || 0} records` : "no_data";
          } else {
            results.carfax = "not_configured";
          }
        } catch (err: any) {
          results.carfax = `error: ${err.message}`;
        }
      })()
    );

    promises.push(
      (async () => {
        try {
          const shopUuid = await getShopUuid(shopId);
          if (!shopUuid) {
            results.autoflow = "shop_not_found";
            return;
          }
          
          const eventRows = await sql`
            SELECT payload->>'ticket'->>'invoice' as ro_number
            FROM events
            WHERE shop_id = ${shopUuid}::uuid
              AND provider = 'autoflow'
              AND UPPER(vin) = ${vinUpper}
              AND payload->>'ticket'->>'invoice' IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 1
          `;

          const latestRoNumber = eventRows[0]?.ro_number ?? null;

          if (latestRoNumber) {
            const autoCfg = await resolveAutoflowConfig(shopId);
            if (autoCfg.configured) {
              const dvi = await fetchDviWithCache(shopId, String(latestRoNumber), DVI_CACHE_TTL);
              results.autoflow = (dvi as any).ok ? `${(dvi as any).categories?.length || 0} categories` : "no_data";
            } else {
              results.autoflow = "not_configured";
            }
          } else {
            results.autoflow = "no_ro";
          }
        } catch (err: any) {
          results.autoflow = `error: ${err.message}`;
        }
      })()
    );

    promises.push(
      (async () => {
        try {
          const protractorCfg = await resolveProtractorConfig(shopId);
          if (protractorCfg.configured) {
            const vehicleResult = await fetchProtractorVehicle(shopId, vinUpper, PROTRACTOR_CACHE_TTL);
            if ((vehicleResult as any).ok && (vehicleResult as any).vehicle?.ID) {
              results.protractor_vehicle = "cached";
              const deferredResult = await fetchProtractorDeferredWork(
                shopId,
                vinUpper,
                (vehicleResult as any).vehicle.ID,
                PROTRACTOR_CACHE_TTL
              );
              results.protractor_deferred = deferredResult.ok 
                ? `${deferredResult.deferredWork?.length || 0} items` 
                : "no_data";
            } else {
              results.protractor_vehicle = "no_vehicle";
              results.protractor_deferred = "skipped";
            }
          } else {
            results.protractor_vehicle = "not_configured";
            results.protractor_deferred = "not_configured";
          }
        } catch (err: any) {
          results.protractor_vehicle = `error: ${err.message}`;
          results.protractor_deferred = "skipped";
        }
      })()
    );

    promises.push(
      (async () => {
        try {
          const avCfg = await resolveAutoVitalsConfig(shopId);
          if (avCfg.configured) {
            const avInspection = await fetchAutoVitalsInspectionByVin(shopId, vinUpper);
            results.autovitals = avInspection.ok 
              ? `${avInspection.items?.length || 0} items` 
              : "no_data";
          } else {
            results.autovitals = "not_configured";
          }
        } catch (err: any) {
          results.autovitals = `error: ${err.message}`;
        }
      })()
    );

    promises.push(
      (async () => {
        try {
          const cannedJobs = await fetchCannedJobsWithCache(shopId);
          results.canned_jobs = cannedJobs.ok 
            ? `${cannedJobs.cannedJobs?.length || 0} jobs` 
            : "no_data";
        } catch (err: any) {
          results.canned_jobs = `error: ${err.message}`;
        }
      })()
    );

    await Promise.allSettled(promises);

    await setPlanCache({
      vin: vinUpper,
      shopId,
      mileage,
      vehicle: {
        year: oemData.vehicle?.year ?? null,
        make: oemData.vehicle?.make ?? null,
        model: oemData.vehicle?.model ?? null,
        engine: oemData.vehicle?.engine ?? null,
      },
      oemItemCount: oemData.items?.length || 0,
      carfaxRecordCount: parseInt(results.carfax?.match(/\d+/)?.[0] || '0'),
      dviCount: parseInt(results.autoflow?.match(/\d+/)?.[0] || '0') + parseInt(results.autovitals?.match(/\d+/)?.[0] || '0'),
      deferredWorkCount: parseInt(results.protractor_deferred?.match(/\d+/)?.[0] || '0'),
      serviceHistoryCount: 0,
      prefetched: true,
    });

    const duration = Date.now() - startTime;
    return { success: true, duration, results };

  } catch (err: any) {
    const duration = Date.now() - startTime;
    results.error = err.message;
    return { success: false, duration, results };
  }
}

export async function isPlanPrefetched(vin: string, shopId: number): Promise<boolean> {
  const cache = await getPlanCache(vin, shopId);
  return cache !== null && cache.prefetched === true;
}
