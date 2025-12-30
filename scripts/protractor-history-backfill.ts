// One-time Protractor history backfill for shops that switched to Tekmetric
// Usage: npx tsx scripts/protractor-history-backfill.ts

import crypto from "node:crypto";
import { getDb } from "../lib/mongo";
import { extractJobIndexFromWorkOrder, updatePartCrossReferences } from "../lib/job-index";

const BASE_URL = "https://integration.protractor.com/IntegrationServices/2.0";
const SHOP_ID = 28; // C.A.R. Experts - backfill target

type ProtractorConfig = {
  connectionId: string;
  apiKey: string;
  authentication: string;
  configured: boolean;
};

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

function computeAuthentication(connectionId: string, apiKey: string): string {
  const keyBytes = Buffer.from(apiKey.replace(/-/g, "").toLowerCase(), "utf8");
  const dataBytes = Buffer.from(connectionId.replace(/-/g, "").toLowerCase(), "utf8");
  
  const hmac = crypto.createHmac("sha1", keyBytes);
  hmac.update(dataBytes);
  
  return hmac.digest("base64");
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
      return { ok: false, error: `HTTP ${res.status}: ${text || res.statusText}` };
    }

    const data = await res.json().catch(() => null);
    return { ok: true, data: data as T };
  } catch (err: any) {
    return { ok: false, error: err.message || "Network error" };
  }
}

async function fetchAllWorkOrders(
  config: ProtractorConfig,
  options?: { startDate?: string; endDate?: string }
): Promise<ProtractorWorkOrder[]> {
  const allWorkOrders: ProtractorWorkOrder[] = [];
  const pageSize = 100;
  let skip = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams();
    if (options?.startDate) params.set("startDate", options.startDate);
    if (options?.endDate) params.set("endDate", options.endDate);
    params.set("take", String(pageSize));
    params.set("skip", String(skip));

    const result = await protractorFetch<{ ItemCollection?: ProtractorWorkOrder[] }>(
      `/WorkOrder/?${params.toString()}`,
      config
    );

    if (!result.ok) {
      console.error(`Error fetching page at skip=${skip}:`, result.error);
      break;
    }

    const pageItems = result.data?.ItemCollection || [];
    allWorkOrders.push(...pageItems);
    
    console.log(`[Backfill] Fetched page: skip=${skip}, got ${pageItems.length}, total: ${allWorkOrders.length}`);

    if (pageItems.length < pageSize) {
      hasMore = false;
    } else {
      skip += pageSize;
    }

    // Rate limiting - wait 100ms between requests
    await new Promise(r => setTimeout(r, 100));
  }

  return allWorkOrders;
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

async function main() {
  console.log("=== Protractor History Backfill ===");
  console.log(`Target shop: ${SHOP_ID}`);
  
  // Get credentials from environment
  const connectionId = process.env.PROTRACTOR_BACKFILL_CONNECTION_ID;
  const apiKey = process.env.PROTRACTOR_BACKFILL_API_KEY;
  
  if (!connectionId || !apiKey) {
    console.error("Missing PROTRACTOR_BACKFILL_CONNECTION_ID or PROTRACTOR_BACKFILL_API_KEY");
    process.exit(1);
  }
  
  const config: ProtractorConfig = {
    connectionId,
    apiKey,
    authentication: computeAuthentication(connectionId, apiKey),
    configured: true,
  };
  
  console.log("\nTesting connection...");
  
  // Test connection with a simple query
  const testResult = await protractorFetch<{ ItemCollection?: any[] }>(
    `/WorkOrder/?take=1`,
    config
  );
  
  if (!testResult.ok) {
    console.error("Connection test failed:", testResult.error);
    process.exit(1);
  }
  
  console.log("Connection successful!\n");
  
  const db = await getDb();
  
  // Fetch work orders from the past 2 years (adjust as needed)
  const endDate = new Date().toISOString().split("T")[0];
  const startDate = new Date(Date.now() - 365 * 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  
  console.log(`Fetching work orders from ${startDate} to ${endDate}...`);
  
  const workOrders = await fetchAllWorkOrders(config, { startDate, endDate });
  
  console.log(`\nTotal work orders fetched: ${workOrders.length}`);
  
  // Filter to closed/invoiced work orders for history
  const closedWorkOrders = workOrders.filter(wo => 
    wo.WorkflowStage === "Invoiced" || 
    wo.WorkflowStage === "Closed" ||
    wo.Status === "Closed" ||
    wo.Completed === true
  );
  
  console.log(`Closed/invoiced work orders: ${closedWorkOrders.length}`);
  
  // Store raw work orders in historical collection
  const historicalCollection = db.collection("sms_historical_work_orders");
  
  let storedCount = 0;
  let jobsIndexed = 0;
  let partsIndexed = 0;
  
  for (const wo of closedWorkOrders) {
    // Fetch full details including service packages
    const details = await fetchWorkOrderDetails(config, wo.ID);
    
    if (!details) continue;
    
    // Store raw data
    await historicalCollection.updateOne(
      { shopId: SHOP_ID, sourceSystem: "protractor", workOrderId: wo.ID },
      {
        $set: {
          shopId: SHOP_ID,
          sourceSystem: "protractor",
          workOrderId: wo.ID,
          workOrderNumber: wo.WorkOrderNumber,
          closedAt: wo.ScheduledTime || new Date(),
          vehicle: {
            vin: details.ServiceItem?.VIN,
            year: details.ServiceItem?.Year,
            make: details.ServiceItem?.Make,
            model: details.ServiceItem?.Model,
            engine: details.ServiceItem?.Engine,
            serviceItemId: details.ServiceItemID,
          },
          contact: details.Contact ? {
            id: details.Contact.ID,
            name: details.Contact.FileAs || `${details.Contact.Name?.FirstName || ""} ${details.Contact.Name?.LastName || ""}`.trim(),
            email: details.Contact.Email,
            phone: details.Contact.Phone1,
          } : null,
          servicePackages: details.ServicePackages || [],
          rawData: details,
          importedAt: new Date(),
        },
      },
      { upsert: true }
    );
    storedCount++;
    
    // Extract job index entries
    const jobEntries = extractJobIndexFromWorkOrder(SHOP_ID, details, "protractor");
    
    if (jobEntries.length > 0) {
      const jobCollection = db.collection("job_index");
      
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
      
      // Update part cross-references
      const partsUpdated = await updatePartCrossReferences(jobEntries);
      partsIndexed += partsUpdated;
    }
    
    if (storedCount % 50 === 0) {
      console.log(`Progress: ${storedCount}/${closedWorkOrders.length} work orders, ${jobsIndexed} jobs, ${partsIndexed} parts`);
    }
    
    // Rate limiting
    await new Promise(r => setTimeout(r, 50));
  }
  
  console.log("\n=== Backfill Complete ===");
  console.log(`Work orders stored: ${storedCount}`);
  console.log(`Jobs indexed: ${jobsIndexed}`);
  console.log(`Parts cross-referenced: ${partsIndexed}`);
  
  // Create indexes
  await historicalCollection.createIndex({ shopId: 1, sourceSystem: 1 });
  await historicalCollection.createIndex({ shopId: 1, workOrderId: 1 }, { unique: true });
  
  console.log("Indexes created.");
  
  process.exit(0);
}

main().catch(err => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
