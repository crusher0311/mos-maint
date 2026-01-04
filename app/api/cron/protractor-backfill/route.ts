import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  protractorFetch,
  fetchInvoiceById,
  fetchVehicleById,
} from "@/lib/integrations/protractor";
import { extractJobIndexFromWorkOrder, updatePartCrossReferences, computeJobHash } from "@/lib/job-index";
import { createIngestionService } from "@/lib/normalized-ingestion";
import pLimit from "p-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes max

const CRON_SECRET = process.env.CRON_SECRET;
const MAX_SHOPS_PER_RUN = 1; // Process one shop per run, but with smaller chunks
const YEARS_TO_BACKFILL = 5;
const MAX_WALL_CLOCK_MS = 240000; // 4 minutes max per invocation

async function fetchInvoicesForDateRange(
  shopId: number,
  startDate: string,
  endDate: string
): Promise<any[]> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) return [];

  const allInvoices: any[] = [];
  const pageSize = 100;
  let skip = 0;
  const seenIds = new Set<string>();
  const maxPages = 50;
  let pageCount = 0;

  while (pageCount < maxPages) {
    const params = new URLSearchParams();
    params.set("startDate", startDate);
    params.set("endDate", endDate);
    params.set("take", String(pageSize));
    params.set("skip", String(skip));

    const result = await protractorFetch<{ ItemCollection?: any[] }>(
      `/Invoice/?${params.toString()}`,
      config
    );

    if (!result.ok) {
      console.error(`[Backfill] Shop ${shopId} Invoice error at skip=${skip}:`, result.error);
      break;
    }

    const pageItems = result.data?.ItemCollection || [];
    let newItems = 0;

    for (const item of pageItems) {
      if (item.ID && !seenIds.has(item.ID)) {
        seenIds.add(item.ID);
        allInvoices.push(item);
        newItems++;
      }
    }

    if (newItems === 0 || pageItems.length === 0) break;
    if (pageItems.length < pageSize) break;

    skip += pageSize;
    pageCount++;
    await new Promise(r => setTimeout(r, 30));
  }

  return allInvoices;
}

async function getShopsNeedingBackfill(db: any): Promise<{ shopId: number; name: string }[]> {
  // Only fetch shops that don't have the completion flag set
  const shops = await db.collection("shops").find({
    $or: [
      { "protractor.apiKey": { $exists: true, $nin: [null, ""] } },
      { "protractorApiKey": { $exists: true, $nin: [null, ""] } },
      { "protractor.connectionId": { $exists: true, $nin: [null, ""] } },
      { "protractorConnectionId": { $exists: true, $nin: [null, ""] } }
    ],
    protractorBackfillComplete: { $ne: true }
  }).toArray();

  const shopsToBackfill: { shopId: number; name: string; progressDate: Date | null }[] = [];

  for (const shop of shops) {
    const shopId = Number(shop.shopId);
    const progress = await db.collection("backfill_progress").findOne({ shopId });
    
    const needsReprocess = !progress?.completed || progress?.logicVersion !== 4;
    
    if (needsReprocess) {
      shopsToBackfill.push({
        shopId,
        name: shop.name || shop.locationIdentifier || `Shop ${shopId}`,
        progressDate: progress?.currentChunkEnd ? new Date(progress.currentChunkEnd) : null
      });
    }
  }

  shopsToBackfill.sort((a, b) => {
    if (!a.progressDate && !b.progressDate) return 0;
    if (!a.progressDate) return -1;
    if (!b.progressDate) return 1;
    return b.progressDate.getTime() - a.progressDate.getTime();
  });

  return shopsToBackfill.map(s => ({ shopId: s.shopId, name: s.name }));
}

async function getOrFetchVehicle(
  db: any,
  shopId: number,
  serviceItemId: string,
  rateLimiter: ReturnType<typeof pLimit>
): Promise<{ vin?: string; year?: number; make?: string; model?: string; engine?: string } | null> {
  if (!serviceItemId) return null;
  
  const cached = await db.collection("protractor_service_items").findOne({ 
    shopId, 
    serviceItemId 
  });
  
  if (cached) {
    return {
      vin: cached.vin,
      year: cached.year,
      make: cached.make,
      model: cached.model,
      engine: cached.engine,
    };
  }
  
  const result = await rateLimiter(async () => {
    return fetchVehicleById(shopId, serviceItemId);
  });
  
  if (result.ok && result.vehicle) {
    const v = result.vehicle;
    const vehicleData = {
      shopId,
      serviceItemId,
      vin: v.VIN || null,
      year: v.Year ? parseInt(String(v.Year)) : null,
      make: v.Make || null,
      model: v.Model || null,
      engine: v.Engine || null,
      fetchedAt: new Date(),
    };
    
    await db.collection("protractor_service_items").updateOne(
      { shopId, serviceItemId },
      { $set: vehicleData },
      { upsert: true }
    );
    
    return {
      vin: vehicleData.vin || undefined,
      year: vehicleData.year || undefined,
      make: vehicleData.make || undefined,
      model: vehicleData.model || undefined,
      engine: vehicleData.engine || undefined,
    };
  }
  
  return null;
}

async function backfillShopChunk(
  db: any, 
  shopId: number,
  rateLimiter: ReturnType<typeof pLimit>
): Promise<{ jobsIndexed: number; skipped: number; complete: boolean; message: string; vehiclesFetched: number; normalizedCount: number }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { jobsIndexed: 0, skipped: 0, complete: false, message: "Not configured", vehiclesFetched: 0, normalizedCount: 0 };
  }
  
  const shop = await db.collection("shops").findOne({ shopId });
  const enterpriseId = shop?.enterpriseId;
  
  const ingestionService = createIngestionService(
    db,
    'protractor',
    shopId,
    enterpriseId,
    { 
      syncRunId: `backfill-${Date.now()}`,
      createAuditLog: false,
      dualWriteToJobIndex: false,
      dualWriteToRepairPatterns: true,
    }
  );

  let progress = await db.collection("backfill_progress").findOne({ shopId });
  
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  
  const oldestDate = new Date();
  oldestDate.setFullYear(oldestDate.getFullYear() - YEARS_TO_BACKFILL);
  oldestDate.setHours(0, 0, 0, 0);
  
  let chunkEnd: Date;
  
  if (progress?.currentChunkEnd && progress?.logicVersion === 4) {
    chunkEnd = new Date(progress.currentChunkEnd);
  } else {
    chunkEnd = new Date(today);
    await db.collection("backfill_progress").updateOne(
      { shopId },
      { 
        $set: { 
          shopId, 
          startedAt: new Date(), 
          currentChunkEnd: chunkEnd, 
          completed: false,
          logicVersion: 4
        },
        $unset: { currentChunkStart: "" }
      },
      { upsert: true }
    );
  }

  // Adaptive chunk sizing based on last invoice count
  // If too many invoices, shrink the window; if few, expand it
  let daysToProcess = 45; // default (increased for faster backfill)
  const lastCount = progress?.lastInvoiceCount;
  if (lastCount) {
    if (lastCount > 1000) {
      daysToProcess = 14; // Very busy shop
    } else if (lastCount > 600) {
      daysToProcess = 21; // Busy shop
    } else if (lastCount > 300) {
      daysToProcess = 30; // Moderate shop
    } else if (lastCount < 100) {
      daysToProcess = 90; // Quiet shop - go much faster
    }
  }
  
  const chunkStart = new Date(chunkEnd);
  chunkStart.setDate(chunkStart.getDate() - daysToProcess);
  if (chunkStart < oldestDate) {
    chunkStart.setTime(oldestDate.getTime());
  }

  if (chunkEnd <= oldestDate) {
    await db.collection("backfill_progress").updateOne(
      { shopId },
      { $set: { completed: true, completedAt: new Date() } }
    );
    return { jobsIndexed: 0, skipped: 0, complete: true, message: "Already complete", vehiclesFetched: 0, normalizedCount: 0 };
  }

  const startStr = chunkStart.toISOString().split("T")[0];
  const endStr = chunkEnd.toISOString().split("T")[0];

  console.log(`[Backfill] Shop ${shopId}: ${startStr} to ${endStr} (${daysToProcess} days)`);

  let jobsIndexed = 0;
  let skippedUnchanged = 0;
  let vehiclesFetched = 0;

  const invoices = await fetchInvoicesForDateRange(shopId, startStr, endStr);
  console.log(`[Backfill] Shop ${shopId}: ${invoices.length} invoices`);

  if (invoices.length === 0) {
    const nextChunkEnd = chunkStart;
    const isComplete = nextChunkEnd <= oldestDate;
    await db.collection("backfill_progress").updateOne(
      { shopId },
      {
        $set: {
          currentChunkEnd: nextChunkEnd,
          lastRunAt: new Date(),
          lastInvoiceCount: 0,
          completed: isComplete,
          ...(isComplete ? { completedAt: new Date() } : {}),
        }
      }
    );
    return { jobsIndexed: 0, skipped: 0, complete: isComplete, message: `${startStr} to ${endStr}: 0 invoices`, vehiclesFetched: 0, normalizedCount: 0 };
  }

  let loggedSample = false;
  const allJobEntries: any[] = [];
  const serviceItemIds = new Set<string>();
  const invoicesForNormalized: any[] = [];

  // Process all invoices - rely on adaptive chunk sizing to keep counts manageable
  await Promise.all(
    invoices.map((inv: any) =>
      rateLimiter(async () => {
        try {
          const detailResult = await fetchInvoiceById(shopId, inv.ID);
          if (!detailResult.ok || !detailResult.invoice) return;

          const fullInv = detailResult.invoice as any;
          invoicesForNormalized.push(fullInv);
          
          if (!loggedSample) {
            const sp = fullInv.ServicePackages;
            const spCount = sp?.ItemCollection?.length || (Array.isArray(sp) ? sp.length : 0);
            console.log(`[Backfill] Shop ${shopId} sample invoice:`, {
              hasServiceItem: !!fullInv.ServiceItem,
              hasServiceItemID: !!fullInv.ServiceItemID,
              servicePackagesCount: spCount,
            });
            loggedSample = true;
          }

          if (fullInv.ServiceItemID) {
            serviceItemIds.add(fullInv.ServiceItemID);
          }

          const jobEntries = extractJobIndexFromWorkOrder(shopId, fullInv, "protractor");
          if (jobEntries.length > 0) {
            for (const entry of jobEntries) {
              (entry as any)._serviceItemId = fullInv.ServiceItemID;
            }
            allJobEntries.push(...jobEntries);
          }
        } catch (err) {
        }
      })
    )
  );

  console.log(`[Backfill] Shop ${shopId}: ${allJobEntries.length} jobs, ${serviceItemIds.size} unique vehicles to fetch`);

  const vehicleCache = new Map<string, any>();
  const vehicleIdsToFetch = Array.from(serviceItemIds).filter(id => {
    const entry = allJobEntries.find(e => (e as any)._serviceItemId === id);
    return entry && (!entry.vehicle?.vin && !entry.vehicle?.year);
  });

  if (vehicleIdsToFetch.length > 0) {
    console.log(`[Backfill] Shop ${shopId}: Fetching ${vehicleIdsToFetch.length} vehicles...`);
    
    for (const serviceItemId of vehicleIdsToFetch) {
      const vehicleData = await getOrFetchVehicle(db, shopId, serviceItemId, rateLimiter);
      if (vehicleData) {
        vehicleCache.set(serviceItemId, vehicleData);
        vehiclesFetched++;
      }
    }
  }

  for (const entry of allJobEntries) {
    const serviceItemId = (entry as any)._serviceItemId;
    if (serviceItemId && vehicleCache.has(serviceItemId)) {
      const vehicleData = vehicleCache.get(serviceItemId);
      entry.vehicle = {
        ...entry.vehicle,
        ...vehicleData,
        serviceItemId,
      };
    }
    delete (entry as any)._serviceItemId;
  }

  for (const entry of allJobEntries) {
    const contentHash = computeJobHash(entry);
    const filter = { 
      shopId: entry.shopId, 
      workOrderId: entry.workOrderId, 
      servicePackageId: entry.servicePackageId 
    };
    
    const existing = await db.collection("job_index").findOne(filter);
    
    if (existing && existing.contentHash === contentHash) {
      skippedUnchanged++;
      continue;
    }
    
    await db.collection("job_index").updateOne(
      filter,
      { $set: { ...entry, contentHash, sourceSystem: "protractor" } },
      { upsert: true }
    );
    jobsIndexed++;
  }

  if (jobsIndexed > 0) {
    await updatePartCrossReferences(allJobEntries);
  }

  // Dual-write to normalized collections (fire and forget for performance)
  let normalizedCount = 0;
  try {
    const normalizedResult = await ingestionService.ingestWorkOrderBatchWithAllEntities(invoicesForNormalized);
    normalizedCount = normalizedResult.workOrders.created + normalizedResult.workOrders.updated;
    console.log(`[Backfill] Shop ${shopId}: Normalized ${normalizedCount} WOs (${normalizedResult.workOrders.created} new), payments: ${normalizedResult.payments.created}, inspections: ${normalizedResult.inspections.created}, recs: ${normalizedResult.recommendations.created}`);
  } catch (normalizedError) {
    console.error(`[Backfill] Shop ${shopId}: Normalized ingestion error:`, normalizedError);
  }

  // Always advance the chunk after processing
  const nextChunkEnd = chunkStart;
  const isComplete = nextChunkEnd <= oldestDate;

  await db.collection("backfill_progress").updateOne(
    { shopId },
    {
      $set: {
        currentChunkEnd: nextChunkEnd,
        lastRunAt: new Date(),
        lastInvoiceCount: invoices.length,
        completed: isComplete,
        ...(isComplete ? { completedAt: new Date() } : {}),
      },
      $inc: { totalJobsIndexed: jobsIndexed }
    }
  );

  // Set shop-level completion flag when backfill is done
  if (isComplete) {
    await db.collection("shops").updateOne(
      { shopId },
      { $set: { protractorBackfillComplete: true, protractorBackfillCompletedAt: new Date() } }
    );
    console.log(`[Backfill] Shop ${shopId}: Marked protractorBackfillComplete=true`);
  }
  
  return {
    jobsIndexed,
    skipped: skippedUnchanged,
    complete: isComplete,
    message: `${startStr} to ${endStr}: ${jobsIndexed} jobs, ${vehiclesFetched} vehicles fetched, ${normalizedCount} normalized, ${daysToProcess}d chunk`,
    vehiclesFetched,
    normalizedCount
  };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const startTime = Date.now();
  const rateLimiter = pLimit(5);

  try {
    const shopsToProcess = await getShopsNeedingBackfill(db);

    if (shopsToProcess.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "All Protractor shops have completed backfill",
        shopsRemaining: 0,
        duration: `${Date.now() - startTime}ms`
      });
    }

    const selectedShops = shopsToProcess.slice(0, MAX_SHOPS_PER_RUN);
    const results: any[] = [];

    for (const shop of selectedShops) {
      if (Date.now() - startTime > MAX_WALL_CLOCK_MS) {
        console.log(`[Backfill] Wall clock limit reached after ${results.length} shops`);
        break;
      }

      try {
        const result = await backfillShopChunk(db, shop.shopId, rateLimiter);
        results.push({
          shopId: shop.shopId,
          name: shop.name,
          ...result
        });
      } catch (err: any) {
        console.error(`[Backfill] Error for shop ${shop.shopId}:`, err);
        results.push({
          shopId: shop.shopId,
          name: shop.name,
          jobsIndexed: 0,
          skipped: 0,
          complete: false,
          message: `Error: ${err.message}`,
          vehiclesFetched: 0
        });
      }
    }

    console.log(`[Backfill] Completed in ${Date.now() - startTime}ms:`, results);

    return NextResponse.json({
      ok: true,
      duration: `${Date.now() - startTime}ms`,
      results,
      shopsRemaining: shopsToProcess.length - selectedShops.length
    });
  } catch (error: any) {
    console.error("[Backfill] Fatal error:", error);
    return NextResponse.json({
      ok: false,
      error: error.message,
      duration: `${Date.now() - startTime}ms`
    }, { status: 500 });
  }
}
