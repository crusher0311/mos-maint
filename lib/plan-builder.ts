import { Db } from "mongodb";
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

export async function getPlanCache(db: Db, vin: string, shopId: number): Promise<PlanCacheData | null> {
  const cached = await db.collection("plan_prefetch_cache").findOne({
    vin: vin.toUpperCase(),
    shopId,
    expiresAt: { $gt: new Date() },
  });
  return cached as PlanCacheData | null;
}

export async function setPlanCache(db: Db, data: Omit<PlanCacheData, 'createdAt' | 'expiresAt'>): Promise<void> {
  const now = new Date();
  await db.collection("plan_prefetch_cache").updateOne(
    { vin: data.vin.toUpperCase(), shopId: data.shopId },
    {
      $set: {
        ...data,
        vin: data.vin.toUpperCase(),
        createdAt: now,
        expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
      },
    },
    { upsert: true }
  );
}

export async function prefetchPlanData(
  db: Db,
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
    // Fetch OEM data first (always needed)
    let oemData: any = { items: [], vehicle: null };
    try {
      oemData = await getMaintenanceScheduleCached(vinUpper);
      results.dataone = oemData.items?.length > 0 ? `${oemData.items.length} items` : "no_items";
    } catch (err: any) {
      results.dataone = `error: ${err.message}`;
    }

    // Parallel fetch all other data sources
    const promises: Promise<void>[] = [];

    // Carfax
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

    // AutoFlow DVI
    promises.push(
      (async () => {
        try {
          // Find latest RO for this VIN from events
          const eventRos = await db.collection("events").aggregate([
            {
              $match: {
                $and: [
                  { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
                  { provider: "autoflow" },
                  {
                    $expr: {
                      $eq: [
                        { $toUpper: { $ifNull: ["$vehicleVin", { $ifNull: ["$vin", "$payload.vehicle.vin"] }] } },
                        vinUpper
                      ]
                    }
                  }
                ]
              }
            },
            {
              $addFields: {
                roNumber: { $ifNull: ["$payload.ticket.invoice", { $ifNull: ["$payload.ticket.id", "$roNumber"] }] }
              }
            },
            { $match: { roNumber: { $ne: null } } },
            { $sort: { createdAt: -1 } },
            { $limit: 1 },
            { $project: { roNumber: 1 } }
          ]).toArray();

          const latestRoNumber = eventRos[0]?.roNumber ?? null;

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

    // Protractor vehicle and deferred work
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

    // AutoVitals DVI
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

    // Canned jobs
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

    // Save to prefetch cache
    await setPlanCache(db, {
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
      serviceHistoryCount: 0, // Will be populated when plan is fully built
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

export async function isPlanPrefetched(db: Db, vin: string, shopId: number): Promise<boolean> {
  const cache = await getPlanCache(db, vin, shopId);
  return cache !== null && cache.prefetched === true;
}
