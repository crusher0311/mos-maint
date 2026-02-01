import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
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
import {
  extractJobIndexFromWorkOrder,
  upsertJobIndexEntries,
  updatePartCrossReferences,
} from "@/lib/job-index";
import { runProtractorBackfill } from "@/lib/integrations/protractor-backfill";
import pLimit from "p-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${String(shopId)}`;
  const shop = shopRows[0] as any;
  if (shop && !shop.protractor_backfill_complete) {
    const backfillRows = await sql`SELECT * FROM backfill_progress WHERE shop_id = ${String(shopId)}`;
    const backfillProgress = backfillRows[0] as any;
    if (!backfillProgress || !backfillProgress.completed) {
      console.log(`[Protractor Sync] Backfill not complete for shop ${shopId}, triggering in background`);
      runProtractorBackfill(shopId).then(result => {
        console.log(`[Protractor Sync] Backfill completed for shop ${shopId}:`, result);
      }).catch(err => {
        console.error(`[Protractor Sync] Backfill failed for shop ${shopId}:`, err.message);
      });
    }
  }

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
    jobsIndexed: 0,
    partsIndexed: 0,
    vehicleDetails: [] as Array<{ vin: string; year?: number; make?: string; model?: string; odometer?: number; woOdometer?: number }>,
    errors: [] as string[],
  };
  
  const allJobIndexEntries: any[] = [];

  console.log(`[Protractor Sync] Fetching service packages...`);
  try {
    const cannedJobsResult = await fetchCannedJobs(shopId);
    console.log(`[Protractor Sync] Canned jobs API result: ok=${cannedJobsResult.ok}, count=${cannedJobsResult.cannedJobs?.length || 0}`);
    
    if (cannedJobsResult.ok && cannedJobsResult.cannedJobs?.length) {
      const templateLimit = pLimit(5);
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
            return template;
          })
        )
      );
      
      await upsertCannedJobsCache(shopId, templatesWithDetails);
      results.cannedJobsSynced = templatesWithDetails.length;
      
      const withLines = templatesWithDetails.filter((t: any) => t.ServicePackageLines?.ItemCollection?.length > 0);
      console.log(`[Protractor Sync] Synced ${results.cannedJobsSynced} templates (${withLines.length} with line details)`);
    } else {
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

  async function discoverCannedJobsFromCache(shopId: number) {
    const discovered = new Map<string, { id: string; title: string; description: string; chapter: string; code: string }>();
    
    const deferredWork = await sql`SELECT * FROM protractor_deferred_work WHERE shop_id = ${String(shopId)}`;
    console.log(`[Protractor Sync] Checking ${deferredWork.length} deferred work records for service packages...`);
    for (const dw of deferredWork as any[]) {
      const items = dw.items || dw.deferred_work || [];
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
    
    const workOrders = await sql`SELECT * FROM protractor_work_orders WHERE shop_id = ${String(shopId)}`;
    console.log(`[Protractor Sync] Checking ${workOrders.length} work orders for service packages...`);
    for (const wo of workOrders as any[]) {
      const packages = wo.service_packages || wo.data?.ServicePackages || [];
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
    const existingRows = await sql`SELECT * FROM protractor_canned_jobs WHERE shop_id = ${String(shopId)}`;
    const existing = existingRows[0] as any;
    const existingItems = existing?.items || [];
    const existingCodes = new Set(existingItems.map((i: any) => (i.code || i.id)?.toLowerCase()));
    
    const newItems = discovered.filter(d => !existingCodes.has(d.code?.toLowerCase()));
    const merged = [...existingItems, ...newItems];
    
    await sql`
      INSERT INTO protractor_canned_jobs (shop_id, items, fetched_at, source, created_at, updated_at)
      VALUES (${String(shopId)}, ${JSON.stringify(merged)}::jsonb, NOW(), 'discovered', NOW(), NOW())
      ON CONFLICT (shop_id) DO UPDATE SET
        items = EXCLUDED.items,
        fetched_at = NOW(),
        source = EXCLUDED.source,
        updated_at = NOW()
    `;
  }

  const limit = pLimit(3);
  
  const detailedWorkOrders = await Promise.all(
    workOrdersFromList.map((wo) =>
      limit(async () => {
        const detailResult = await fetchWorkOrderById(shopId, wo.ID);
        if (detailResult.ok && detailResult.workOrder) {
          return detailResult.workOrder;
        }
        return wo;
      })
    )
  );

  for (const wo of detailedWorkOrders) {
    try {
      if (wo.ServiceItem) {
        const vehicle = wo.ServiceItem;
        const vin = vehicle.VIN?.toUpperCase();
        
        const currentOdometer = wo.InUsage ?? vehicle.Usage ?? wo.Odometer ?? vehicle.Odometer;
        
        if (vin) {
          await upsertProtractorVehicleSnapshot(shopId, vin, vehicle);
          
          const workOrderSource = {
            provider: "protractor",
            workOrderId: String(wo.ID),
            workOrderNumber: wo.WorkOrderNumber,
            status: wo.Status || "Open",
            addedAt: new Date().toISOString(),
          };

          const existingVehicleRows = await sql`
            SELECT * FROM vehicles WHERE shop_id = ${String(shopId)} AND vin = ${vin}
          `;
          const existingVehicle = existingVehicleRows[0] as any;

          if (existingVehicle) {
            const existingSources = existingVehicle.status?.sources || [];
            const sourceIndex = existingSources.findIndex(
              (s: any) => s.provider === "protractor" && String(s.workOrderId) === String(wo.ID)
            );
            
            let updatedSources;
            if (sourceIndex >= 0) {
              updatedSources = [...existingSources];
              updatedSources[sourceIndex] = workOrderSource;
            } else {
              updatedSources = [...existingSources, workOrderSource];
            }

            const statusData = {
              active: true,
              sources: updatedSources,
              updatedAt: new Date().toISOString(),
            };

            await sql`
              UPDATE vehicles SET
                year = COALESCE(${vehicle.Year}, year),
                make = COALESCE(${vehicle.Make}, make),
                model = COALESCE(${vehicle.Model}, model),
                license_plate = COALESCE(${vehicle.LicensePlate}, license_plate),
                last_mileage = COALESCE(${currentOdometer}, last_mileage),
                protractor_id = COALESCE(${vehicle.ID}, protractor_id),
                status = ${JSON.stringify(statusData)}::jsonb,
                updated_at = NOW()
              WHERE id = ${existingVehicle.id}
            `;
          } else {
            const statusData = {
              active: true,
              sources: [workOrderSource],
              updatedAt: new Date().toISOString(),
            };

            await sql`
              INSERT INTO vehicles (
                shop_id, vin, year, make, model, license_plate, last_mileage, protractor_id, status,
                created_at, updated_at
              ) VALUES (
                ${String(shopId)}, ${vin}, ${vehicle.Year}, ${vehicle.Make}, ${vehicle.Model},
                ${vehicle.LicensePlate}, ${currentOdometer}, ${vehicle.ID},
                ${JSON.stringify(statusData)}::jsonb, NOW(), NOW()
              )
            `;
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
      
      try {
        const jobEntries = extractJobIndexFromWorkOrder(shopId, wo, "protractor");
        if (jobEntries.length > 0) {
          allJobIndexEntries.push(...jobEntries);
        }
      } catch (indexErr: any) {
        console.log(`[Protractor Sync] Job index extraction error for WO ${wo.ID}: ${indexErr.message}`);
      }
    } catch (err: any) {
      results.errors.push(`Work order ${wo.ID}: ${err.message}`);
    }
  }
  
  if (allJobIndexEntries.length > 0) {
    try {
      console.log(`[Protractor Sync] Indexing ${allJobIndexEntries.length} jobs for parts intelligence...`);
      const indexResult = await upsertJobIndexEntries(allJobIndexEntries);
      results.jobsIndexed = indexResult.inserted + indexResult.updated;
      console.log(`[Protractor Sync] Job index: ${indexResult.inserted} inserted, ${indexResult.updated} updated`);
      
      const partsUpdated = await updatePartCrossReferences(allJobIndexEntries);
      results.partsIndexed = partsUpdated;
      console.log(`[Protractor Sync] Part cross-references: ${partsUpdated} parts updated`);
    } catch (indexErr: any) {
      console.log(`[Protractor Sync] Job indexing error: ${indexErr.message}`);
      results.errors.push(`Job indexing: ${indexErr.message}`);
    }
  }

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
  
  const [vehicleCountRows, workOrderCountRows, deferredWorkCountRows, cannedJobsRows, lastSyncRows] = await Promise.all([
    sql`SELECT COUNT(*) as count FROM protractor_vehicles WHERE shop_id = ${String(shopId)}`,
    sql`SELECT COUNT(*) as count FROM protractor_work_orders WHERE shop_id = ${String(shopId)}`,
    sql`SELECT COUNT(*) as count FROM protractor_deferred_work WHERE shop_id = ${String(shopId)}`,
    sql`SELECT * FROM protractor_canned_jobs WHERE shop_id = ${String(shopId)}`,
    sql`SELECT fetched_at FROM protractor_vehicles WHERE shop_id = ${String(shopId)} ORDER BY fetched_at DESC NULLS LAST LIMIT 1`,
  ]);

  const vehicleCount = parseInt((vehicleCountRows[0] as any)?.count || '0', 10);
  const workOrderCount = parseInt((workOrderCountRows[0] as any)?.count || '0', 10);
  const deferredWorkCount = parseInt((deferredWorkCountRows[0] as any)?.count || '0', 10);
  const cannedJobsCache = cannedJobsRows[0] as any;
  const cannedJobsCount = cannedJobsCache?.items?.length || 0;
  const lastSync = (lastSyncRows[0] as any)?.fetched_at || null;

  return NextResponse.json({
    ok: true,
    configured: true,
    stats: {
      vehicles: vehicleCount,
      workOrders: workOrderCount,
      deferredWorkItems: deferredWorkCount,
      cannedJobs: cannedJobsCount,
      lastSync,
    },
    cannedJobs: cannedJobsCache?.items || [],
  });
}
