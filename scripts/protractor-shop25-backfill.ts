// Protractor history backfill (resumable, chunked)
// Usage: 
//   npx tsx scripts/protractor-shop25-backfill.ts --shop 25              # Process next 3 months for shop 25
//   npx tsx scripts/protractor-shop25-backfill.ts --shop 28 --months 2   # Process 2 months for shop 28
//   npx tsx scripts/protractor-shop25-backfill.ts --shop 25 --reset      # Reset progress and start over

import crypto from "node:crypto";
import { getDb } from "../lib/mongo";
import { extractJobIndexFromWorkOrder, updatePartCrossReferences } from "../lib/job-index";

const BASE_URL = "https://integration.protractor.com/IntegrationServices/2.0";
const DEFAULT_MONTHS_PER_RUN = 3; // Process 3 months at a time to stay under limits

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

async function resolveProtractorConfig(shopId: number, useEnvFallback = false): Promise<ProtractorConfig> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
    { projection: { protractor: 1, protractorConnectionId: 1, protractorApiKey: 1 } }
  );

  let connectionId = shop?.protractorConnectionId ?? shop?.protractor?.connectionId ?? "";
  let apiKey = shop?.protractorApiKey ?? shop?.protractor?.apiKey ?? "";
  
  // Fallback to environment variables if no db credentials and flag is set
  if (!connectionId && !apiKey && useEnvFallback) {
    connectionId = process.env.PROTRACTOR_BACKFILL_CONNECTION_ID ?? "";
    apiKey = process.env.PROTRACTOR_BACKFILL_API_KEY ?? "";
    if (connectionId && apiKey) {
      console.log("Using credentials from environment secrets (PROTRACTOR_BACKFILL_*)");
    }
  }
  
  const configured = Boolean(connectionId && apiKey);
  const authentication = configured ? computeAuthentication(connectionId, apiKey) : "";

  return { connectionId, apiKey, authentication, configured };
}

type ProtractorWorkOrder = {
  ID: string;
  WorkOrderNumber?: number;
  Type?: string;
  Status?: string;
  WorkflowStage?: string;
  ServiceItemID?: string;
  ServiceItem?: any;
  ContactID?: string;
  Contact?: any;
  ScheduledTime?: string;
  Odometer?: number;
  Completed?: boolean;
  ServicePackages?: any[];
};

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
      return { ok: false, error: `HTTP ${res.status}: ${text || res.statusText}` };
    }

    const data = await res.json().catch(() => null);
    return { ok: true, data: data as T };
  } catch (err: any) {
    return { ok: false, error: err.message || "Network error" };
  }
}

async function* fetchInvoicesStream(
  config: ProtractorConfig,
  options?: { startDate?: string; endDate?: string }
): AsyncGenerator<{ invoices: ProtractorWorkOrder[], period: string, totalSoFar: number }> {
  const seenIds = new Set<string>();
  let totalCount = 0;
  
  // Use the /Invoice/ endpoint which returns historical invoices with full details
  const startDate = new Date(options?.startDate || "2020-01-01");
  const endDate = new Date(options?.endDate || new Date().toISOString().split("T")[0]);
  
  let currentStart = new Date(startDate);
  
  while (currentStart < endDate) {
    // Create 1-month window
    const currentEnd = new Date(currentStart);
    currentEnd.setMonth(currentEnd.getMonth() + 1);
    if (currentEnd > endDate) {
      currentEnd.setTime(endDate.getTime());
    }
    
    const startStr = currentStart.toISOString().split("T")[0];
    const endStr = currentEnd.toISOString().split("T")[0];
    
    const params = new URLSearchParams();
    params.set("startDate", startStr);
    params.set("endDate", endStr);

    // Use /Invoice/ endpoint - returns invoices with full service package details
    const result = await protractorFetch<{ ItemCollection?: ProtractorWorkOrder[] }>(
      `/Invoice/?${params.toString()}`,
      config
    );

    if (!result.ok) {
      console.error(`Error fetching invoices ${startStr} to ${endStr}:`, result.error);
      currentStart = new Date(currentEnd);
      continue;
    }

    const pageItems = result.data?.ItemCollection || [];
    const newInvoices: ProtractorWorkOrder[] = [];
    
    for (const item of pageItems) {
      if (item.ID && !seenIds.has(item.ID)) {
        seenIds.add(item.ID);
        newInvoices.push(item);
        totalCount++;
      }
    }
    
    console.log(`[Fetch] ${startStr} to ${endStr}: fetched=${pageItems.length}, new=${newInvoices.length}, total: ${totalCount}`);
    
    if (newInvoices.length > 0) {
      yield { invoices: newInvoices, period: `${startStr} to ${endStr}`, totalSoFar: totalCount };
    }
    
    currentStart = new Date(currentEnd);
    await new Promise(r => setTimeout(r, 50));
  }
}

async function fetchWorkOrderDetails(
  config: ProtractorConfig,
  workOrderId: string
): Promise<ProtractorWorkOrder | null> {
  const result = await protractorFetch<ProtractorWorkOrder>(
    `/WorkOrder/${workOrderId}`,
    config
  );
  
  if (!result.ok) {
    console.error(`Error fetching WO ${workOrderId}:`, result.error);
    return null;
  }
  
  return result.data || null;
}

type ServicePackage = {
  ID: string;
  Description?: string;
  Category?: string;
  Quantity?: number;
  LaborItems?: Array<{
    ID?: string;
    Description?: string;
    Hours?: number;
    Rate?: number;
    Total?: number;
  }>;
  PartItems?: Array<{
    ID?: string;
    PartNumber?: string;
    Description?: string;
    Quantity?: number;
    UnitPrice?: number;
    Total?: number;
  }>;
  Summary?: {
    LaborTotal?: number;
    PartsTotal?: number;
    Total?: number;
  };
};

async function fetchServicePackages(
  config: ProtractorConfig,
  workOrderId: string
): Promise<ServicePackage[]> {
  const result = await protractorFetch<{ ItemCollection?: ServicePackage[] }>(
    `/ServicePackage/WorkOrder/${workOrderId}`,
    config
  );
  
  if (!result.ok || !result.data?.ItemCollection) {
    return [];
  }
  
  const packages = result.data.ItemCollection;
  const enrichedPackages: ServicePackage[] = [];
  
  for (const pkg of packages) {
    const detailResult = await protractorFetch<ServicePackage>(
      `/ServicePackage/${pkg.ID}`,
      config
    );
    
    if (detailResult.ok && detailResult.data) {
      enrichedPackages.push(detailResult.data);
    } else {
      enrichedPackages.push(pkg);
    }
  }
  
  return enrichedPackages;
}

async function main() {
  const args = process.argv.slice(2);
  const resetFlag = args.includes("--reset");
  const useEnvFlag = args.includes("--use-env");
  const monthsIndex = args.indexOf("--months");
  const monthsPerRun = monthsIndex >= 0 ? parseInt(args[monthsIndex + 1]) || DEFAULT_MONTHS_PER_RUN : DEFAULT_MONTHS_PER_RUN;
  const shopIndex = args.indexOf("--shop");
  const SHOP_ID = shopIndex >= 0 ? parseInt(args[shopIndex + 1]) : null;
  
  if (!SHOP_ID) {
    console.error("Usage: npx tsx scripts/protractor-shop25-backfill.ts --shop <shopId> [--months N] [--reset] [--use-env]");
    console.error("  --use-env: Use PROTRACTOR_BACKFILL_* env secrets instead of shop database credentials");
    process.exit(1);
  }
  
  const PROGRESS_KEY = `shop${SHOP_ID}_backfill_progress`;
  
  console.log("=== Protractor History Backfill (Resumable) ===");
  console.log(`Target shop: ${SHOP_ID}`);
  console.log(`Months per run: ${monthsPerRun}`);
  
  const db = await getDb();
  const progressCollection = db.collection("backfill_progress");
  
  // Handle reset
  if (resetFlag) {
    await progressCollection.deleteOne({ key: PROGRESS_KEY });
    console.log("Progress reset. Starting from beginning.\n");
  }
  
  // Get current progress
  const progress = await progressCollection.findOne({ key: PROGRESS_KEY });
  const globalEndDate = new Date();
  const globalStartDate = new Date(Date.now() - 365 * 5 * 24 * 60 * 60 * 1000);
  
  let resumeFrom = progress?.lastProcessedDate ? new Date(progress.lastProcessedDate) : globalStartDate;
  
  // Calculate this run's end date (resume + monthsPerRun months)
  const runEndDate = new Date(resumeFrom);
  runEndDate.setMonth(runEndDate.getMonth() + monthsPerRun);
  if (runEndDate > globalEndDate) {
    runEndDate.setTime(globalEndDate.getTime());
  }
  
  if (resumeFrom >= globalEndDate) {
    console.log("\nBackfill already complete! All data up to", globalEndDate.toISOString().split("T")[0], "has been processed.");
    console.log("Use --reset to start over.");
    process.exit(0);
  }
  
  console.log(`\nProgress: resuming from ${resumeFrom.toISOString().split("T")[0]}`);
  console.log(`This run will process: ${resumeFrom.toISOString().split("T")[0]} to ${runEndDate.toISOString().split("T")[0]}`);
  console.log(`Global end date: ${globalEndDate.toISOString().split("T")[0]}\n`);
  
  // Get shop-specific credentials from database (or env if --use-env flag)
  const config = await resolveProtractorConfig(SHOP_ID, useEnvFlag);
  
  if (!config.configured) {
    console.error(`Protractor not configured for shop ${SHOP_ID}`);
    if (!useEnvFlag) {
      console.error("Tip: Use --use-env flag to use PROTRACTOR_BACKFILL_* environment secrets");
    }
    process.exit(1);
  }
  
  console.log("Testing connection...");
  
  const testResult = await protractorFetch<{ ItemCollection?: any[] }>(
    `/WorkOrder/?take=1`,
    config
  );
  
  if (!testResult.ok) {
    console.error("Connection test failed:", testResult.error);
    process.exit(1);
  }
  
  console.log("Connection successful!\n");
  
  const startDateStr = resumeFrom.toISOString().split("T")[0];
  const endDateStr = runEndDate.toISOString().split("T")[0];
  
  console.log(`Fetching and processing invoices from ${startDateStr} to ${endDateStr}...`);
  console.log("Using /Invoice/ endpoint with streaming...\n");
  
  const historicalCollection = db.collection("sms_historical_work_orders");
  const jobCollection = db.collection("job_index");
  
  let storedCount = 0;
  let jobsIndexed = 0;
  let partsIndexed = 0;
  let errorCount = 0;
  let totalFetched = 0;
  
  const startTime = Date.now();
  
  // Stream invoices month by month to avoid memory issues
  for await (const batch of fetchInvoicesStream(config, { startDate: startDateStr, endDate: endDateStr })) {
    totalFetched = batch.totalSoFar;
    
    for (const invoice of batch.invoices) {
      try {
        const servicePackages = invoice.ServicePackages || [];
        
        await historicalCollection.updateOne(
          { shopId: SHOP_ID, sourceSystem: "protractor", workOrderId: invoice.ID },
          {
            $set: {
              shopId: SHOP_ID,
              sourceSystem: "protractor",
              workOrderId: invoice.ID,
              workOrderNumber: invoice.WorkOrderNumber,
              closedAt: invoice.ScheduledTime || new Date(),
              vehicle: {
                vin: invoice.ServiceItem?.VIN,
                year: invoice.ServiceItem?.Year,
                make: invoice.ServiceItem?.Make,
                model: invoice.ServiceItem?.Model,
                engine: invoice.ServiceItem?.Engine,
                serviceItemId: invoice.ServiceItemID,
              },
              contact: invoice.Contact ? {
                id: invoice.Contact.ID,
                name: invoice.Contact.FileAs || `${invoice.Contact.Name?.FirstName || ""} ${invoice.Contact.Name?.LastName || ""}`.trim(),
                email: invoice.Contact.Email,
                phone: invoice.Contact.Phone1,
              } : null,
              servicePackages: servicePackages,
              rawData: invoice,
              importedAt: new Date(),
            },
          },
          { upsert: true }
        );
        storedCount++;
        
        // Extract job index entries directly from invoice data
        const jobEntries = extractJobIndexFromWorkOrder(SHOP_ID, invoice, "protractor");
        
        if (jobEntries.length > 0) {
          for (const entry of jobEntries) {
            await jobCollection.updateOne(
              { 
                shopId: entry.shopId, 
                workOrderId: entry.workOrderId,
                servicePackageId: entry.servicePackageId 
              },
              { $set: entry },
              { upsert: true }
            );
            jobsIndexed++;
          }
          
          const partsUpdated = await updatePartCrossReferences(jobEntries);
          partsIndexed += partsUpdated;
        }
      } catch (err: any) {
        console.error(`Error processing invoice ${invoice.ID}:`, err.message);
        errorCount++;
      }
    }
    
    // Log progress after each month
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`[Index] ${batch.period}: stored=${storedCount}, jobs=${jobsIndexed}, parts=${partsIndexed} | ${elapsed}min`);
  }
  
  console.log(`\nTotal invoices processed in this run: ${storedCount}`);
  
  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  
  // Save progress checkpoint
  await progressCollection.updateOne(
    { key: PROGRESS_KEY },
    { 
      $set: { 
        key: PROGRESS_KEY,
        lastProcessedDate: runEndDate.toISOString(),
        lastRunAt: new Date(),
        totalStoredThisRun: storedCount,
        totalJobsThisRun: jobsIndexed,
      } 
    },
    { upsert: true }
  );
  
  console.log("\n=== Run Complete ===");
  console.log(`Invoices stored: ${storedCount}`);
  console.log(`Jobs indexed: ${jobsIndexed}`);
  console.log(`Parts cross-referenced: ${partsIndexed}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Time: ${totalTime} minutes`);
  console.log(`\nProgress saved. Next run will resume from ${runEndDate.toISOString().split("T")[0]}`);
  
  // Check if fully complete
  if (runEndDate >= globalEndDate) {
    console.log("\n*** BACKFILL COMPLETE! All 5 years of history have been processed. ***");
  } else {
    const remainingMonths = Math.ceil((globalEndDate.getTime() - runEndDate.getTime()) / (30 * 24 * 60 * 60 * 1000));
    console.log(`\nRemaining: ~${remainingMonths} months. Run script again to continue.`);
  }
  
  await historicalCollection.createIndex({ shopId: 1, sourceSystem: 1 });
  await historicalCollection.createIndex({ shopId: 1, workOrderId: 1 }, { unique: true });
  
  process.exit(0);
}

main().catch(err => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
