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
  fetchServicePackageTemplateDetail,
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
  startDate.setDate(startDate.getDate() - 365); // Full year of work history

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
  console.log(`[Protractor Sync] Fetching service packages...`);
  try {
    const cannedJobsResult = await fetchCannedJobs(shopId);
    console.log(`[Protractor Sync] Canned jobs API result: ok=${cannedJobsResult.ok}, count=${cannedJobsResult.cannedJobs?.length || 0}`);
    
    if (cannedJobsResult.ok && cannedJobsResult.cannedJobs?.length) {
      // Fetch full details for each template (with lines) using rate limiting
      const templateLimit = pLimit(5); // 5 concurrent requests
      console.log(`[Protractor Sync] Fetching full details for ${cannedJobsResult.cannedJobs.length} templates...`);
      
      const templatesWithDetails = await Promise.all(
        cannedJobsResult.cannedJobs.map((template: any) =>
          templateLimit(async () => {
            try {
              const detailResult = await fetchServicePackageTemplateDetail(shopId, template.ID);
              if (detailResult.ok && detailResult.template) {
                const linesCount = detailResult.template.ServicePackageLines?.ItemCollection?.length || 0;
                if (linesCount > 0) {
                  console.log(`[Protractor Sync] Template ${template.Code}: ${linesCount} lines`);
                }
                return detailResult.template;
              }
            } catch (err: any) {
              console.log(`[Protractor Sync] Failed to fetch detail for ${template.Code}: ${err.message}`);
            }
            // Fall back to summary if detail fetch fails
            return template;
          })
        )
      );
      
      await upsertCannedJobsCache(shopId, templatesWithDetails);
      results.cannedJobsSynced = templatesWithDetails.length;
      
      const withLines = templatesWithDetails.filter((t: any) => t.ServicePackageLines?.ItemCollection?.length > 0);
      console.log(`[Protractor Sync] Synced ${results.cannedJobsSynced} templates (${withLines.length} with line details)`);
    } else {
      // API not available - discover from existing synced data
      console.log(`[Protractor Sync] API not available, discovering from cached data...`);
      const discovered = await discoverCannedJobsFromCache(shopId);
      if (discovered.length > 0) {
        await mergeCannedJobsToCache(shopId, discovered);
        results.cannedJobsSynced = discovered.length;
        console.log(`[Protractor Sync] Discovered ${discovered.length} service packages from cached data`);
      }
    }
  } catch (err: any) {
    console.log(`[Protractor Sync] Canned jobs exception: ${err.message}`);
    results.errors.push(`Canned jobs: ${err.message}`);
  }

  // Helper: discover canned jobs from cached deferred work and work orders
  async function discoverCannedJobsFromCache(shopId: number) {
    const discovered = new Map<string, { id: string; title: string; description: string; chapter: string; code: string }>();
    
    // Get from deferred work
    const deferredWork = await db.collection("protractor_deferred_work").find({ shopId }).toArray();
    console.log(`[Protractor Sync] Checking ${deferredWork.length} deferred work records for service packages...`);
    for (const dw of deferredWork) {
      const items = dw.items || dw.deferredWork || [];
      for (const item of items) {
        const code = item.Code || item.code || item.ServicePackageCode;
        const title = item.Title || item.title || item.Description || item.description;
        if (code && !discovered.has(code.toLowerCase())) {
          discovered.set(code.toLowerCase(), {
            id: code,
            title: title || code,
            description: item.Description || item.description || "",
            chapter: item.Chapter || item.chapter || "Service",
            code: code,
          });
        }
      }
    }
    
    // Get from work orders service packages
    const workOrders = await db.collection("protractor_work_orders").find({ shopId }).toArray();
    console.log(`[Protractor Sync] Checking ${workOrders.length} work orders for service packages...`);
    for (const wo of workOrders) {
      const packages = wo.servicePackages || wo.ServicePackages || [];
      const pkgArray = Array.isArray(packages) ? packages : (packages?.ItemCollection || []);
      for (const pkg of pkgArray) {
        const code = pkg.Code || pkg.code || pkg.ServicePackageTemplateCode;
        const title = pkg.ServicePackageHeader?.Title || pkg.Title || pkg.title || pkg.Description;
        const id = pkg.ID || pkg.id || pkg.ServicePackageTemplateID || code;
        if (code && !discovered.has(code.toLowerCase())) {
          discovered.set(code.toLowerCase(), {
            id: id || code,
            title: title || code,
            description: pkg.ServicePackageHeader?.Description || pkg.Description || pkg.description || "",
            chapter: pkg.Chapter || pkg.chapter || "Service",
            code: code,
          });
        }
      }
    }
    
    console.log(`[Protractor Sync] Discovered ${discovered.size} unique service packages from cached data`);
    return Array.from(discovered.values());
  }
  
  async function mergeCannedJobsToCache(shopId: number, discovered: any[]) {
    const existing = await db.collection("protractor_canned_jobs").findOne({ shopId });
    const existingItems = existing?.items || [];
    const existingCodes = new Set(existingItems.map((i: any) => (i.code || i.id)?.toLowerCase()));
    
    const newItems = discovered.filter(d => !existingCodes.has(d.code?.toLowerCase()));
    const merged = [...existingItems, ...newItems];
    
    await db.collection("protractor_canned_jobs").updateOne(
      { shopId },
      {
        $set: {
          shopId,
          items: merged,
          fetchedAt: new Date(),
          source: "discovered",
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
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
          
          // Build the active source entry for this work order
          const workOrderSource = {
            provider: "protractor",
            workOrderId: String(wo.ID),
            workOrderNumber: wo.WorkOrderNumber,
            status: wo.Status || "Open",
            addedAt: new Date(),
          };

          // Check if vehicle already exists
          const existingVehicle = await db.collection("vehicles").findOne({
            $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
            vin,
          });

          if (existingVehicle) {
            // Update existing vehicle, add/update this work order source
            const existingSources = existingVehicle.status?.sources || [];
            const sourceIndex = existingSources.findIndex(
              (s: any) => s.provider === "protractor" && String(s.workOrderId) === String(wo.ID)
            );
            
            let updatedSources;
            if (sourceIndex >= 0) {
              // Update existing source
              updatedSources = [...existingSources];
              updatedSources[sourceIndex] = workOrderSource;
            } else {
              // Add new source
              updatedSources = [...existingSources, workOrderSource];
            }

            await db.collection("vehicles").updateOne(
              { _id: existingVehicle._id },
              {
                $set: {
                  year: vehicle.Year,
                  make: vehicle.Make,
                  model: vehicle.Model,
                  license: vehicle.LicensePlate,
                  lastMileage: currentOdometer,
                  updatedAt: new Date(),
                  protractorId: vehicle.ID,
                  "status.active": true,
                  "status.sources": updatedSources,
                  "status.updatedAt": new Date(),
                },
              }
            );
          } else {
            // Insert new vehicle with active status
            await db.collection("vehicles").insertOne({
              shopId: String(shopId),
              vin,
              year: vehicle.Year,
              make: vehicle.Make,
              model: vehicle.Model,
              license: vehicle.LicensePlate,
              lastMileage: currentOdometer,
              protractorId: vehicle.ID,
              status: {
                active: true,
                sources: [workOrderSource],
                updatedAt: new Date(),
              },
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }

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

  // If we didn't get canned jobs from the API, try discovering from the just-synced data
  if (results.cannedJobsSynced === 0) {
    console.log(`[Protractor Sync] No canned jobs from API, attempting discovery from synced data...`);
    try {
      const discovered = await discoverCannedJobsFromCache(shopId);
      if (discovered.length > 0) {
        await mergeCannedJobsToCache(shopId, discovered);
        results.cannedJobsSynced = discovered.length;
        console.log(`[Protractor Sync] Discovered ${discovered.length} service packages from synced data`);
      }
    } catch (err: any) {
      console.log(`[Protractor Sync] Discovery exception: ${err.message}`);
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
