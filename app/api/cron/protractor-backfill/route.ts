import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  protractorFetch,
  fetchInvoiceById,
} from "@/lib/integrations/protractor";
import { extractJobIndexFromWorkOrder, updatePartCrossReferences, computeJobHash } from "@/lib/job-index";
import pLimit from "p-limit";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes max

const CRON_SECRET = process.env.CRON_SECRET;
const MONTHS_PER_RUN = 1; // Process 1 month at a time
const MAX_SHOPS_PER_RUN = 1; // Process one shop at a time
const YEARS_TO_BACKFILL = 5;

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
  const shops = await db.collection("shops").find({
    $or: [
      { "protractor.apiKey": { $exists: true, $nin: [null, ""] } },
      { "protractorApiKey": { $exists: true, $nin: [null, ""] } },
      { "protractor.connectionId": { $exists: true, $nin: [null, ""] } },
      { "protractorConnectionId": { $exists: true, $nin: [null, ""] } }
    ]
  }).toArray();

  const shopsToBackfill: { shopId: number; name: string; progressDate: Date | null }[] = [];

  for (const shop of shops) {
    const shopId = Number(shop.shopId);
    const progress = await db.collection("backfill_progress").findOne({ shopId });
    
    // Include shops that are not completed OR have outdated logic version
    const needsReprocess = !progress?.completed || progress?.logicVersion !== 3;
    
    if (needsReprocess) {
      shopsToBackfill.push({
        shopId,
        name: shop.name || shop.locationIdentifier || `Shop ${shopId}`,
        // For reverse chronological, prioritize by most recent cursor (null = needs fresh start)
        progressDate: progress?.currentChunkEnd ? new Date(progress.currentChunkEnd) : null
      });
    }
  }

  // Prioritize: shops with no progress first, then by most recent cursor (newest data first)
  shopsToBackfill.sort((a, b) => {
    if (!a.progressDate && !b.progressDate) return 0;
    if (!a.progressDate) return -1; // No progress = priority
    if (!b.progressDate) return 1;
    // Higher date = more recent = priority
    return b.progressDate.getTime() - a.progressDate.getTime();
  });

  return shopsToBackfill.map(s => ({ shopId: s.shopId, name: s.name }));
}

async function backfillShopChunk(db: any, shopId: number): Promise<{ jobsIndexed: number; skipped: number; complete: boolean; message: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { jobsIndexed: 0, skipped: 0, complete: false, message: "Not configured" };
  }

  let progress = await db.collection("backfill_progress").findOne({ shopId });
  
  // Calculate date boundaries
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  
  const oldestDate = new Date();
  oldestDate.setFullYear(oldestDate.getFullYear() - YEARS_TO_BACKFILL);
  oldestDate.setHours(0, 0, 0, 0);
  
  // REVERSE CHRONOLOGICAL: Start from today, work backwards
  let chunkEnd: Date;
  
  if (progress?.currentChunkEnd && progress?.logicVersion === 3) {
    // Continue from where we left off
    chunkEnd = new Date(progress.currentChunkEnd);
  } else {
    // Fresh start or upgrading from old logic - begin from today
    chunkEnd = new Date(today);
    await db.collection("backfill_progress").updateOne(
      { shopId },
      { 
        $set: { 
          shopId, 
          startedAt: new Date(), 
          currentChunkEnd: chunkEnd, 
          completed: false,
          logicVersion: 3 // v3: Fixed Protractor PriceSummary extraction
        },
        $unset: { currentChunkStart: "" } // Remove old field
      },
      { upsert: true }
    );
  }

  // Calculate chunk start (going backwards)
  const chunkStart = new Date(chunkEnd);
  chunkStart.setMonth(chunkStart.getMonth() - MONTHS_PER_RUN);
  if (chunkStart < oldestDate) {
    chunkStart.setTime(oldestDate.getTime());
  }

  // Check if we've reached the oldest date
  if (chunkEnd <= oldestDate) {
    await db.collection("backfill_progress").updateOne(
      { shopId },
      { $set: { completed: true, completedAt: new Date() } }
    );
    return { jobsIndexed: 0, skipped: 0, complete: true, message: "Already complete" };
  }

  const startStr = chunkStart.toISOString().split("T")[0];
  const endStr = chunkEnd.toISOString().split("T")[0];

  console.log(`[Backfill] Shop ${shopId}: ${startStr} to ${endStr} (reverse chronological)`);

  let jobsIndexed = 0;
  let skippedUnchanged = 0;

  const invoices = await fetchInvoicesForDateRange(shopId, startStr, endStr);
  console.log(`[Backfill] Shop ${shopId}: ${invoices.length} invoices`);

  if (invoices.length === 0) {
    // Move cursor backwards for next run
    const nextChunkEnd = chunkStart;
    const isComplete = nextChunkEnd <= oldestDate;
    await db.collection("backfill_progress").updateOne(
      { shopId },
      {
        $set: {
          currentChunkEnd: nextChunkEnd,
          lastRunAt: new Date(),
          completed: isComplete,
          ...(isComplete ? { completedAt: new Date() } : {}),
        }
      }
    );
    return { jobsIndexed: 0, skipped: 0, complete: isComplete, message: `${startStr} to ${endStr}: 0 invoices` };
  }

  const limit = pLimit(5); // Match Protractor's 5 req/sec rate limit
  let loggedSample = false;
  const allJobEntries: any[] = [];

  await Promise.all(
    invoices.map((inv: any) =>
      limit(async () => {
        try {
          const detailResult = await fetchInvoiceById(shopId, inv.ID);
          if (!detailResult.ok || !detailResult.invoice) return;

          const fullInv = detailResult.invoice as any;
          
          if (!loggedSample) {
            const sp = fullInv.ServicePackages;
            const spCount = sp?.ItemCollection?.length || (Array.isArray(sp) ? sp.length : 0);
            console.log(`[Backfill] Shop ${shopId} sample invoice structure:`, {
              hasServiceItem: !!fullInv.ServiceItem,
              servicePackagesCount: spCount,
            });
            loggedSample = true;
          }

          const jobEntries = extractJobIndexFromWorkOrder(shopId, fullInv, "protractor");
          if (jobEntries.length > 0) {
            allJobEntries.push(...jobEntries);
          }
        } catch (err) {
          // Skip failed invoice fetches
        }
      })
    )
  );

  console.log(`[Backfill] Shop ${shopId}: extracted ${allJobEntries.length} job entries`);

  // Upsert with change detection using content hash
  for (const entry of allJobEntries) {
    const contentHash = computeJobHash(entry);
    const filter = { 
      shopId: entry.shopId, 
      workOrderId: entry.workOrderId, 
      servicePackageId: entry.servicePackageId 
    };
    
    // Check if record exists with same hash (no changes)
    const existing = await db.collection("job_index").findOne(filter);
    
    if (existing && existing.contentHash === contentHash) {
      skippedUnchanged++;
      continue; // Skip unchanged records
    }
    
    // Insert or update with new content hash
    await db.collection("job_index").updateOne(
      filter,
      { $set: { ...entry, contentHash } },
      { upsert: true }
    );
    jobsIndexed++;
  }

  // Update part cross-references only for new/changed entries
  if (jobsIndexed > 0) {
    const changedEntries = allJobEntries.filter(e => {
      // Simple approach: just update all - the function handles deduplication
      return true;
    });
    await updatePartCrossReferences(changedEntries);
  }

  // Move cursor backwards for next run
  const nextChunkEnd = chunkStart;
  const isComplete = nextChunkEnd <= oldestDate;

  await db.collection("backfill_progress").updateOne(
    { shopId },
    {
      $set: {
        currentChunkEnd: nextChunkEnd,
        lastRunAt: new Date(),
        completed: isComplete,
        ...(isComplete ? { completedAt: new Date() } : {}),
      },
      $inc: { totalJobsIndexed: jobsIndexed }
    }
  );

  return {
    jobsIndexed,
    skipped: skippedUnchanged,
    complete: isComplete,
    message: `${startStr} to ${endStr}: ${jobsIndexed} jobs indexed, ${skippedUnchanged} unchanged`
  };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const startTime = Date.now();

  try {
    const shopsToProcess = await getShopsNeedingBackfill(db);

    if (shopsToProcess.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "All shops have completed backfill",
        duration: `${Date.now() - startTime}ms`
      });
    }

    const selectedShops = shopsToProcess.slice(0, MAX_SHOPS_PER_RUN);
    const results: any[] = [];

    for (const shop of selectedShops) {
      try {
        const result = await backfillShopChunk(db, shop.shopId);
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
          message: `Error: ${err.message}`
        });
      }
    }

    console.log(`[Backfill] Completed in ${Date.now() - startTime}ms:`, results);

    return NextResponse.json({
      ok: true,
      duration: `${Date.now() - startTime}ms`,
      results
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
