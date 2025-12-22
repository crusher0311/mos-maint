import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  fetchActiveWorkOrders,
  fetchWorkOrderById,
  upsertProtractorVehicleSnapshot,
  upsertProtractorWorkOrderSnapshot,
  fetchDeferredWork,
  upsertProtractorDeferredWorkSnapshot,
  fetchCannedJobs,
  upsertCannedJobsCache,
} from "@/lib/integrations/protractor";
import pLimit from "p-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const config = await resolveProtractorConfig(shopId);
  
  if (!config.configured) {
    return NextResponse.json(
      { error: "Protractor is not configured for this shop" },
      { status: 400 }
    );
  }

  const db = await getDb();

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);

  const workOrdersResult = await fetchActiveWorkOrders(shopId, {
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],
    readInProgress: true,
  });

  if (!workOrdersResult.ok) {
    return NextResponse.json(
      { error: workOrdersResult.error || "Failed to fetch work orders" },
      { status: 500 }
    );
  }

  const workOrdersFromList = workOrdersResult.workOrders || [];
  const results = {
    workOrdersFound: workOrdersFromList.length,
    vehiclesSynced: 0,
    deferredWorkSynced: 0,
    cannedJobsSynced: 0,
    vehicleDetails: [] as Array<{ vin: string; year?: number; make?: string; model?: string; odometer?: number; woOdometer?: number }>,
    errors: [] as string[],
  };

  // Sync canned jobs / service package templates
  try {
    const cannedJobsResult = await fetchCannedJobs(shopId);
    if (cannedJobsResult.ok && cannedJobsResult.cannedJobs) {
      await upsertCannedJobsCache(shopId, cannedJobsResult.cannedJobs);
      results.cannedJobsSynced = cannedJobsResult.cannedJobs.length;
      console.log(`[Protractor Sync] Synced ${results.cannedJobsSynced} canned jobs`);
    } else if (cannedJobsResult.error) {
      results.errors.push(`Canned jobs: ${cannedJobsResult.error}`);
    }
  } catch (err: any) {
    results.errors.push(`Canned jobs: ${err.message}`);
  }

  // Fetch individual work orders to get complete data (including Odometer)
  // Rate limit to 3 concurrent requests to avoid overwhelming the API
  const limit = pLimit(3);
  
  const detailedWorkOrders = await Promise.all(
    workOrdersFromList.map((wo) =>
      limit(async () => {
        const detailResult = await fetchWorkOrderById(shopId, wo.ID);
        if (detailResult.ok && detailResult.workOrder) {
          return detailResult.workOrder;
        }
        // Fallback to list data if detail fetch fails
        return wo;
      })
    )
  );

  for (const wo of detailedWorkOrders) {
    try {
      if (wo.ServiceItem) {
        const vehicle = wo.ServiceItem;
        const vin = vehicle.VIN?.toUpperCase();
        
        // Use work order InUsage (more current) or fall back to vehicle Usage
        const currentOdometer = wo.InUsage ?? vehicle.Usage ?? wo.Odometer ?? vehicle.Odometer;
        
        if (vin) {
          await upsertProtractorVehicleSnapshot(shopId, vin, vehicle);
          
          await db.collection("vehicles").updateOne(
            { 
              $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
              vin 
            },
            {
              $setOnInsert: {
                shopId,
                vin,
                createdAt: new Date(),
              },
              $set: {
                year: vehicle.Year,
                make: vehicle.Make,
                model: vehicle.Model,
                license: vehicle.LicensePlate,
                lastMileage: currentOdometer,
                updatedAt: new Date(),
                protractorId: vehicle.ID,
              },
            },
            { upsert: true }
          );

          results.vehiclesSynced++;
          results.vehicleDetails.push({
            vin,
            year: vehicle.Year,
            make: vehicle.Make,
            model: vehicle.Model,
            odometer: vehicle.Usage ?? vehicle.Odometer,
            woOdometer: wo.InUsage ?? wo.Odometer,
          });

          if (vehicle.ID) {
            try {
              const twoYearsAgo = new Date();
              twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
              
              const deferredResult = await fetchDeferredWork(shopId, vehicle.ID, {
                startDate: twoYearsAgo.toISOString().split("T")[0],
                endDate: endDate.toISOString().split("T")[0],
              });
              
              if (deferredResult.ok && deferredResult.deferredWork?.length) {
                await upsertProtractorDeferredWorkSnapshot(shopId, vin, deferredResult.deferredWork);
                results.deferredWorkSynced += deferredResult.deferredWork.length;
              }
            } catch (err: any) {
              results.errors.push(`Deferred work for ${vin}: ${err.message}`);
            }
          }
        }
      }

      await upsertProtractorWorkOrderSnapshot(shopId, wo);
    } catch (err: any) {
      results.errors.push(`Work order ${wo.ID}: ${err.message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    message: `Synced ${results.vehiclesSynced} vehicles from ${results.workOrdersFound} work orders`,
    ...results,
  });
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const config = await resolveProtractorConfig(shopId);
  
  if (!config.configured) {
    return NextResponse.json({
      ok: true,
      configured: false,
      message: "Protractor is not configured",
    });
  }

  const db = await getDb();
  
  const vehicleCount = await db.collection("protractor_vehicles").countDocuments({ shopId });
  const workOrderCount = await db.collection("protractor_work_orders").countDocuments({ shopId });
  const deferredWorkCount = await db.collection("protractor_deferred_work").countDocuments({ shopId });
  
  const cannedJobsCache = await db.collection("protractor_canned_jobs").findOne({ shopId });
  const cannedJobsCount = cannedJobsCache?.items?.length || 0;

  const lastSync = await db.collection("protractor_vehicles")
    .find({ shopId })
    .sort({ fetchedAt: -1 })
    .limit(1)
    .toArray();

  return NextResponse.json({
    ok: true,
    configured: true,
    stats: {
      vehicles: vehicleCount,
      workOrders: workOrderCount,
      deferredWorkItems: deferredWorkCount,
      cannedJobs: cannedJobsCount,
      lastSync: lastSync[0]?.fetchedAt || null,
    },
    cannedJobs: cannedJobsCache?.items || [],
  });
}
