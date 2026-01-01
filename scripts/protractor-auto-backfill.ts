// Automatic Protractor history backfill for all configured shops
// Usage: npx tsx scripts/protractor-auto-backfill.ts
// 
// Automatically detects shops with Protractor configured that need backfilling
// and processes them in order (oldest first).

import crypto from "node:crypto";
import { getDb } from "../lib/mongo";
import { extractJobIndexFromWorkOrder, updatePartCrossReferences } from "../lib/job-index";

const BASE_URL = "https://integration.protractor.com/IntegrationServices/2.0";
const DEFAULT_MONTHS_PER_RUN = 3;
const MAX_SHOPS_PER_RUN = 3; // Process up to 3 shops per run

type ProtractorConfig = {
  connectionId: string;
  apiKey: string;
  authentication: string;
  configured: boolean;
};

function computeAuthentication(connectionId: string, apiKey: string): string {
  const keyBytes = Buffer.from(apiKey.replace(/-/g, "").toLowerCase(), "utf8");
  const dataBytes = Buffer.from(connectionId.replace(/-/g, "").toLowerCase(), "utf8");
  const hmac = crypto.createHmac("sha1", keyBytes);
  hmac.update(dataBytes);
  return hmac.digest("base64");
}

async function resolveProtractorConfig(shopId: number): Promise<ProtractorConfig> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
    { projection: { protractor: 1, protractorConnectionId: 1, protractorApiKey: 1 } }
  );

  const connectionId =
    shop?.protractorConnectionId ??
    shop?.protractor?.connectionId ??
    process.env.PROTRACTOR_CONNECTION_ID ??
    "";

  const apiKey =
    shop?.protractorApiKey ??
    shop?.protractor?.apiKey ??
    process.env.PROTRACTOR_API_KEY ??
    "";

  const configured = Boolean(connectionId && apiKey);
  const authentication = configured ? computeAuthentication(connectionId, apiKey) : "";

  return { connectionId, apiKey, authentication, configured };
}

async function protractorFetch<T>(
  endpoint: string,
  config: ProtractorConfig
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const url = `${BASE_URL}${endpoint}`;

  try {
    const res = await fetch(url, {
      headers: {
        connectionId: config.connectionId,
        apiKey: config.apiKey,
        authentication: config.authentication,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
        return { ok: false, error: "API returned HTML (rate limit or error page)" };
      }
      return { ok: false, error: `HTTP ${res.status}: ${text || res.statusText}` };
    }

    const data = await res.json().catch(() => null);
    return { ok: true, data: data as T };
  } catch (err: any) {
    return { ok: false, error: err.message || "Network error" };
  }
}

async function fetchInvoicesForDateRange(
  config: ProtractorConfig,
  startDate: string,
  endDate: string
): Promise<any[]> {
  const allInvoices: any[] = [];
  const pageSize = 100;
  let skip = 0;
  const seenIds = new Set<string>();

  while (true) {
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
      console.error(`Error fetching invoices at skip=${skip}:`, result.error);
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
    await new Promise(r => setTimeout(r, 50));
  }

  return allInvoices;
}

async function fetchInvoiceDetails(config: ProtractorConfig, invoiceId: string): Promise<any | null> {
  const result = await protractorFetch<any>(`/Invoice/${invoiceId}`, config);
  if (!result.ok) return null;
  return result.data || null;
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
    await new Promise(r => setTimeout(r, 20));
  }

  return enrichedPackages;
}

async function getShopsNeedingBackfill(): Promise<{ shopId: number; name: string; currentProgress: Date | null }[]> {
  const db = await getDb();

  // Find all shops with Protractor configured
  const shops = await db.collection("shops").find({
    $or: [
      { "protractor.apiKey": { $exists: true, $nin: [null, ""] } },
      { "protractorApiKey": { $exists: true, $nin: [null, ""] } },
      { "protractor.connectionId": { $exists: true, $nin: [null, ""] } },
      { "protractorConnectionId": { $exists: true, $nin: [null, ""] } }
    ]
  }).toArray();

  // Also check env-based shops by looking at job_index to find shops that might need backfilling
  const indexedShops = await db.collection("job_index").distinct("shopId");
  
  // Get backfill progress for each shop
  const shopsToBackfill: { shopId: number; name: string; currentProgress: Date | null }[] = [];

  for (const shop of shops) {
    const shopId = Number(shop.shopId);
    const progress = await db.collection("backfill_progress").findOne({ shopId });
    
    // Check if shop needs backfilling (not completed)
    if (!progress?.completed) {
      shopsToBackfill.push({
        shopId,
        name: shop.name || shop.locationIdentifier || `Shop ${shopId}`,
        currentProgress: progress?.currentChunkStart ? new Date(progress.currentChunkStart) : null
      });
    }
  }

  // Sort by progress - shops with no progress first, then by oldest progress date
  shopsToBackfill.sort((a, b) => {
    if (!a.currentProgress && !b.currentProgress) return 0;
    if (!a.currentProgress) return -1;
    if (!b.currentProgress) return 1;
    return a.currentProgress.getTime() - b.currentProgress.getTime();
  });

  return shopsToBackfill;
}

async function backfillShop(shopId: number, monthsPerRun: number): Promise<{ success: boolean; jobsIndexed: number; message: string }> {
  const db = await getDb();
  const config = await resolveProtractorConfig(shopId);

  if (!config.configured) {
    return { success: false, jobsIndexed: 0, message: "Protractor not configured" };
  }

  // Get current progress
  let progress = await db.collection("backfill_progress").findOne({ shopId });
  
  const globalEndDate = new Date();
  globalEndDate.setHours(0, 0, 0, 0);
  
  // Default start: 5 years ago
  const defaultStart = new Date();
  defaultStart.setFullYear(defaultStart.getFullYear() - 5);
  defaultStart.setHours(0, 0, 0, 0);
  
  let chunkStart: Date;
  if (progress?.currentChunkStart) {
    chunkStart = new Date(progress.currentChunkStart);
  } else {
    chunkStart = defaultStart;
    // Initialize progress
    await db.collection("backfill_progress").updateOne(
      { shopId },
      { $set: { shopId, startedAt: new Date(), currentChunkStart: chunkStart, completed: false } },
      { upsert: true }
    );
  }

  // Calculate chunk end
  const chunkEnd = new Date(chunkStart);
  chunkEnd.setMonth(chunkEnd.getMonth() + monthsPerRun);
  if (chunkEnd > globalEndDate) {
    chunkEnd.setTime(globalEndDate.getTime());
  }

  // Check if already complete
  if (chunkStart >= globalEndDate) {
    await db.collection("backfill_progress").updateOne(
      { shopId },
      { $set: { completed: true, completedAt: new Date() } }
    );
    return { success: true, jobsIndexed: 0, message: "Backfill already complete" };
  }

  console.log(`[Shop ${shopId}] Processing ${chunkStart.toISOString().split('T')[0]} to ${chunkEnd.toISOString().split('T')[0]}`);

  let jobsIndexed = 0;
  let partsIndexed = 0;

  // Process month by month within chunk
  let monthStart = new Date(chunkStart);
  while (monthStart < chunkEnd) {
    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    if (monthEnd > chunkEnd) monthEnd.setTime(chunkEnd.getTime());

    const startStr = monthStart.toISOString().split("T")[0];
    const endStr = monthEnd.toISOString().split("T")[0];

    const invoices = await fetchInvoicesForDateRange(config, startStr, endStr);
    console.log(`[Shop ${shopId}] ${startStr} to ${endStr}: ${invoices.length} invoices`);

    for (const invoice of invoices) {
      const details = await fetchInvoiceDetails(config, invoice.ID);
      if (!details) continue;

      const servicePackages = await fetchServicePackages(config, invoice.ID);
      const enrichedDetails = { ...details, ServicePackages: servicePackages };

      // Extract and index jobs
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

      await new Promise(r => setTimeout(r, 30));
    }

    monthStart = monthEnd;
  }

  // Update progress
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
    success: true,
    jobsIndexed,
    message: isComplete 
      ? `Backfill complete! Indexed ${jobsIndexed} jobs` 
      : `Processed ${chunkStart.toISOString().split('T')[0]} to ${chunkEnd.toISOString().split('T')[0]}, indexed ${jobsIndexed} jobs`
  };
}

async function main() {
  console.log("=== Automatic Protractor Backfill ===\n");

  const shopsToProcess = await getShopsNeedingBackfill();

  if (shopsToProcess.length === 0) {
    console.log("All shops have completed backfill!");
    process.exit(0);
  }

  console.log(`Found ${shopsToProcess.length} shop(s) needing backfill:`);
  shopsToProcess.forEach(s => {
    const progressStr = s.currentProgress 
      ? `resuming from ${s.currentProgress.toISOString().split('T')[0]}` 
      : "not started";
    console.log(`  - Shop ${s.shopId} (${s.name}): ${progressStr}`);
  });

  console.log(`\nProcessing up to ${MAX_SHOPS_PER_RUN} shop(s) this run...\n`);

  const shopsThisRun = shopsToProcess.slice(0, MAX_SHOPS_PER_RUN);

  for (const shop of shopsThisRun) {
    console.log(`\n--- Processing Shop ${shop.shopId} (${shop.name}) ---`);
    const result = await backfillShop(shop.shopId, DEFAULT_MONTHS_PER_RUN);
    console.log(`[Shop ${shop.shopId}] ${result.message}`);
  }

  console.log("\n=== Backfill Run Complete ===");
  
  // Show remaining shops
  const remaining = shopsToProcess.length - shopsThisRun.length;
  if (remaining > 0) {
    console.log(`${remaining} shop(s) still need processing. Run again to continue.`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
