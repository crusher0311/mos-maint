import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  protractorFetch,
  fetchInvoiceById,
  fetchVehicleById,
} from "@/lib/integrations/protractor";
import { extractJobIndexFromWorkOrder, updatePartCrossReferences, computeJobHash } from "@/lib/job-index";
import { createIngestionService } from "@/lib/normalized-ingestion";
import { getPaceConfig, midpoint, describePace } from "@/lib/integrations/backfill-pace";
import pLimit from "p-limit";

const YEARS_TO_BACKFILL = 5;
const MAX_WALL_CLOCK_MS = 1800000; // 30 minutes max

async function fetchInvoicesForDateRange(
  shopId: number,
  startDate: string,
  endDate: string,
  maxPages: number = 50
): Promise<{ invoices: any[]; hitPageCap: boolean; hadError: boolean }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) return { invoices: [], hitPageCap: false, hadError: false };

  const allInvoices: any[] = [];
  const pageSize = 100;
  let skip = 0;
  const seenIds = new Set<string>();
  let pageCount = 0;
  let hadError = false;
  let lastPageWasFull = false;

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
      hadError = true;
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

    lastPageWasFull = pageItems.length >= pageSize;
    if (newItems === 0 || pageItems.length === 0) break;
    if (!lastPageWasFull) break;

    skip += pageSize;
    pageCount++;
    await new Promise(r => setTimeout(r, 30));
  }

  const hitPageCap = pageCount >= maxPages && lastPageWasFull;
  return { invoices: allInvoices, hitPageCap, hadError };
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
  _rateLimiter: ReturnType<typeof pLimit>
): Promise<{ jobsIndexed: number; skipped: number; complete: boolean; message: string; vehiclesFetched: number; normalizedCount: number }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { jobsIndexed: 0, skipped: 0, complete: false, message: "Not configured", vehiclesFetched: 0, normalizedCount: 0 };
  }
  
  const shop = await db.collection("shops").findOne({ shopId });
  const enterpriseId = shop?.enterpriseId;
  const pace = getPaceConfig("protractor", shop?.timezone, new Date());
  const rateLimiter = pLimit(pace.concurrency);
  
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
    console.log(`[Backfill] Shop ${shopId}: Resuming from ${chunkEnd.toISOString().split('T')[0]} (logicVersion=${progress.logicVersion})`);
  } else {
    chunkEnd = new Date(today);
    console.log(`[Backfill] Shop ${shopId}: Starting fresh (logicVersion=${progress?.logicVersion || 'none'})`);
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

  let daysToProcess = pace.chunkDays;
  const lastCount = progress?.lastInvoiceCount;
  if (lastCount) {
    const dense = pace.isOffHours ? 3500 : 1500;
    const heavy = pace.isOffHours ? 1800 : 800;
    const medium = pace.isOffHours ? 900 : 400;
    const light = pace.isOffHours ? 300 : 150;
    if (lastCount > dense) {
      daysToProcess = Math.max(21, Math.floor(pace.chunkDays / 3));
    } else if (lastCount > heavy) {
      daysToProcess = Math.max(30, Math.floor(pace.chunkDays / 2));
    } else if (lastCount > medium) {
      daysToProcess = Math.max(45, Math.floor(pace.chunkDays * 0.75));
    } else if (lastCount < light) {
      daysToProcess = Math.min(180, Math.floor(pace.chunkDays * 1.5));
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
    await db.collection("shops").updateOne(
      { shopId },
      { $set: { protractorBackfillComplete: true, protractorBackfillCompletedAt: new Date() } }
    );
    return { jobsIndexed: 0, skipped: 0, complete: true, message: "Already complete", vehiclesFetched: 0, normalizedCount: 0 };
  }

  const startStr = chunkStart.toISOString().split("T")[0];
  const endStr = chunkEnd.toISOString().split("T")[0];

  console.log(`[Backfill] Shop ${shopId}: ${startStr} to ${endStr} (${daysToProcess} days)`);

  let jobsIndexed = 0;
  let skippedUnchanged = 0;
  let vehiclesFetched = 0;

  const fetchResult = await fetchInvoicesForDateRange(shopId, startStr, endStr, pace.maxPagesPerChunk);
  const invoices = fetchResult.invoices;
  let chunkHadError = fetchResult.hadError;
  const hitPageCap = fetchResult.hitPageCap;
  console.log(`[Backfill] Shop ${shopId}: ${invoices.length} invoices ${describePace(pace)} ${hitPageCap ? "[HIT PAGE CAP]" : ""}${chunkHadError ? " [HAD ERROR]" : ""}`);

  if (invoices.length === 0) {
    // Empty chunk: if it was empty due to error, hold cursor; else advance.
    const nextChunkEnd = chunkHadError ? chunkEnd : chunkStart;
    const isComplete = !chunkHadError && nextChunkEnd <= oldestDate;
    await db.collection("backfill_progress").updateOne(
      { shopId },
      {
        $set: {
          currentChunkEnd: nextChunkEnd,
          lastRunAt: new Date(),
          lastInvoiceCount: 0,
          completed: isComplete,
          ...(isComplete ? { completedAt: new Date() } : {}),
          ...(chunkHadError
            ? { lastError: "empty chunk after error", lastErrorAt: new Date() }
            : { lastError: null, lastErrorAt: null }),
        }
      }
    );
    if (isComplete) {
      await db.collection("shops").updateOne(
        { shopId },
        { $set: { protractorBackfillComplete: true, protractorBackfillCompletedAt: new Date() } }
      );
    }
    return { jobsIndexed: 0, skipped: 0, complete: isComplete, message: `${startStr} to ${endStr}: 0 invoices${chunkHadError ? " (HOLD)" : ""}`, vehiclesFetched: 0, normalizedCount: 0 };
  }

  const allJobEntries: any[] = [];
  const serviceItemIds = new Set<string>();
  const invoicesForNormalized: any[] = [];
  let invoiceDetailErrors = 0;

  await Promise.all(
    invoices.map((inv: any) =>
      rateLimiter(async () => {
        try {
          const detailResult = await fetchInvoiceById(shopId, inv.ID);
          if (!detailResult.ok || !detailResult.invoice) {
            invoiceDetailErrors++;
            return;
          }

          const fullInv = detailResult.invoice as any;
          invoicesForNormalized.push(fullInv);

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
          invoiceDetailErrors++;
        }
      })
    )
  );

  if (invoiceDetailErrors > 0) {
    chunkHadError = true;
    console.warn(`[Backfill] Shop ${shopId}: ${invoiceDetailErrors}/${invoices.length} invoice-detail fetches failed; will hold cursor`);
  }

  console.log(`[Backfill] Shop ${shopId}: ${allJobEntries.length} jobs, ${serviceItemIds.size} unique vehicles to fetch`);

  const vehicleCache = new Map<string, any>();
  const vehicleIdsToFetch = Array.from(serviceItemIds).filter(id => {
    const entry = allJobEntries.find(e => (e as any)._serviceItemId === id);
    return entry && (!entry.vehicle?.vin && !entry.vehicle?.year);
  });

  if (vehicleIdsToFetch.length > 0) {
    console.log(`[Backfill] Shop ${shopId}: Fetching ${vehicleIdsToFetch.length} vehicles in parallel...`);
    
    const vehicleResults = await Promise.all(
      vehicleIdsToFetch.map(serviceItemId => 
        rateLimiter(async () => {
          const vehicleData = await getOrFetchVehicle(db, shopId, serviceItemId, rateLimiter);
          return { serviceItemId, vehicleData };
        })
      )
    );
    
    for (const { serviceItemId, vehicleData } of vehicleResults) {
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

  const bulkOps: any[] = [];
  const existingJobsFilters = allJobEntries.map(entry => ({
    shopId: entry.shopId,
    workOrderId: entry.workOrderId,
    servicePackageId: entry.servicePackageId,
  }));
  
  const existingJobs = await db.collection("job_index").find({
    $or: existingJobsFilters.length > 0 ? existingJobsFilters : [{ _id: null }]
  }).toArray();
  
  const existingJobMap = new Map<string, string>();
  for (const job of existingJobs) {
    const key = `${job.shopId}:${job.workOrderId}:${job.servicePackageId}`;
    existingJobMap.set(key, job.contentHash);
  }
  
  for (const entry of allJobEntries) {
    const contentHash = computeJobHash(entry);
    const key = `${entry.shopId}:${entry.workOrderId}:${entry.servicePackageId}`;
    
    if (existingJobMap.get(key) === contentHash) {
      skippedUnchanged++;
      continue;
    }
    
    bulkOps.push({
      updateOne: {
        filter: { 
          shopId: entry.shopId, 
          workOrderId: entry.workOrderId, 
          servicePackageId: entry.servicePackageId 
        },
        update: { $set: { ...entry, contentHash, sourceSystem: "protractor" } },
        upsert: true
      }
    });
  }

  if (bulkOps.length > 0) {
    const bulkResult = await db.collection("job_index").bulkWrite(bulkOps, { ordered: false });
    jobsIndexed = bulkResult.upsertedCount + bulkResult.modifiedCount;
    console.log(`[Backfill] Shop ${shopId}: Bulk wrote ${jobsIndexed} jobs (${bulkResult.upsertedCount} new, ${bulkResult.modifiedCount} updated, ${skippedUnchanged} skipped)`);
  }

  let normalizedCount = 0;
  try {
    const normalizedResult = await ingestionService.ingestWorkOrderBatchWithAllEntities(invoicesForNormalized);
    normalizedCount = normalizedResult.workOrders.created + normalizedResult.workOrders.updated;
    console.log(`[Backfill] Shop ${shopId}: Normalized ${normalizedCount} WOs`);
  } catch (normalizedError) {
    console.error(`[Backfill] Shop ${shopId}: Normalized ingestion error:`, normalizedError);
  }

  let nextChunkEnd: Date;
  let advanceMode: string;
  if (chunkHadError) {
    nextChunkEnd = chunkEnd;
    advanceMode = "HOLD (error in chunk)";
  } else if (hitPageCap) {
    nextChunkEnd = midpoint(chunkStart, chunkEnd);
    advanceMode = `SPLIT (page cap hit, advancing only to ${nextChunkEnd.toISOString().split('T')[0]})`;
  } else {
    nextChunkEnd = chunkStart;
    advanceMode = "FULL";
  }
  const isComplete = !chunkHadError && !hitPageCap && nextChunkEnd <= oldestDate;

  console.log(`[Backfill] Shop ${shopId}: ${advanceMode} — currentChunkEnd ${chunkEnd.toISOString().split('T')[0]} -> ${nextChunkEnd.toISOString().split('T')[0]}`);

  await db.collection("backfill_progress").updateOne(
    { shopId },
    {
      $set: {
        currentChunkEnd: nextChunkEnd,
        lastRunAt: new Date(),
        lastInvoiceCount: invoices.length,
        completed: isComplete,
        ...(isComplete ? { completedAt: new Date() } : {}),
        ...(chunkHadError
          ? { lastError: "chunk had errors, holding cursor", lastErrorAt: new Date() }
          : { lastError: null, lastErrorAt: null }),
      },
      $inc: { totalJobsIndexed: jobsIndexed }
    }
  );

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

export async function runProtractorBackfill(shopId: number): Promise<{
  chunksProcessed: number;
  totalJobsIndexed: number;
  complete: boolean;
  error?: string;
}> {
  const startTime = Date.now();
  const db = await getDb();
  const rateLimiter = pLimit(5);
  
  let chunksProcessed = 0;
  let totalJobsIndexed = 0;
  let complete = false;

  // Atomic lock acquisition - prevent duplicate instances
  const lockResult = await db.collection("backfill_progress").findOneAndUpdate(
    { shopId, inProgress: { $ne: true } },  // Only claim if not already in progress
    { 
      $set: { 
        lastAttemptedAt: new Date(),
        lastActivityAt: new Date(),
        inProgress: true,
        lastError: null,
        lastErrorAt: null,
        retryCount: 0,
      } 
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (!lockResult) {
    // Another instance is already running for this shop
    console.log(`[Backfill] Shop ${shopId}: Skipping - another instance already in progress`);
    return { chunksProcessed: 0, totalJobsIndexed: 0, complete: false, error: 'Already in progress' };
  }

  console.log(`[Backfill] Starting inline backfill for shop ${shopId}`);

  const shopDoc = await db.collection("shops").findOne({ shopId });
  const shopTz = (shopDoc as any)?.timezone || "America/Chicago";
  const runPace = getPaceConfig("protractor", shopTz);
  const maxChunksPerRun = runPace.maxChunksPerRun;

  try {
    while (chunksProcessed < maxChunksPerRun) {
      if (Date.now() - startTime > MAX_WALL_CLOCK_MS) {
        console.log(`[Backfill] Shop ${shopId}: Wall clock limit reached after ${chunksProcessed} chunks`);
        break;
      }

      const result = await backfillShopChunk(db, shopId, rateLimiter);
      chunksProcessed++;
      totalJobsIndexed += result.jobsIndexed;

      console.log(`[Backfill] Shop ${shopId} chunk ${chunksProcessed}: ${result.message}`);
      
      await db.collection("backfill_progress").updateOne(
        { shopId },
        { $set: { lastActivityAt: new Date() } }
      );

      if (result.complete) {
        complete = true;
        break;
      }

      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[Backfill] Shop ${shopId}: Run finished - ${chunksProcessed} chunks, ${totalJobsIndexed} jobs indexed, complete: ${complete}`);
    
    await db.collection("backfill_progress").updateOne(
      { shopId },
      { $set: { inProgress: false, lastCompletedRunAt: new Date() } }
    );
    
    if (!complete) {
      console.log(`[Backfill] Shop ${shopId}: Not complete, starting next run immediately`);
      try {
        const nextResult = await runProtractorBackfill(shopId);
        console.log(`[Backfill] Shop ${shopId}: Next run result:`, nextResult.complete ? 'COMPLETE' : `${nextResult.chunksProcessed} more chunks`);
      } catch (err: any) {
        console.error(`[Backfill] Shop ${shopId}: Next run failed:`, err.message);
      }
    } else {
      console.log(`[Backfill] Shop ${shopId}: FULLY COMPLETE!`);
    }
    
    return { chunksProcessed, totalJobsIndexed, complete };
  } catch (err: any) {
    console.error(`[Backfill] Shop ${shopId}: Error during backfill:`, err.message);
    
    const progress = await db.collection("backfill_progress").findOne({ shopId });
    const retryCount = (progress?.retryCount || 0) + 1;
    const MAX_RETRIES = 5;
    
    await db.collection("backfill_progress").updateOne(
      { shopId },
      { 
        $set: { 
          inProgress: false, 
          lastError: err.message,
          lastErrorAt: new Date(),
          retryCount,
        } 
      }
    );
    
    if (retryCount <= MAX_RETRIES) {
      const backoffMs = Math.min(30000, 5000 * retryCount);
      console.log(`[Backfill] Shop ${shopId}: Auto-retry ${retryCount}/${MAX_RETRIES} in ${backoffMs/1000}s...`);
      setTimeout(() => {
        runProtractorBackfill(shopId).catch(retryErr => {
          console.error(`[Backfill] Shop ${shopId}: Retry failed:`, retryErr.message);
        });
      }, backoffMs);
    } else {
      console.error(`[Backfill] Shop ${shopId}: Max retries (${MAX_RETRIES}) exceeded, giving up`);
    }
    
    return { chunksProcessed, totalJobsIndexed, complete: false, error: err.message };
  }
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export async function findAndResumeStaleBackfills(): Promise<{
  resumed: number;
  shopIds: number[];
}> {
  const db = await getDb();
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  
  const [staleBackfills, protractorShops] = await Promise.all([
    db.collection("backfill_progress").find({
      completed: { $ne: true },
      $or: [
        { lastAttemptedAt: { $lt: staleThreshold } },
        { lastAttemptedAt: { $exists: false }, lastRunAt: { $lt: staleThreshold } },
        { inProgress: true, lastAttemptedAt: { $lt: staleThreshold } },
      ]
    }).toArray(),
    db.collection("shops").find({ "protractor.configured": true }).project({ shopId: 1 }).toArray()
  ]);
  
  const configuredShopIds = new Set(protractorShops.map((s: any) => s.shopId));
  const shopIds: number[] = [];
  
  for (const progress of staleBackfills) {
    if (!configuredShopIds.has(progress.shopId)) continue;
    
    console.log(`[Backfill] Resuming stale backfill for shop ${progress.shopId}`);
    shopIds.push(progress.shopId);
    
    runProtractorBackfill(progress.shopId).then(result => {
      console.log(`[Backfill] Shop ${progress.shopId} resumed backfill completed:`, result);
    }).catch(err => {
      console.error(`[Backfill] Shop ${progress.shopId} resumed backfill failed:`, err.message);
    });
  }
  
  if (shopIds.length > 0) {
    console.log(`[Backfill] Started ${shopIds.length} parallel backfills (each shop has isolated API rate limits)`);
  }
  
  return { resumed: shopIds.length, shopIds };
}
