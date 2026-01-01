import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  protractorFetch,
  fetchInvoiceById,
} from "@/lib/integrations/protractor";
import { extractJobIndexFromWorkOrder, updatePartCrossReferences } from "@/lib/job-index";
import pLimit from "p-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes max

const CRON_SECRET = process.env.CRON_SECRET;
const MONTHS_PER_RUN = 1; // Reduced for faster processing
const MAX_SHOPS_PER_RUN = 1; // Process one shop at a time for better parallelism

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
    
    if (!progress?.completed) {
      shopsToBackfill.push({
        shopId,
        name: shop.name || shop.locationIdentifier || `Shop ${shopId}`,
        progressDate: progress?.currentChunkStart ? new Date(progress.currentChunkStart) : null
      });
    }
  }

  // Prioritize shops with no progress, then by oldest date
  shopsToBackfill.sort((a, b) => {
    if (!a.progressDate && !b.progressDate) return 0;
    if (!a.progressDate) return -1;
    if (!b.progressDate) return 1;
    return a.progressDate.getTime() - b.progressDate.getTime();
  });

  return shopsToBackfill.map(s => ({ shopId: s.shopId, name: s.name }));
}

async function backfillShopChunk(db: any, shopId: number): Promise<{ jobsIndexed: number; complete: boolean; message: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { jobsIndexed: 0, complete: false, message: "Not configured" };
  }

  let progress = await db.collection("backfill_progress").findOne({ shopId });
  
  const globalEndDate = new Date();
  globalEndDate.setHours(0, 0, 0, 0);
  
  const defaultStart = new Date();
  defaultStart.setFullYear(defaultStart.getFullYear() - 5);
  defaultStart.setHours(0, 0, 0, 0);
  
  let chunkStart: Date;
  if (progress?.currentChunkStart) {
    chunkStart = new Date(progress.currentChunkStart);
  } else {
    chunkStart = defaultStart;
    await db.collection("backfill_progress").updateOne(
      { shopId },
      { $set: { shopId, startedAt: new Date(), currentChunkStart: chunkStart, completed: false } },
      { upsert: true }
    );
  }

  const chunkEnd = new Date(chunkStart);
  chunkEnd.setMonth(chunkEnd.getMonth() + MONTHS_PER_RUN);
  if (chunkEnd > globalEndDate) {
    chunkEnd.setTime(globalEndDate.getTime());
  }

  if (chunkStart >= globalEndDate) {
    await db.collection("backfill_progress").updateOne(
      { shopId },
      { $set: { completed: true, completedAt: new Date() } }
    );
    return { jobsIndexed: 0, complete: true, message: "Already complete" };
  }

  const startStr = chunkStart.toISOString().split("T")[0];
  const endStr = chunkEnd.toISOString().split("T")[0];

  console.log(`[Backfill] Shop ${shopId}: ${startStr} to ${endStr}`);

  let jobsIndexed = 0;
  let partsIndexed = 0;

  const invoices = await fetchInvoicesForDateRange(shopId, startStr, endStr);
  console.log(`[Backfill] Shop ${shopId}: ${invoices.length} invoices`);

  if (invoices.length === 0) {
    const nextChunkStart = chunkEnd;
    const isComplete = nextChunkStart >= globalEndDate;
    await db.collection("backfill_progress").updateOne(
      { shopId },
      {
        $set: {
          currentChunkStart: nextChunkStart,
          lastRunAt: new Date(),
          completed: isComplete,
          ...(isComplete ? { completedAt: new Date() } : {}),
        }
      }
    );
    return { jobsIndexed: 0, complete: isComplete, message: `${startStr} to ${endStr}: 0 invoices` };
  }

  const limit = pLimit(10); // Process 10 invoices in parallel
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
              invKeys: Object.keys(fullInv).slice(0, 15),
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

  for (const entry of allJobEntries) {
    await db.collection("job_index").updateOne(
      { shopId: entry.shopId, workOrderId: entry.workOrderId, servicePackageId: entry.servicePackageId },
      { $set: entry },
      { upsert: true }
    );
    jobsIndexed++;
  }

  if (allJobEntries.length > 0) {
    const partsUpdated = await updatePartCrossReferences(allJobEntries);
    partsIndexed += partsUpdated;
  }

  const nextChunkStart = chunkEnd;
  const isComplete = nextChunkStart >= globalEndDate;

  await db.collection("backfill_progress").updateOne(
    { shopId },
    {
      $set: {
        currentChunkStart: nextChunkStart,
        lastRunAt: new Date(),
        completed: isComplete,
        ...(isComplete ? { completedAt: new Date() } : {}),
      },
      $inc: { totalJobsIndexed: jobsIndexed, totalPartsIndexed: partsIndexed }
    }
  );

  return {
    jobsIndexed,
    complete: isComplete,
    message: `${startStr} to ${endStr}: ${jobsIndexed} jobs indexed`
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
