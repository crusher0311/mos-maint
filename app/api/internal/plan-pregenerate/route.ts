import { NextRequest, NextResponse } from "next/server";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";
import {
  resolveProtractorConfig,
  fetchVehicleWithCache as fetchProtractorVehicle,
  fetchDeferredWorkWithCache as fetchProtractorDeferredWork,
} from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  
  if (!CRON_SECRET) {
    console.error("[Plan Pregenerate] CRON_SECRET not configured - skipping");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { shopId, vins } = body;

    if (!shopId || !Array.isArray(vins) || vins.length === 0) {
      return NextResponse.json(
        { error: "shopId and vins array required" },
        { status: 400 }
      );
    }

    const results: Record<string, { status: string; duration: number; cached: string[] }> = {};

    const CARFAX_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
    const PROTRACTOR_CACHE_TTL = 6 * 60 * 60 * 1000;

    const [carfaxCfg, protractorCfg] = await Promise.all([
      resolveCarfaxConfig(shopId),
      resolveProtractorConfig(shopId),
    ]);

    const vinLimit = Math.min(vins.length, 50);
    const BATCH_SIZE = 5;
    
    async function processVin(vin: string): Promise<void> {
      const cleanVin = vin.toUpperCase();
      if (cleanVin.length !== 17) return;
      
      const vinStart = Date.now();
      const cached: string[] = [];
      
      try {
        const prefetchPromises: Promise<void>[] = [];

        prefetchPromises.push(
          getMaintenanceScheduleCached(cleanVin)
            .then(() => { cached.push("dataone"); })
            .catch(() => {})
        );

        if (carfaxCfg.configured) {
          prefetchPromises.push(
            fetchCarfaxWithCache(shopId, cleanVin, CARFAX_CACHE_TTL)
              .then(() => { cached.push("carfax"); })
              .catch(() => {})
          );
        }

        if (protractorCfg.configured) {
          prefetchPromises.push(
            (async () => {
              try {
                const vehicle = await fetchProtractorVehicle(shopId, cleanVin, PROTRACTOR_CACHE_TTL);
                cached.push("protractor_vehicle");
                if (vehicle.ok && vehicle.vehicle?.ID) {
                  await fetchProtractorDeferredWork(shopId, cleanVin, vehicle.vehicle.ID, PROTRACTOR_CACHE_TTL);
                  cached.push("protractor_deferred");
                }
              } catch {}
            })()
          );
        }

        await Promise.allSettled(prefetchPromises);

        results[cleanVin] = {
          status: "ok",
          duration: Date.now() - vinStart,
          cached,
        };
      } catch (err: any) {
        results[cleanVin] = {
          status: `error: ${err.message}`,
          duration: Date.now() - vinStart,
          cached,
        };
      }
    }
    
    const vinsToProcess = vins.slice(0, vinLimit).map(v => String(v));
    for (let i = 0; i < vinsToProcess.length; i += BATCH_SIZE) {
      const batch = vinsToProcess.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(processVin));
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[Plan Pregenerate] Processed ${Object.keys(results).length} VINs for shop ${shopId} in ${totalDuration}ms`);

    return NextResponse.json({
      ok: true,
      shopId,
      processed: Object.keys(results).length,
      duration: totalDuration,
      results,
    });

  } catch (err: any) {
    console.error("[Plan Pregenerate] Error:", err);
    return NextResponse.json(
      { error: "Pregeneration failed", details: err.message },
      { status: 500 }
    );
  }
}
