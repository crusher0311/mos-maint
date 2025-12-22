import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import { resolveAutoflowConfig, fetchDviWithCache } from "@/lib/integrations/autoflow";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";
import {
  resolveProtractorConfig,
  fetchVehicleWithCache as fetchProtractorVehicle,
  fetchDeferredWorkWithCache as fetchProtractorDeferredWork,
} from "@/lib/integrations/protractor";
import {
  resolveAutoVitalsConfig,
  fetchAutoVitalsInspectionByVin,
} from "@/lib/integrations/autovitals";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const vin = req.nextUrl.searchParams.get("vin")?.toUpperCase();
    
    if (!vin || vin.length !== 17) {
      return NextResponse.json(
        { error: "Valid 17-character VIN required" },
        { status: 400 }
      );
    }

    const db = await getDb();
    const results: Record<string, string> = {};

    const prefetchPromises: Promise<void>[] = [];

    prefetchPromises.push(
      getMaintenanceScheduleCached(vin)
        .then(() => { results.dataone = "cached"; })
        .catch((err) => { 
          results.dataone = `error: ${err.message}`; 
        })
    );

    prefetchPromises.push(
      (async () => {
        try {
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
                        vin.toUpperCase()
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
              const DVI_CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days - webhook updates on DVI completion
              await fetchDviWithCache(shopId, String(latestRoNumber), DVI_CACHE_TTL);
              results.dvi = "cached";
            } else {
              results.dvi = "not_configured";
            }
          } else {
            results.dvi = "no_ro";
          }
        } catch (err: any) {
          results.dvi = `error: ${err.message}`;
        }
      })()
    );

    prefetchPromises.push(
      (async () => {
        try {
          const carfaxCfg = await resolveCarfaxConfig(shopId);
          if (carfaxCfg.configured) {
            await fetchCarfaxWithCache(shopId, vin, 7 * 24 * 60 * 60 * 1000);
            results.carfax = "cached";
          } else {
            results.carfax = "not_configured";
          }
        } catch (err: any) {
          results.carfax = `error: ${err.message}`;
        }
      })()
    );

    prefetchPromises.push(
      db.collection("vehicles").findOne(
        { shopId, vin },
        { projection: { year: 1, make: 1, model: 1, lastMileage: 1 } }
      ).then(() => { results.vehicle = "cached"; })
       .catch((err) => { results.vehicle = `error: ${err.message}`; })
    );

    prefetchPromises.push(
      db.collection("shops").findOne(
        { shopId },
        { projection: { maintenance: 1 } }
      ).then(() => { results.shop = "cached"; })
       .catch((err) => { results.shop = `error: ${err.message}`; })
    );

    prefetchPromises.push(
      (async () => {
        try {
          const protractorCfg = await resolveProtractorConfig(shopId);
          if (protractorCfg.configured) {
            const protractorVehicle = await fetchProtractorVehicle(shopId, vin, 6 * 60 * 60 * 1000);
            if (protractorVehicle.ok && protractorVehicle.vehicle?.ID) {
              await fetchProtractorDeferredWork(
                shopId,
                vin,
                protractorVehicle.vehicle.ID,
                6 * 60 * 60 * 1000
              );
              results.protractor = "cached";
            } else {
              results.protractor = "no_vehicle";
            }
          } else {
            results.protractor = "not_configured";
          }
        } catch (err: any) {
          results.protractor = `error: ${err.message}`;
        }
      })()
    );

    prefetchPromises.push(
      (async () => {
        try {
          const autoVitalsCfg = await resolveAutoVitalsConfig(shopId);
          if (autoVitalsCfg.configured) {
            const avInspection = await fetchAutoVitalsInspectionByVin(shopId, vin, 6 * 60 * 60 * 1000);
            if (avInspection.ok) {
              results.autovitals = "cached";
            } else {
              results.autovitals = avInspection.error || "no_data";
            }
          } else {
            results.autovitals = "not_configured";
          }
        } catch (err: any) {
          results.autovitals = `error: ${err.message}`;
        }
      })()
    );

    await Promise.allSettled(prefetchPromises);

    const duration = Date.now() - startTime;
    console.log(`[Prefetch] VIN ${vin} completed in ${duration}ms:`, results);

    return NextResponse.json({
      ok: true,
      vin,
      message: "Plan data prefetched",
      duration,
      results,
      timestamp: new Date().toISOString()
    }, { status: 202 });

  } catch (err: any) {
    console.error("[Prefetch] Error:", err);
    return NextResponse.json(
      { error: "Prefetch failed", details: err.message },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json(
    { error: "Use POST method to prefetch plan data" },
    { status: 405 }
  );
}
