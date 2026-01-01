import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  protractorFetch,
  ProtractorConfig,
} from "@/lib/integrations/protractor";
import { extractJobIndexFromWorkOrder, updatePartCrossReferences } from "@/lib/job-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes max

const CRON_SECRET = process.env.CRON_SECRET;
const MONTHS_PER_RUN = 2;
const MAX_SHOPS_PER_RUN = 2;

async function fetchInvoicesForDateRange(
  config: ProtractorConfig,
  startDate: string,
  endDate: string
): Promise<any[]> {
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
      console.error(`[Backfill] Error at skip=${skip}:`, result.error);
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

async function fetchInvoiceDetails(config: ProtractorConfig, invoiceId: string): Promise<any | null> {
  const result = await protractorFetch<any>(`/Invoice/${invoiceId}`, config);
  return result.ok ? result.data || null : null;
}

async function fetchServicePackages(config: ProtractorConfig, invoiceId: string): Promise<any[]> {
  const result = await protractorFetch<{ ItemCollection?: any[] }>(
    `/ServicePackage/Invoice/${invoiceId}`,
    config
  );

  if (!result.ok || !result.data?.ItemCollection) return [];

  const packages = result.data.ItemCollection;
  const enrichedPackages: any[] = [];

  for (const pkg of packages) {
    const detailResult = await protractorFetch<any>(`/ServicePackage/${pkg.ID}`, config);
    enrichedPackages.push(detailResult.ok && detailResult.data ? detailResult.data : pkg);
    await new Promise(r => setTimeout(r, 15));
  }

  return enrichedPackages;
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

  const invoices = await fetchInvoicesForDateRange(config, startStr, endStr);
  console.log(`[Backfill] Shop ${shopId}: ${invoices.length} invoices`);

  let loggedSample = false;
  for (const invoice of invoices) {
    const details = await fetchInvoiceDetails(config, invoice.ID);
    if (!details) continue;

    const servicePackages = await fetchServicePackages(config, invoice.ID);
    
    // Log first invoice structure for debugging
    if (!loggedSample && servicePackages.length > 0) {
      console.log(`[Backfill] Shop ${shopId} sample invoice structure:`, {
        hasDetails: !!details,
        hasServiceItem: !!details?.ServiceItem,
        servicePackagesCount: servicePackages.length,
        firstPkgKeys: servicePackages[0] ? Object.keys(servicePackages[0]).slice(0, 10) : [],
        firstPkgTitle: servicePackages[0]?.ServicePackageHeader?.Title || servicePackages[0]?.Title || 'NO_TITLE',
        firstPkgLinesCount: servicePackages[0]?.ServicePackageLines?.ItemCollection?.length || 
                           servicePackages[0]?.ServicePackageLines?.length || 0,
      });
      loggedSample = true;
    }
    
    const enrichedDetails = { ...details, ServicePackages: servicePackages };

    const jobEntries = extractJobIndexFromWorkOrder(shopId, enrichedDetails, "protractor");

    if (jobEntries.length > 0) {
      for (const entry of jobEntries) {
        await db.collection("job_index").updateOne(
          { shopId: entry.shopId, workOrderId: entry.workOrderId, servicePackageId: entry.servicePackageId },
          { $set: entry },
          { upsert: true }
        );
        jobsIndexed++;
      }

      const partsUpdated = await updatePartCrossReferences(jobEntries);
      partsIndexed += partsUpdated;
    }

    await new Promise(r => setTimeout(r, 20));
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

    const results: { shopId: number; name: string; jobsIndexed: number; complete: boolean; message: string }[] = [];

    for (const shop of shopsToProcess.slice(0, MAX_SHOPS_PER_RUN)) {
      const result = await backfillShopChunk(db, shop.shopId);
      results.push({
        shopId: shop.shopId,
        name: shop.name,
        ...result
      });
    }

    const duration = Date.now() - startTime;
    console.log(`[Backfill] Completed in ${duration}ms:`, results);

    return NextResponse.json({
      ok: true,
      duration: `${duration}ms`,
      shopsRemaining: shopsToProcess.length - results.length,
      results
    });
  } catch (error: any) {
    console.error("[Backfill] Error:", error);
    return NextResponse.json({
      ok: false,
      error: error.message || "Backfill failed",
      duration: `${Date.now() - startTime}ms`
    }, { status: 500 });
  }
}
