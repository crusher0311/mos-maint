import sql from "@/lib/db/postgres";
import {
  resolveProtractorConfig,
  protractorFetch,
  fetchInvoiceById,
  fetchVehicleById,
} from "@/lib/integrations/protractor";
import { extractJobIndexFromWorkOrder, updatePartCrossReferences, computeJobHash } from "@/lib/job-index";
import pLimit from "p-limit";

const YEARS_TO_BACKFILL = 5;
const MAX_CHUNKS_PER_RUN = 100;
const MAX_WALL_CLOCK_MS = 1800000; // 30 minutes max

async function getShopUuid(shopId: number): Promise<string | null> {
  const rows = await sql`SELECT id FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1`;
  return rows[0]?.id as string | null;
}

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

async function getOrFetchVehicle(
  shopId: number,
  serviceItemId: string,
  rateLimiter: ReturnType<typeof pLimit>
): Promise<{ vin?: string; year?: number; make?: string; model?: string; engine?: string } | null> {
  if (!serviceItemId) return null;
  
  const cached = await sql`
    SELECT vin, year, make, model, engine
    FROM protractor_service_items
    WHERE shop_id = ${String(shopId)} AND service_item_id = ${serviceItemId}
    LIMIT 1
  `;
  
  if (cached.length > 0) {
    return {
      vin: cached[0].vin as string | undefined,
      year: cached[0].year as number | undefined,
      make: cached[0].make as string | undefined,
      model: cached[0].model as string | undefined,
      engine: cached[0].engine as string | undefined,
    };
  }
  
  const result = await rateLimiter(async () => {
    return fetchVehicleById(shopId, serviceItemId);
  });
  
  if (result.ok && result.vehicle) {
    const v = result.vehicle;
    const vehicleData = {
      vin: v.VIN || null,
      year: v.Year ? parseInt(String(v.Year)) : null,
      make: v.Make || null,
      model: v.Model || null,
      engine: v.Engine || null,
    };
    
    await sql`
      INSERT INTO protractor_service_items (shop_id, service_item_id, vin, year, make, model, engine, fetched_at)
      VALUES (${String(shopId)}, ${serviceItemId}, ${vehicleData.vin}, ${vehicleData.year}, ${vehicleData.make}, ${vehicleData.model}, ${vehicleData.engine}, NOW())
      ON CONFLICT (shop_id, service_item_id) DO UPDATE SET
        vin = EXCLUDED.vin, year = EXCLUDED.year, make = EXCLUDED.make, model = EXCLUDED.model, engine = EXCLUDED.engine, fetched_at = NOW()
    `;
    
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
  shopId: number,
  rateLimiter: ReturnType<typeof pLimit>
): Promise<{ jobsIndexed: number; skipped: number; complete: boolean; message: string; vehiclesFetched: number }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { jobsIndexed: 0, skipped: 0, complete: false, message: "Not configured", vehiclesFetched: 0 };
  }
  
  const shopUuid = await getShopUuid(shopId);
  if (!shopUuid) {
    return { jobsIndexed: 0, skipped: 0, complete: false, message: "Shop not found", vehiclesFetched: 0 };
  }
  
  const progressRows = await sql`
    SELECT current_chunk_end, logic_version, last_invoice_count
    FROM backfill_progress
    WHERE shop_id = ${String(shopId)}
    LIMIT 1
  `;
  const progress = progressRows[0];
  
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  
  const oldestDate = new Date();
  oldestDate.setFullYear(oldestDate.getFullYear() - YEARS_TO_BACKFILL);
  oldestDate.setHours(0, 0, 0, 0);
  
  let chunkEnd: Date;
  
  if (progress?.current_chunk_end && progress?.logic_version === 4) {
    chunkEnd = new Date(progress.current_chunk_end as string);
    console.log(`[Backfill] Shop ${shopId}: Resuming from ${chunkEnd.toISOString().split('T')[0]}`);
  } else {
    chunkEnd = new Date(today);
    console.log(`[Backfill] Shop ${shopId}: Starting fresh`);
    await sql`
      INSERT INTO backfill_progress (shop_id, started_at, current_chunk_end, completed, logic_version)
      VALUES (${String(shopId)}, NOW(), ${chunkEnd}, false, 4)
      ON CONFLICT (shop_id) DO UPDATE SET
        started_at = NOW(), current_chunk_end = EXCLUDED.current_chunk_end, completed = false, logic_version = 4
    `;
  }

  let daysToProcess = 60;
  const lastCount = progress?.last_invoice_count as number | null;
  if (lastCount) {
    if (lastCount > 1500) daysToProcess = 21;
    else if (lastCount > 800) daysToProcess = 30;
    else if (lastCount > 400) daysToProcess = 45;
    else if (lastCount < 150) daysToProcess = 120;
  }
  
  const chunkStart = new Date(chunkEnd);
  chunkStart.setDate(chunkStart.getDate() - daysToProcess);
  if (chunkStart < oldestDate) chunkStart.setTime(oldestDate.getTime());

  if (chunkEnd <= oldestDate) {
    await sql`
      UPDATE backfill_progress SET completed = true, completed_at = NOW() WHERE shop_id = ${String(shopId)}
    `;
    await sql`
      UPDATE shops SET protractor_backfill_complete = true, protractor_backfill_completed_at = NOW() WHERE shop_id = ${String(shopId)}
    `;
    return { jobsIndexed: 0, skipped: 0, complete: true, message: "Already complete", vehiclesFetched: 0 };
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
    await sql`
      UPDATE backfill_progress 
      SET current_chunk_end = ${nextChunkEnd}, last_run_at = NOW(), last_invoice_count = 0,
          completed = ${isComplete}, completed_at = ${isComplete ? new Date() : null}
      WHERE shop_id = ${String(shopId)}
    `;
    if (isComplete) {
      await sql`
        UPDATE shops SET protractor_backfill_complete = true, protractor_backfill_completed_at = NOW() WHERE shop_id = ${String(shopId)}
      `;
    }
    return { jobsIndexed: 0, skipped: 0, complete: isComplete, message: `${startStr} to ${endStr}: 0 invoices`, vehiclesFetched: 0 };
  }

  const allJobEntries: any[] = [];
  const serviceItemIds = new Set<string>();

  await Promise.all(
    invoices.map((inv: any) =>
      rateLimiter(async () => {
        try {
          const detailResult = await fetchInvoiceById(shopId, inv.ID);
          if (!detailResult.ok || !detailResult.invoice) return;

          const fullInv = detailResult.invoice as any;

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
        } catch (err) {}
      })
    )
  );

  console.log(`[Backfill] Shop ${shopId}: ${allJobEntries.length} jobs, ${serviceItemIds.size} unique vehicles`);

  const vehicleCache = new Map<string, any>();
  const vehicleIdsToFetch = Array.from(serviceItemIds).filter(id => {
    const entry = allJobEntries.find(e => (e as any)._serviceItemId === id);
    return entry && (!entry.vehicle?.vin && !entry.vehicle?.year);
  });

  if (vehicleIdsToFetch.length > 0) {
    console.log(`[Backfill] Shop ${shopId}: Fetching ${vehicleIdsToFetch.length} vehicles...`);
    
    const vehicleResults = await Promise.all(
      vehicleIdsToFetch.map(serviceItemId => 
        rateLimiter(async () => {
          const vehicleData = await getOrFetchVehicle(shopId, serviceItemId, rateLimiter);
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
      entry.vehicle = { ...entry.vehicle, ...vehicleData, serviceItemId };
    }
    delete (entry as any)._serviceItemId;
  }

  const existingJobs = await sql`
    SELECT shop_id, work_order_id, job_label, content_hash
    FROM job_index
    WHERE shop_id = ${String(shopId)}
  `;
  
  const existingJobMap = new Map<string, string>();
  for (const job of existingJobs) {
    const key = `${job.shop_id}:${job.work_order_id}:${job.job_label}`;
    existingJobMap.set(key, job.content_hash as string);
  }
  
  for (const entry of allJobEntries) {
    const contentHash = computeJobHash(entry);
    const key = `${entry.shopId}:${entry.workOrderId}:${entry.servicePackageId}`;
    
    if (existingJobMap.get(key) === contentHash) {
      skippedUnchanged++;
      continue;
    }
    
    await sql`
      INSERT INTO job_index (shop_id, work_order_id, job_label, vehicle, total, labor_hours, completed_at, content_hash, source_system, created_at, updated_at)
      VALUES (${String(entry.shopId)}, ${entry.workOrderId}, ${entry.servicePackageId || entry.jobLabel}, ${entry.vehicle as any}::jsonb, ${entry.total || 0}, ${entry.laborHours || 0}, ${entry.completedAt}, ${contentHash}, 'protractor', NOW(), NOW())
      ON CONFLICT (shop_id, work_order_id, job_label) DO UPDATE SET
        vehicle = EXCLUDED.vehicle, total = EXCLUDED.total, labor_hours = EXCLUDED.labor_hours, completed_at = EXCLUDED.completed_at, content_hash = EXCLUDED.content_hash, updated_at = NOW()
    `;
    jobsIndexed++;
  }

  console.log(`[Backfill] Shop ${shopId}: Indexed ${jobsIndexed} jobs (${skippedUnchanged} skipped)`);

  const nextChunkEnd = chunkStart;
  const isComplete = nextChunkEnd <= oldestDate;

  await sql`
    UPDATE backfill_progress 
    SET current_chunk_end = ${nextChunkEnd}, last_run_at = NOW(), last_invoice_count = ${invoices.length},
        completed = ${isComplete}, completed_at = ${isComplete ? new Date() : null},
        total_jobs_indexed = COALESCE(total_jobs_indexed, 0) + ${jobsIndexed}
    WHERE shop_id = ${String(shopId)}
  `;

  if (isComplete) {
    await sql`
      UPDATE shops SET protractor_backfill_complete = true, protractor_backfill_completed_at = NOW() WHERE shop_id = ${String(shopId)}
    `;
    console.log(`[Backfill] Shop ${shopId}: Marked complete`);
  }
  
  return {
    jobsIndexed,
    skipped: skippedUnchanged,
    complete: isComplete,
    message: `${startStr} to ${endStr}: ${jobsIndexed} jobs, ${vehiclesFetched} vehicles, ${daysToProcess}d chunk`,
    vehiclesFetched
  };
}

export async function runProtractorBackfill(shopId: number): Promise<{
  chunksProcessed: number;
  totalJobsIndexed: number;
  complete: boolean;
  error?: string;
}> {
  const startTime = Date.now();
  const rateLimiter = pLimit(5);
  
  let chunksProcessed = 0;
  let totalJobsIndexed = 0;
  let complete = false;

  const lockRows = await sql`
    UPDATE backfill_progress 
    SET last_attempted_at = NOW(), last_activity_at = NOW(), in_progress = true, last_error = NULL, retry_count = 0
    WHERE shop_id = ${String(shopId)} AND (in_progress IS NULL OR in_progress = false)
    RETURNING shop_id
  `;

  if (lockRows.length === 0) {
    console.log(`[Backfill] Shop ${shopId}: Skipping - already in progress`);
    return { chunksProcessed: 0, totalJobsIndexed: 0, complete: false, error: 'Already in progress' };
  }

  console.log(`[Backfill] Starting backfill for shop ${shopId}`);

  try {
    while (chunksProcessed < MAX_CHUNKS_PER_RUN) {
      if (Date.now() - startTime > MAX_WALL_CLOCK_MS) {
        console.log(`[Backfill] Shop ${shopId}: Wall clock limit reached`);
        break;
      }

      const result = await backfillShopChunk(shopId, rateLimiter);
      chunksProcessed++;
      totalJobsIndexed += result.jobsIndexed;

      console.log(`[Backfill] Shop ${shopId} chunk ${chunksProcessed}: ${result.message}`);
      
      await sql`UPDATE backfill_progress SET last_activity_at = NOW() WHERE shop_id = ${String(shopId)}`;

      if (result.complete) {
        complete = true;
        break;
      }

      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[Backfill] Shop ${shopId}: Finished - ${chunksProcessed} chunks, ${totalJobsIndexed} jobs, complete: ${complete}`);
    
    await sql`UPDATE backfill_progress SET in_progress = false, last_completed_run_at = NOW() WHERE shop_id = ${String(shopId)}`;
    
    return { chunksProcessed, totalJobsIndexed, complete };
  } catch (err: any) {
    console.error(`[Backfill] Shop ${shopId}: Error:`, err.message);
    
    await sql`
      UPDATE backfill_progress 
      SET in_progress = false, last_error = ${err.message}, last_error_at = NOW(), retry_count = COALESCE(retry_count, 0) + 1
      WHERE shop_id = ${String(shopId)}
    `;
    
    return { chunksProcessed, totalJobsIndexed, complete: false, error: err.message };
  }
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000;

export async function findAndResumeStaleBackfills(): Promise<{
  resumed: number;
  shopIds: number[];
}> {
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  
  const staleBackfills = await sql`
    SELECT bp.shop_id
    FROM backfill_progress bp
    JOIN shops s ON bp.shop_id = s.shop_id
    WHERE bp.completed IS NOT TRUE
      AND s.protractor_connection_id IS NOT NULL
      AND (
        bp.last_attempted_at < ${staleThreshold}
        OR (bp.last_attempted_at IS NULL AND bp.last_run_at < ${staleThreshold})
        OR (bp.in_progress = true AND bp.last_attempted_at < ${staleThreshold})
      )
  `;
  
  const shopIds: number[] = [];
  
  for (const progress of staleBackfills) {
    const shopId = parseInt(progress.shop_id as string, 10);
    console.log(`[Backfill] Resuming stale backfill for shop ${shopId}`);
    shopIds.push(shopId);
    
    runProtractorBackfill(shopId).then(result => {
      console.log(`[Backfill] Shop ${shopId} resumed:`, result);
    }).catch(err => {
      console.error(`[Backfill] Shop ${shopId} failed:`, err.message);
    });
  }
  
  if (shopIds.length > 0) {
    console.log(`[Backfill] Started ${shopIds.length} parallel backfills`);
  }
  
  return { resumed: shopIds.length, shopIds };
}
