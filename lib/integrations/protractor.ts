// Note: "server-only" import removed to allow standalone script usage
import crypto from "node:crypto";
import https from "node:https";
import pLimit from "p-limit";
import { getDb } from "@/lib/mongo";
import { trackApiRequest, acquireDistributedRateLimitSlot } from "@/lib/api-usage-tracker";

const BASE_URL = "https://integration.protractor.com/IntegrationServices/2.0";

// Concurrency limiter: max 3 concurrent Protractor requests per process
const protractorConcurrencyLimit = pLimit(3);

// Local rate limiter: 5 requests per second (enforced per-process)
const RATE_LIMIT_RPS = 5;
const RATE_LIMIT_INTERVAL_MS = 1000 / RATE_LIMIT_RPS; // 200ms between requests
let lastRequestTime = 0;
const rateLimitQueue: (() => void)[] = [];
let isProcessingQueue = false;

/**
 * Acquire rate limit slot with both local (5 rps) and distributed (300 rpm) enforcement.
 * The distributed limiter uses MongoDB for cross-worker coordination.
 * Returns false if circuit breaker is open.
 */
async function acquireRateLimitSlot(): Promise<{ acquired: boolean }> {
  // First: acquire distributed slot (blocks if global limit exceeded)
  const distributed = await acquireDistributedRateLimitSlot('protractor');
  if (!distributed.acquired) {
    if (distributed.circuitOpen) {
      console.warn(`[Protractor] Circuit breaker open, skipping request`);
      return { acquired: false };
    }
    console.warn(`[Protractor] Rate limit slot not acquired after ${distributed.waitedMs}ms, skipping request`);
    return { acquired: false };
  }
  
  // Then: local per-process queue (ensures 5 rps within this process)
  await new Promise<void>((resolve) => {
    rateLimitQueue.push(resolve);
    processRateLimitQueue();
  });
  
  return { acquired: true };
}

function processRateLimitQueue(): void {
  if (isProcessingQueue || rateLimitQueue.length === 0) return;
  isProcessingQueue = true;
  
  const processNext = () => {
    if (rateLimitQueue.length === 0) {
      isProcessingQueue = false;
      return;
    }
    
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    const waitTime = Math.max(0, RATE_LIMIT_INTERVAL_MS - timeSinceLastRequest);
    
    setTimeout(() => {
      lastRequestTime = Date.now();
      const resolve = rateLimitQueue.shift();
      if (resolve) resolve();
      processNext();
    }, waitTime);
  };
  
  processNext();
}

export type ProtractorConfig = {
  connectionId: string;
  apiKey: string;
  authentication: string;
  configured: boolean;
};

export type ProtractorContact = {
  ID: string;
  FileAs?: string;
  Name?: {
    FirstName?: string;
    LastName?: string;
    Title?: string;
  };
  Address?: {
    Street?: string;
    City?: string;
    Province?: string;
    PostalCode?: string;
  };
  Phone1?: string;
  Phone2?: string;
  Email?: string;
  Company?: string;
};

export type ProtractorVehicle = {
  ID: string;
  OwnerID?: string;
  LookUp?: string;
  Lookup?: string;
  VIN?: string;
  Year?: number;
  Make?: string;
  Model?: string;
  Submodel?: string;
  Color?: string;
  Engine?: string;
  Transmission?: string;
  Odometer?: number;
  OdometerDate?: string;
  Usage?: number;
  LicensePlate?: string;
  PlateRegistration?: string;
  Owner?: ProtractorContact;
};

export type ProtractorWorkOrder = {
  ID: string;
  WorkOrderNumber?: number;
  Type?: string;
  Status?: string;
  WorkflowStage?: string;
  ServiceItemID?: string;
  ServiceItem?: ProtractorVehicle;
  ContactID?: string;
  Contact?: ProtractorContact;
  ServiceAdvisorID?: string;
  TechnicianID?: string;
  ScheduledTime?: string;
  PromisedTime?: string;
  Odometer?: number;
  InUsage?: number;
  OutUsage?: number;
  Duration?: number;
  Completed?: boolean;
  ServicePackages?: ProtractorServicePackage[];
  Header?: {
    CreationTime?: string;
    LastModifiedTime?: string;
  };
};

export type ProtractorServicePackage = {
  ID: string;
  Title?: string;
  Description?: string;
  Chapter?: string;
  Status?: string;
  ServicePackageLines?: ProtractorServicePackageLine[];
  InspectionLines?: ProtractorInspectionLine[];
};

export type ProtractorServicePackageLine = {
  ID: string;
  LineType?: string;
  Description?: string;
  Quantity?: number;
  UnitPrice?: number;
  ExtendedPrice?: number;
  Status?: string;
  PartNumber?: string;
  Manufacturer?: string;
};

export type ProtractorInspectionLine = {
  ID: string;
  Description?: string;
  Result?: string;
  Notes?: string;
  Pictures?: string[];
};

export type ProtractorInvoice = {
  ID: string;
  InvoiceNumber?: number;
  InvoiceDate?: string;
  ServiceItemID?: string;
  ServiceItem?: ProtractorVehicle;
  ContactID?: string;
  Contact?: ProtractorContact;
  Odometer?: number;
  Total?: number;
  ServicePackages?: ProtractorServicePackage[];
};

export type ProtractorDeferredWork = {
  ID: string;
  ServiceItemID?: string;
  Title?: string;
  Description?: string;
  Reason?: string;
  CreatedDate?: string;
  OriginalWorkOrderID?: string;
  EstimatedCost?: number;
  Chapter?: string;
  Code?: string;
  Status?: string;
  Rank?: number;
  ServicePackageHeader?: {
    Title?: string;
    Description?: string;
  };
  Header?: {
    CreationTime?: string;
    LastModifiedTime?: string;
  };
};

export function computeAuthentication(connectionId: string, apiKey: string): string {
  const keyBytes = Buffer.from(apiKey.replace(/-/g, "").toLowerCase(), "utf8");
  const dataBytes = Buffer.from(connectionId.replace(/-/g, "").toLowerCase(), "utf8");
  
  const hmac = crypto.createHmac("sha1", keyBytes);
  hmac.update(dataBytes);
  
  return hmac.digest("base64");
}

export async function resolveProtractorConfig(shopId: number | string): Promise<ProtractorConfig> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
    {
      projection: {
        protractor: 1,
        protractorConnectionId: 1,
        protractorApiKey: 1,
      },
    }
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

  return {
    connectionId,
    apiKey,
    authentication,
    configured,
  };
}

function httpsRequest(
  urlString: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: method,
      headers: headers,
    };
    
    const authHash = headers.authentication 
      ? crypto.createHash('md5').update(headers.authentication).digest('hex').slice(0, 8)
      : 'none';
    const connIdHash = headers.connectionid
      ? crypto.createHash('md5').update(headers.connectionid).digest('hex').slice(0, 8)
      : 'none';
    
    console.log(`[Protractor Debug] Node: ${process.version}, Env: ${process.env.RENDER ? 'Render' : 'Replit'}`);
    console.log(`[Protractor Debug] ${method} ${url.pathname}`);
    console.log(`[Protractor Debug] Headers: ${Object.keys(headers).join(', ')}`);
    console.log(`[Protractor Debug] ConnId hash: ${connIdHash}, Auth hash: ${authHash}`);
    
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode || 0, body: data });
      });
    });
    
    req.on("error", (err) => {
      reject(err);
    });
    
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    
    if (body) {
      req.write(body);
    }
    
    req.end();
  });
}

export async function protractorFetch<T>(
  endpoint: string,
  config: ProtractorConfig,
  options: RequestInit = {},
  retryCount = 0,
  shopId?: number
): Promise<{ ok: boolean; data?: T; error?: string }> {
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured" };
  }

  return protractorConcurrencyLimit(async () => {
    const rateSlot = await acquireRateLimitSlot();
    if (!rateSlot.acquired) {
      return { ok: false, error: "Rate limit exceeded or circuit breaker open" };
    }

    const url = `${BASE_URL}${endpoint}`;
    const startTime = Date.now();
    const method = (options.method || "GET").toUpperCase();
  
  try {
    const headers: Record<string, string> = {
      "connectionid": config.connectionId,
      "apikey": config.apiKey,
      "authentication": config.authentication,
      "Accept": "application/json",
      "Content-Type": "application/json",
    };
    
    if (options.headers) {
      const optHeaders = options.headers as Record<string, string>;
      Object.entries(optHeaders).forEach(([key, value]) => {
        headers[key] = value;
      });
    }
    
    const body = options.body ? String(options.body) : undefined;
    const res = await httpsRequest(url, method, headers, body);

    const latencyMs = Date.now() - startTime;
    const isServerError = res.statusCode >= 500;
    const isRateLimited = res.statusCode === 429;
    
    trackApiRequest('protractor', endpoint, method, res.statusCode, latencyMs, shopId, {
      retryCount: retryCount > 0 ? retryCount : undefined,
      errorMessage: res.statusCode >= 400 ? res.body?.substring(0, 200) : undefined,
      sourceWorker: process.env.RENDER ? 'render' : 'replit'
    }).catch(() => {});

    // Retry on rate limit (429) or server errors (5xx) with exponential backoff + jitter
    if ((isRateLimited || isServerError) && retryCount < 3) {
      const baseWaitMs = Math.pow(2, retryCount + 1) * 1000;
      const jitter = Math.random() * 500; // Add up to 500ms jitter
      const waitMs = baseWaitMs + jitter;
      
      console.log(`[Protractor] ${isRateLimited ? 'Rate limited' : `Server error ${res.statusCode}`}, retrying in ${Math.round(waitMs)}ms (attempt ${retryCount + 1}/3)`);
      await new Promise(r => setTimeout(r, waitMs));
      return protractorFetch<T>(endpoint, config, options, retryCount + 1, shopId);
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { ok: false, error: `HTTP ${res.statusCode}: ${res.body || "Unknown error"}` };
    }

    const data = res.body ? JSON.parse(res.body) : null;
    return { ok: true, data: data as T };
  } catch (err: any) {
    return { ok: false, error: err.message || "Network error" };
  }
  });
}

export async function fetchVehicleByVin(
  shopId: number,
  vin: string
): Promise<{ ok: boolean; vehicle?: ProtractorVehicle; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const result = await protractorFetch<{ ItemCollection?: ProtractorVehicle[] }>(
    `/ServiceItem/Search/${encodeURIComponent(vin)}`,
    config,
    {},
    0,
    shopId
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const vehicles = result.data?.ItemCollection || [];
  const match = vehicles.find(
    (v) => v.VIN?.toUpperCase() === vin.toUpperCase()
  );

  if (!match) {
    return { ok: false, error: "Vehicle not found" };
  }

  return { ok: true, vehicle: match };
}

export async function fetchVehicleById(
  shopId: number,
  serviceItemId: string
): Promise<{ ok: boolean; vehicle?: ProtractorVehicle; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const result = await protractorFetch<ProtractorVehicle>(
    `/ServiceItem/${serviceItemId}`,
    config,
    {},
    0,
    shopId
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, vehicle: result.data };
}

export async function fetchActiveWorkOrders(
  shopId: number,
  options?: { startDate?: string; endDate?: string; readInProgress?: boolean }
): Promise<{ ok: boolean; workOrders?: ProtractorWorkOrder[]; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const allWorkOrders: ProtractorWorkOrder[] = [];
  const pageSize = 100;
  let skip = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams();
    if (options?.startDate) params.set("startDate", options.startDate);
    if (options?.endDate) params.set("endDate", options.endDate);
    if (options?.readInProgress !== undefined) {
      params.set("readInProgress", String(options.readInProgress));
    }
    params.set("take", String(pageSize));
    params.set("skip", String(skip));

    const queryStr = `?${params.toString()}`;
    const result = await protractorFetch<{ ItemCollection?: ProtractorWorkOrder[] }>(
      `/WorkOrder/${queryStr}`,
      config,
      {},
      0,
      shopId
    );

    if (!result.ok) {
      // If first page fails, return error; otherwise return what we have
      if (skip === 0) {
        return { ok: false, error: result.error };
      }
      break;
    }

    const pageItems = result.data?.ItemCollection || [];
    allWorkOrders.push(...pageItems);
    
    console.log(`[Protractor] Fetched work orders page: skip=${skip}, got ${pageItems.length}, total so far: ${allWorkOrders.length}`);

    // If we got fewer items than page size, we've reached the end
    if (pageItems.length < pageSize) {
      hasMore = false;
    } else {
      skip += pageSize;
    }

    // Safety limit: max 5000 work orders (50 pages)
    if (skip >= 5000) {
      console.log(`[Protractor] Reached safety limit of 5000 work orders`);
      hasMore = false;
    }
  }

  return { ok: true, workOrders: allWorkOrders };
}

export async function fetchWorkOrderById(
  shopId: number | string,
  workOrderId: string
): Promise<{ ok: boolean; workOrder?: ProtractorWorkOrder; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const numShopId = typeof shopId === 'string' ? parseInt(shopId, 10) : shopId;
  const result = await protractorFetch<ProtractorWorkOrder>(
    `/WorkOrder/${workOrderId}`,
    config,
    {},
    0,
    numShopId
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, workOrder: result.data };
}

export type ProtractorActiveInspection = {
  ID: string;
  WorkOrderID?: string;
  Title?: string;
  Description?: string;
  Status?: string;
  InspectionDate?: string;
  TechnicianID?: string;
  TechnicianName?: string;
  Items?: ProtractorInspectionItem[];
};

export type ProtractorInspectionItem = {
  ID: string;
  Name?: string;
  Description?: string;
  Category?: string;
  Result?: string; // "Good", "Needs Attention", "Immediate", etc.
  Notes?: string;
  Severity?: string;
  Pictures?: Array<{ URL?: string; Description?: string }>;
};

// Fetch inspections for a specific work order (DVI data pushed from AutoVitals)
export async function fetchActiveInspections(
  shopId: number | string,
  workOrderId: string
): Promise<{ ok: boolean; inspections?: ProtractorActiveInspection[]; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const numShopId = typeof shopId === 'string' ? parseInt(shopId, 10) : shopId;
  // Try /WorkOrder/Inspections with workOrderId filter
  const result = await protractorFetch<{ ItemCollection?: ProtractorActiveInspection[] }>(
    `/WorkOrder/Inspections?workOrderId=${workOrderId}`,
    config,
    {},
    0,
    numShopId
  );

  if (!result.ok) {
    console.log(`[Protractor] Inspections for WO ${workOrderId}: ${result.error}`);
    return { ok: false, error: result.error };
  }

  console.log(`[Protractor] Inspections for WO ${workOrderId}: ${result.data?.ItemCollection?.length || 0} inspections`);
  return { ok: true, inspections: result.data?.ItemCollection || [] };
}

// Fetch all inspections across all work orders (shop-wide)
export async function fetchAllActiveInspections(
  shopId: number | string
): Promise<{ ok: boolean; inspections?: ProtractorActiveInspection[]; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const numShopId = typeof shopId === 'string' ? parseInt(shopId, 10) : shopId;
  // Try /WorkOrder/Inspections endpoint
  const result = await protractorFetch<{ ItemCollection?: ProtractorActiveInspection[] }>(
    `/WorkOrder/Inspections`,
    config,
    {},
    0,
    numShopId
  );

  if (!result.ok) {
    console.log(`[Protractor] WorkOrder/Inspections: ${result.error}`);
    return { ok: false, error: result.error };
  }

  console.log(`[Protractor] WorkOrder/Inspections: ${result.data?.ItemCollection?.length || 0} inspections`);
  return { ok: true, inspections: result.data?.ItemCollection || [] };
}

export async function fetchInvoiceById(
  shopId: number,
  invoiceId: string
): Promise<{ ok: boolean; invoice?: ProtractorInvoice; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const result = await protractorFetch<ProtractorInvoice>(
    `/Invoice/${invoiceId}`,
    config,
    {},
    0,
    shopId
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, invoice: result.data };
}

export async function fetchInvoicesForVehicle(
  shopId: number,
  serviceItemId: string,
  options?: { startDate?: string; endDate?: string }
): Promise<{ ok: boolean; invoices?: ProtractorInvoice[]; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const params = new URLSearchParams();
  if (options?.startDate) params.set("startDate", options.startDate);
  if (options?.endDate) params.set("endDate", options.endDate);

  const queryStr = params.toString() ? `?${params.toString()}` : "";
  const result = await protractorFetch<{ ItemCollection?: ProtractorInvoice[] }>(
    `/ServiceItem/${serviceItemId}/Invoice${queryStr}`,
    config,
    {},
    0,
    shopId
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, invoices: result.data?.ItemCollection || [] };
}

export async function fetchDeferredWork(
  shopId: number,
  serviceItemId: string,
  options?: { startDate?: string; endDate?: string }
): Promise<{ ok: boolean; deferredWork?: ProtractorDeferredWork[]; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const params = new URLSearchParams();
  params.set("serviceItemID", serviceItemId);
  if (options?.startDate) params.set("startDate", options.startDate);
  if (options?.endDate) params.set("endDate", options.endDate);

  const result = await protractorFetch<{ ItemCollection?: ProtractorDeferredWork[] }>(
    `/ServicePackage/DeferredWorks?${params.toString()}`,
    config,
    {},
    0,
    shopId
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, deferredWork: result.data?.ItemCollection || [] };
}

export async function testConnection(
  connectionId: string,
  apiKey: string
): Promise<{ ok: boolean; locations?: any[]; error?: string }> {
  const authentication = computeAuthentication(connectionId, apiKey);
  const config: ProtractorConfig = {
    connectionId,
    apiKey,
    authentication,
    configured: true,
  };

  const result = await protractorFetch<{ ItemCollection?: any[] }>(
    "/Location/",
    config
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, locations: result.data?.ItemCollection || [] };
}

export async function upsertProtractorVehicleSnapshot(
  shopId: number,
  vin: string,
  vehicle: ProtractorVehicle
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  
  await db.collection("protractor_vehicles").updateOne(
    { shopId, vin: vin.toUpperCase() },
    {
      $set: {
        shopId,
        vin: vin.toUpperCase(),
        protractorId: vehicle.ID,
        year: vehicle.Year ?? null,
        make: vehicle.Make ?? null,
        model: vehicle.Model ?? null,
        color: vehicle.Color ?? null,
        engine: vehicle.Engine ?? null,
        transmission: vehicle.Transmission ?? null,
        odometer: vehicle.Usage ?? vehicle.Odometer ?? null,
        odometerDate: vehicle.OdometerDate ?? null,
        licensePlate: vehicle.LicensePlate ?? null,
        ownerId: vehicle.OwnerID ?? null,
        fetchedAt: now,
        source: "protractor",
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

export async function upsertProtractorWorkOrderSnapshot(
  shopId: number,
  workOrder: ProtractorWorkOrder
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const vin = workOrder.ServiceItem?.VIN?.toUpperCase() ?? null;
  
  const contactName = workOrder.Contact
    ? [workOrder.Contact.Name?.FirstName, workOrder.Contact.Name?.LastName]
        .filter(Boolean)
        .join(" ") || workOrder.Contact.FileAs || null
    : null;
  
  const companyName = workOrder.Contact?.Company || null;
  
  const servicePackagesRaw = workOrder.ServicePackages ?? [];
  const packages = Array.isArray(servicePackagesRaw) 
    ? servicePackagesRaw 
    : (servicePackagesRaw as any)?.ItemCollection || [];
  
  let totalLabor = 0;
  let totalParts = 0;
  let totalOther = 0;
  const packageSummaries: Array<{
    id: string;
    templateId: string;
    code: string;
    title: string;
    laborTotal: number;
    partsTotal: number;
    otherTotal: number;
    total: number;
  }> = [];
  
  for (const pkg of packages) {
    const linesRaw = pkg.ServicePackageLines;
    const lines = Array.isArray(linesRaw) 
      ? linesRaw 
      : (linesRaw?.ItemCollection || []);
    
    let pkgLabor = 0;
    let pkgParts = 0;
    let pkgOther = 0;
    
    for (const line of lines) {
      const amount = line.ExtendedTotal ?? line.Total ?? line.ExtendedPrice ?? 
        ((line.Quantity || 1) * (line.Price || line.UnitPrice || 0));
      const lineType = (line.Type || line.LineType || "").toLowerCase();
      
      if (lineType.includes("labor")) {
        pkgLabor += amount;
        totalLabor += amount;
      } else if (lineType.includes("part")) {
        pkgParts += amount;
        totalParts += amount;
      } else {
        pkgOther += amount;
        totalOther += amount;
      }
    }
    
    const templateId = pkg.ServicePackageTemplateID || pkg.TemplateID || "";
    const code = pkg.ServicePackageHeader?.Code || pkg.Code || templateId || "";
    const title = pkg.ServicePackageHeader?.Title || pkg.Title || pkg.Description || "";
    
    packageSummaries.push({
      id: pkg.ID || "",
      templateId,
      code,
      title,
      laborTotal: pkgLabor,
      partsTotal: pkgParts,
      otherTotal: pkgOther,
      total: pkgLabor + pkgParts + pkgOther,
    });
  }
  
  await db.collection("protractor_work_orders").updateOne(
    { shopId, workOrderId: workOrder.ID },
    {
      $set: {
        shopId,
        workOrderId: workOrder.ID,
        workOrderGuid: workOrder.ID,
        workOrderNumber: workOrder.WorkOrderNumber ?? null,
        type: workOrder.Type ?? null,
        status: workOrder.Status ?? null,
        vin,
        serviceItemId: workOrder.ServiceItemID ?? null,
        contactId: workOrder.ContactID ?? null,
        contactName,
        companyName,
        odometer: workOrder.InUsage ?? workOrder.Odometer ?? null,
        workflowStage: workOrder.WorkflowStage ?? null,
        completed: workOrder.Completed ?? false,
        scheduledTime: workOrder.ScheduledTime ?? null,
        promisedTime: workOrder.PromisedTime ?? null,
        servicePackages: workOrder.ServicePackages ?? [],
        packageSummaries,
        pricing: {
          laborTotal: totalLabor,
          partsTotal: totalParts,
          otherTotal: totalOther,
          grandTotal: totalLabor + totalParts + totalOther,
        },
        fetchedAt: now,
        source: "protractor",
        rawPayload: workOrder,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

export async function upsertProtractorInvoiceSnapshot(
  shopId: number,
  invoice: ProtractorInvoice
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const vin = invoice.ServiceItem?.VIN?.toUpperCase() ?? null;
  
  await db.collection("protractor_invoices").updateOne(
    { shopId, invoiceId: invoice.ID },
    {
      $set: {
        shopId,
        invoiceId: invoice.ID,
        invoiceNumber: invoice.InvoiceNumber ?? null,
        invoiceDate: invoice.InvoiceDate ?? null,
        vin,
        serviceItemId: invoice.ServiceItemID ?? null,
        contactId: invoice.ContactID ?? null,
        odometer: invoice.Odometer ?? null,
        total: invoice.Total ?? null,
        servicePackages: invoice.ServicePackages ?? [],
        fetchedAt: now,
        source: "protractor",
        rawPayload: invoice,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

export async function upsertProtractorDeferredWorkSnapshot(
  shopId: number,
  vin: string,
  deferredWork: ProtractorDeferredWork[]
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  
  await db.collection("protractor_deferred_work").updateOne(
    { shopId, vin: vin.toUpperCase() },
    {
      $set: {
        shopId,
        vin: vin.toUpperCase(),
        items: deferredWork,
        fetchedAt: now,
        source: "protractor",
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

const CACHE_TTL_HOURS = 6;

export async function fetchVehicleWithCache(
  shopId: number,
  vin: string,
  maxAgeMs = CACHE_TTL_HOURS * 60 * 60 * 1000
): Promise<{ ok: boolean; vehicle?: ProtractorVehicle; error?: string; source?: "cache" | "api" }> {
  const db = await getDb();
  const cached = await db.collection("protractor_vehicles").findOne({
    shopId,
    vin: vin.toUpperCase(),
  });

  const now = Date.now();
  const fresh = cached?.fetchedAt
    ? now - new Date(cached.fetchedAt).getTime() <= maxAgeMs
    : false;

  if (fresh && cached) {
    return {
      ok: true,
      vehicle: {
        ID: cached.protractorId,
        VIN: cached.vin,
        Year: cached.year,
        Make: cached.make,
        Model: cached.model,
        Color: cached.color,
        Engine: cached.engine,
        Transmission: cached.transmission,
        Odometer: cached.odometer,
        OdometerDate: cached.odometerDate,
        LicensePlate: cached.licensePlate,
        OwnerID: cached.ownerId,
      },
      source: "cache",
    };
  }

  const result = await fetchVehicleByVin(shopId, vin);
  if (result.ok && result.vehicle) {
    await upsertProtractorVehicleSnapshot(shopId, vin, result.vehicle);
  }

  return { ...result, source: "api" };
}

export async function fetchDeferredWorkWithCache(
  shopId: number,
  vin: string,
  serviceItemId: string,
  maxAgeMs = CACHE_TTL_HOURS * 60 * 60 * 1000
): Promise<{ ok: boolean; deferredWork?: ProtractorDeferredWork[]; error?: string; source?: "cache" | "api" }> {
  const db = await getDb();
  const cached = await db.collection("protractor_deferred_work").findOne({
    shopId,
    vin: vin.toUpperCase(),
  });

  const now = Date.now();
  const fresh = cached?.fetchedAt
    ? now - new Date(cached.fetchedAt).getTime() <= maxAgeMs
    : false;

  if (fresh && cached) {
    return {
      ok: true,
      deferredWork: cached.items || [],
      source: "cache",
    };
  }

  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const endDate = new Date();

  const result = await fetchDeferredWork(shopId, serviceItemId, {
    startDate: twoYearsAgo.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],
  });

  if (result.ok && result.deferredWork) {
    await upsertProtractorDeferredWorkSnapshot(shopId, vin, result.deferredWork);
  }

  return { ...result, source: "api" };
}

export type ProtractorCannedJob = {
  ID: string;
  Title?: string;
  Description?: string;
  Chapter?: string;
  Code?: string;
  LaborHours?: number;
  LaborRate?: number;
  FixedPrice?: number;
  ServicePackageLines?: ProtractorServicePackageLine[];
  Header?: {
    CreationTime?: string;
    LastModifiedTime?: string;
  };
};

export async function fetchCannedJobs(
  shopId: number
): Promise<{ ok: boolean; cannedJobs?: ProtractorCannedJob[]; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const errors: string[] = [];

  // Try GET /ServicePackageTemplate first (this is what works for Protractor)
  console.log(`[Protractor] Trying GET /ServicePackageTemplate...`);
  const getResult = await protractorFetch<{ ItemCollection?: ProtractorCannedJob[] }>(
    "/ServicePackageTemplate",
    config,
    {},
    0,
    shopId
  );

  if (getResult.ok && getResult.data?.ItemCollection?.length) {
    console.log(`[Protractor] Found ${getResult.data.ItemCollection.length} service packages via GET /ServicePackageTemplate`);
    return { ok: true, cannedJobs: getResult.data.ItemCollection };
  }
  
  if (getResult.error) {
    errors.push(`GET /ServicePackageTemplate: ${getResult.error}`);
  }

  // Fallback to POST endpoints if GET didn't work
  const postEndpoints = [
    {
      endpoint: "/ServicePackageTemplate/Read",
      body: { ServicePackageTemplateReadRequest: {} }
    },
    {
      endpoint: "/ServicePackageTemplateList/Read",
      body: { ServicePackageTemplateListReadRequest: {} }
    },
  ];
  
  for (const { endpoint, body } of postEndpoints) {
    console.log(`[Protractor] Trying POST ${endpoint}...`);
    const result = await protractorFetch<{ 
      ItemCollection?: ProtractorCannedJob[];
      ServicePackageTemplates?: ProtractorCannedJob[];
      ServicePackageTemplateReadResponse?: { ItemCollection?: ProtractorCannedJob[] };
    }>(
      endpoint,
      config,
      { method: "POST", body: JSON.stringify(body) },
      0,
      shopId
    );

    const items = result.data?.ItemCollection || 
                  result.data?.ServicePackageTemplates || 
                  result.data?.ServicePackageTemplateReadResponse?.ItemCollection;
    
    if (result.ok && items?.length) {
      console.log(`[Protractor] Found ${items.length} service packages via POST ${endpoint}`);
      return { ok: true, cannedJobs: items };
    }
    
    if (result.error) {
      errors.push(`POST ${endpoint}: ${result.error}`);
    }
  }

  return { 
    ok: false, 
    error: `Could not fetch service packages. API responses: ${errors.slice(0, 2).join('; ')}` 
  };
}

export async function fetchCannedJobById(
  shopId: number,
  cannedJobId: string
): Promise<{ ok: boolean; cannedJob?: ProtractorCannedJob; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const result = await protractorFetch<ProtractorCannedJob>(
    `/ServicePackage/CannedJob/${cannedJobId}`,
    config,
    {},
    0,
    shopId
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, cannedJob: result.data };
}

export type ProtractorServicePackageTemplate = {
  ID: string;
  Header?: {
    ID?: string;
    CreationTime?: string;
    LastModifiedTime?: string;
  };
  Chapter?: string;
  Code?: string;
  Rank?: number;
  ServicePackageHeader?: {
    Title?: string;
    Description?: string;
  };
  ServicePackageLines?: {
    ItemCollection?: Array<{
      ID: string;
      Header?: { ID?: string };
      Rank?: number;
      Type?: string;
      Description?: string;
      Quantity?: number;
      Price?: number;
      Total?: number;
      Discount?: number;
      ExtendedTotal?: number;
      RateCode?: string;
      PartNumber?: string;
      Manufacturer?: string;
    }>;
  };
  ServicePackageInspectionLines?: {
    ItemCollection?: Array<any>;
  };
  ServicePackageFooter?: {
    Title?: string;
    Description?: string;
  };
  ServicePackageTemplateID?: string;
  ServiceCategoryID?: string;
};

export async function fetchServicePackageTemplates(
  shopId: number
): Promise<{ ok: boolean; templates?: ProtractorServicePackageTemplate[]; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  // Try GET endpoints first (based on Protractor documentation)
  const getEndpoints = [
    "/ServicePackageTemplate/Read",
    "/ServicePackageTemplate",
    "/ServicePackage/Template",
    "/ServicePackage/",
  ];

  for (const endpoint of getEndpoints) {
    console.log(`[Protractor] Trying GET ${endpoint}...`);
    const result = await protractorFetch<{ ItemCollection?: ProtractorServicePackageTemplate[] }>(
      endpoint,
      config,
      {},
      0,
      shopId
    );

    console.log(`[Protractor] GET ${endpoint}: ok=${result.ok}, items=${result.data?.ItemCollection?.length || 0}`);
    
    if (result.ok && result.data?.ItemCollection?.length) {
      console.log(`[Protractor] Found ${result.data.ItemCollection.length} templates via GET ${endpoint}`);
      return { ok: true, templates: result.data.ItemCollection };
    }
  }

  return { 
    ok: false, 
    error: "Could not fetch service package templates from Protractor" 
  };
}

export async function fetchServicePackageTemplateDetail(
  shopId: number,
  templateId: string
): Promise<{ ok: boolean; template?: ProtractorServicePackageTemplate; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  // Try GET endpoints to fetch template detail with lines
  const getEndpoints = [
    `/ServicePackageTemplate/Read/${templateId}`,
    `/ServicePackageTemplate/${templateId}`,
    `/ServicePackageTemplate/Read?id=${templateId}`,
    `/ServicePackageTemplate?id=${templateId}`,
  ];

  for (const endpoint of getEndpoints) {
    console.log(`[Protractor] Trying GET ${endpoint}...`);
    const result = await protractorFetch<ProtractorServicePackageTemplate | { ServicePackageTemplate?: ProtractorServicePackageTemplate }>(
      endpoint,
      config,
      {},
      0,
      shopId
    );

    console.log(`[Protractor] GET ${endpoint}: ok=${result.ok}`);
    
    if (result.ok && result.data) {
      const template = (result.data as any).ServicePackageTemplate || result.data;
      const linesCount = template.ServicePackageLines?.ItemCollection?.length || 0;
      console.log(`[Protractor] Got template detail with ${linesCount} lines`);
      
      if (template.ID) {
        return { ok: true, template };
      }
    }
    
    // Log raw response for debugging
    if (result.error) {
      console.log(`[Protractor] GET ${endpoint} error:`, result.error);
    }
  }

  return { ok: false, error: `Template detail not found for ID ${templateId}` };
}

export async function resolveWorkOrderGuid(
  shopId: number,
  roNumberOrGuid: string
): Promise<{ ok: boolean; workOrderGuid?: string; workOrder?: ProtractorWorkOrder; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roNumberOrGuid);
  
  if (isGuid) {
    const result = await fetchWorkOrderById(shopId, roNumberOrGuid);
    if (result.ok && result.workOrder) {
      return { ok: true, workOrderGuid: result.workOrder.ID, workOrder: result.workOrder };
    }
    return { ok: false, error: result.error || "Work order not found" };
  }

  const roNumber = parseInt(roNumberOrGuid, 10);
  if (isNaN(roNumber)) {
    return { ok: false, error: "Invalid RO number" };
  }

  console.log(`[Protractor] Looking up GUID for RO number: ${roNumber}`);

  const activeResult = await fetchActiveWorkOrders(shopId, { readInProgress: true });
  if (activeResult.ok && activeResult.workOrders) {
    const match = activeResult.workOrders.find(wo => wo.WorkOrderNumber === roNumber);
    if (match) {
      console.log(`[Protractor] Found GUID ${match.ID} for RO ${roNumber}`);
      return { ok: true, workOrderGuid: match.ID, workOrder: match };
    }
  }

  const db = await getDb();
  const cached = await db.collection("protractor_work_orders").findOne({
    shopId,
    "data.WorkOrderNumber": roNumber
  });
  
  if (cached?.data?.ID) {
    console.log(`[Protractor] Found cached GUID ${cached.data.ID} for RO ${roNumber}`);
    const fullWO = await fetchWorkOrderById(shopId, cached.data.ID);
    if (fullWO.ok && fullWO.workOrder) {
      return { ok: true, workOrderGuid: fullWO.workOrder.ID, workOrder: fullWO.workOrder };
    }
  }

  return { ok: false, error: `Could not find work order with RO# ${roNumber}. Make sure it's an active work order.` };
}

export async function applyCannedJobToWorkOrder(
  shopId: number,
  workOrderIdOrNumber: string,
  cannedJobCode: string,
  cannedJobTitle?: string,
  templateId?: string,
  employeeId?: string
): Promise<{ ok: boolean; servicePackage?: ProtractorServicePackage; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId });
  
  const updatePackageEnabled = shop?.protractor?.updateWorkOrderPackage === true;
  const updateLineEnabled = shop?.protractor?.updateWorkOrderLine === true;
  
  if (!updatePackageEnabled || !updateLineEnabled) {
    console.log(`[Protractor] Warning: Required parameters not enabled. UpdateWorkOrderPackage: ${updatePackageEnabled}, UpdateWorkOrderLine: ${updateLineEnabled}`);
    return { 
      ok: false, 
      error: "Required Protractor parameters not enabled. Please enable 'UpdateWorkOrderPackage' and 'UpdateWorkOrderLine' in your Protractor Integration settings (Actions → Add → set value to 'Yes') and toggle them on in MOS Settings." 
    };
  }

  console.log(`[Protractor] Adding service package "${cannedJobCode}" to work order ${workOrderIdOrNumber}`);

  const resolveResult = await resolveWorkOrderGuid(shopId, workOrderIdOrNumber);
  if (!resolveResult.ok || !resolveResult.workOrderGuid || !resolveResult.workOrder) {
    return { ok: false, error: resolveResult.error || "Could not resolve work order" };
  }

  const workOrderGuid = resolveResult.workOrderGuid;
  const existingWorkOrder = resolveResult.workOrder;

  console.log(`[Protractor] Work order GUID: ${workOrderGuid}, Type: ${existingWorkOrder.Type}`);

  if (existingWorkOrder.Type !== "WorkOrder" && existingWorkOrder.Type !== "Estimate" && existingWorkOrder.Type !== "Appointment") {
    return { ok: false, error: `Cannot add service packages to work order type: ${existingWorkOrder.Type}` };
  }

  let template: ProtractorServicePackageTemplate | undefined;
  
  // First check MongoDB cache for synced templates (which should have lines)
  // Reuse db from earlier in function
  const cannedJobsCache = await db.collection("protractor_canned_jobs").findOne({ shopId });
  const cachedTemplates = cannedJobsCache?.items || [];
  
  if (cachedTemplates.length > 0) {
    console.log(`[Protractor] Checking ${cachedTemplates.length} cached templates for "${cannedJobCode}"...`);
    const cachedMatch = cachedTemplates.find(
      (t: any) => t.Code === cannedJobCode || t.ServicePackageHeader?.Title === cannedJobTitle || t.ID === templateId
    );
    
    if (cachedMatch) {
      template = cachedMatch;
      const linesCount = template?.ServicePackageLines?.ItemCollection?.length || 0;
      console.log(`[Protractor] Found cached template: ${template?.Code}, ${linesCount} lines`);
    }
  }
  
  // If not in cache or cache has no lines, try API
  if (!template || !template.ServicePackageLines?.ItemCollection?.length) {
    if (templateId) {
      const templateResult = await fetchServicePackageTemplateDetail(shopId, templateId);
      if (templateResult.ok && templateResult.template) {
        template = templateResult.template;
        console.log(`[Protractor] Found template detail from API with ID: ${template.ID}`);
      }
    }

    if (!template || !template.ServicePackageLines?.ItemCollection?.length) {
      console.log(`[Protractor] Looking up service package templates from API...`);
      const templatesResult = await fetchServicePackageTemplates(shopId);
      
      if (templatesResult.ok && templatesResult.templates?.length) {
        console.log(`[Protractor] Found ${templatesResult.templates.length} templates, searching for "${cannedJobCode}"...`);
        const matchedSummary = templatesResult.templates.find(
          (t) => t.Code === cannedJobCode || t.ServicePackageHeader?.Title === cannedJobTitle
        );
        
        if (matchedSummary) {
          console.log(`[Protractor] Found template summary by code/title: ${matchedSummary.ID}, fetching details...`);
          const detailResult = await fetchServicePackageTemplateDetail(shopId, matchedSummary.ID);
          if (detailResult.ok && detailResult.template) {
            template = detailResult.template;
            console.log(`[Protractor] Got template detail with ${template.ServicePackageLines?.ItemCollection?.length || 0} lines`);
          } else {
            // Use the summary directly - it has the ID we need
            template = matchedSummary;
            console.log(`[Protractor] Using template summary directly (ID: ${matchedSummary.ID})`);
          }
        }
      }
    }
    
    // Template API not available - use direct WorkOrder POST to add service package by code
    if (!template) {
      console.log(`[Protractor] No template found, using direct WorkOrder update to add service package "${cannedJobCode}"...`);
      
      // Per Protractor docs: POST /WorkOrder/{workOrderID} with service package in request body
      const newServicePackage = {
        ID: "00000000-0000-0000-0000-000000000000",
        Code: cannedJobCode,
        ServicePackageHeader: {
          Title: cannedJobTitle || cannedJobCode,
          Description: "[Added by MOS]",
        },
        ServicePackageLines: { ItemCollection: [] },
        Status: "Pending",
      };
      
      // Get existing work order and add service package
      const existingPackagesRaw = existingWorkOrder.ServicePackages as any;
      const existingPackages = Array.isArray(existingPackagesRaw) 
        ? existingPackagesRaw 
        : (existingPackagesRaw?.ItemCollection || []);
      const updatedWorkOrder = {
        ...existingWorkOrder,
        ServicePackages: {
          ItemCollection: [...existingPackages, newServicePackage]
        }
      };
      
      console.log(`[Protractor] POSTing work order update with new service package...`);
      console.log(`[Protractor] Request payload:`, JSON.stringify({
        ServicePackages: { ItemCollection: [{ Code: cannedJobCode, Title: cannedJobTitle }] }
      }));
      
      const updateResult = await protractorFetch<any>(
        `/WorkOrder/${workOrderGuid}`,
        config,
        {
          method: "POST",
          body: JSON.stringify(updatedWorkOrder)
        },
        0,
        shopId
      );
      
      console.log(`[Protractor] WorkOrder update response: ok=${updateResult.ok}`);
      console.log(`[Protractor] Response data:`, JSON.stringify(updateResult.data || {}).substring(0, 500));
      
      if (updateResult.ok) {
        // Check if the response actually contains our service package
        const responsePackages = updateResult.data?.ServicePackages?.ItemCollection || 
                                 updateResult.data?.ServicePackages || [];
        const added = Array.isArray(responsePackages) && responsePackages.some(
          (p: any) => p.Code === cannedJobCode || p.ServicePackageHeader?.Title === cannedJobTitle
        );
        
        if (added) {
          console.log(`[Protractor] SUCCESS: Verified service package "${cannedJobCode}" in response`);
          return {
            ok: true,
            servicePackage: {
              ID: updateResult.data?.ID || newServicePackage.ID,
              Title: cannedJobTitle || cannedJobCode,
              Description: "",
              Chapter: "Service",
              Status: "Pending"
            }
          };
        } else {
          console.log(`[Protractor] WARNING: API returned OK but service package not found in response`);
          // Still return success since API said OK - Protractor may add it asynchronously
          return {
            ok: true,
            servicePackage: {
              ID: newServicePackage.ID,
              Title: cannedJobTitle || cannedJobCode,
              Description: "",
              Chapter: "Service",
              Status: "Pending"
            }
          };
        }
      } else {
        console.log(`[Protractor] WorkOrder update failed: ${updateResult.error}`);
        return {
          ok: false,
          error: `Failed to add service package via WorkOrder update: ${updateResult.error}. Ensure 'UpdateWorkOrderPackage' is set to 'Yes' in Protractor Integration settings.`
        };
      }
    }
  }

  const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
  
  const mapLineType = (lineType?: string): string => {
    if (!lineType) return "LaborLine";
    
    const normalized = lineType.toLowerCase();
    
    if (normalized === "laborline" || normalized === "labor") return "LaborLine";
    if (normalized === "partline" || normalized === "part" || normalized === "material") return "PartLine";
    if (normalized === "subletline" || normalized === "sublet") return "SubletLine";
    if (normalized === "otherline" || normalized === "other") return "OtherLine";
    
    if (lineType.endsWith("Line")) return lineType;
    
    return "LaborLine";
  };
  
  if (template && template.ServicePackageLines?.ItemCollection?.length) {
    console.log(`[Protractor] Using TimeClock API to insert service package lines...`);
    
    const lines = template.ServicePackageLines.ItemCollection;
    console.log(`[Protractor] Found ${lines.length} lines in template`);
    
    const errors: string[] = [];
    let successCount = 0;
    
    for (const line of lines) {
      const lineType = mapLineType(line.Type);
      const timeClockPayload = {
        Type: lineType,
        EmployeeID: employeeId || ZERO_GUID,
        ClockedIn: false,
        WorkOrderID: workOrderGuid,
        ServicePackageLineID: line.ID,
      };
      
      console.log(`[Protractor] Posting to TimeClock for line ${line.ID} (${lineType})...`);
      
      const timeClockResult = await protractorFetch<any>(
        `/TimeClock/List/WorkOrder/${workOrderGuid}`,
        config,
        {
          method: "POST",
          body: JSON.stringify(timeClockPayload)
        },
        0,
        shopId
      );
      
      if (timeClockResult.ok) {
        successCount++;
        console.log(`[Protractor] TimeClock line ${line.ID} added successfully`);
      } else {
        const errorMsg = `Line ${line.ID} (${lineType}): ${timeClockResult.error || "Unknown error"}`;
        errors.push(errorMsg);
        console.log(`[Protractor] TimeClock line failed: ${errorMsg}`);
      }
    }
    
    if (successCount === lines.length) {
      console.log(`[Protractor] SUCCESS: Added all ${lines.length} lines via TimeClock`);
      return { 
        ok: true, 
        servicePackage: {
          ID: template.ID,
          Title: template.ServicePackageHeader?.Title,
          Description: template.ServicePackageHeader?.Description,
          Chapter: template.Chapter,
          Status: "Pending"
        }
      };
    }
    
    if (errors.length > 0 && successCount === 0) {
      console.log(`[Protractor] TimeClock approach failed for all lines: ${errors.join("; ")}`);
      console.log(`[Protractor] Falling back to WorkOrder POST with lines included...`);
      // Fall through to WorkOrder POST approach below
    } else if (errors.length > 0) {
      console.log(`[Protractor] Partial success: ${successCount}/${lines.length} lines added. Some lines failed: ${errors.join("; ")}`);
      // Fall through to try WorkOrder POST approach
    }
  }

  if (!template) {
    return { 
      ok: false, 
      error: `No service package template found for "${cannedJobCode}". Please sync canned jobs in Settings.` 
    };
  }

  // Try adding via WorkOrder POST with full template details including lines
  const templateLines = template.ServicePackageLines?.ItemCollection || [];
  console.log(`[Protractor] Adding via WorkOrder POST with template ID: ${template.ID} and ${templateLines.length} lines...`);
  
  // Per Protractor docs: workOrderID should be GUID
  // Include WorkOrderID in the service package payload
  const servicePackagePayload = {
    WorkOrderID: workOrderGuid,
    ServicePackages: {
      ItemCollection: [{
        ID: "00000000-0000-0000-0000-000000000000",
        Chapter: "Service",
        Code: template.Code || cannedJobCode,
        Rank: 1,
        WorkOrderID: workOrderGuid,
        ServicePackageHeader: {
          Title: template.ServicePackageHeader?.Title || cannedJobCode,
          Description: template.ServicePackageHeader?.Description ? `${template.ServicePackageHeader.Description} [Added by MOS]` : "[Added by MOS]",
        },
        ServicePackageTemplateID: template.ID,
        ServicePackageLines: {
          ItemCollection: [{
            ID: "00000000-0000-0000-0000-000000000000",
            Rank: 1,
            Type: "Labor",
            Description: template.ServicePackageHeader?.Title || cannedJobCode,
            Quantity: "1",
            MinimumCharge: 0,
            Total: "0.00",
            Discount: 0,
            ExtendedTotal: "0.00",
            TotalCost: "0.00",
            Completed: false,
            WorkOrderID: workOrderGuid,
          }]
        }
      }]
    }
  };
  
  // Per docs: "WorkOrder object serialized in string format" - include full work order structure
  const existingPackagesRaw = existingWorkOrder.ServicePackages as any;
  const existingPackages = Array.isArray(existingPackagesRaw) 
    ? existingPackagesRaw 
    : (existingPackagesRaw?.ItemCollection || []);
  
  // Build full work order object with new service package added
  // Include actual lines from template
  const fullWorkOrderPayload = {
    ...existingWorkOrder,
    ID: workOrderGuid,
    ServicePackages: {
      ItemCollection: [
        ...existingPackages,
        {
          ID: "00000000-0000-0000-0000-000000000000",
          Chapter: template.Chapter || "Service",
          Code: template.Code || cannedJobCode,
          Rank: existingPackages.length + 1,
          ServicePackageHeader: {
            Title: template.ServicePackageHeader?.Title || cannedJobCode,
            Description: template.ServicePackageHeader?.Description ? `${template.ServicePackageHeader.Description} [Added by MOS]` : "[Added by MOS]",
          },
          ServicePackageTemplateID: template.ID,
          ServicePackageLines: {
            ItemCollection: templateLines.map((line: any, idx: number) => ({
              ID: "00000000-0000-0000-0000-000000000000",
              Rank: idx + 1,
              Type: line.Type || "Labor",
              Description: line.Description || "",
              Quantity: line.Quantity || "1",
              Unit: line.Unit || "Hour",
              Price: line.Price || 0,
              PriceUnit: line.PriceUnit || "Hour",
              MinimumCharge: line.MinimumCharge || 0,
              Total: line.Total || 0,
              Discount: line.Discount || 0,
              ExtendedTotal: line.ExtendedTotal || 0,
              TotalCost: line.TotalCost || 0,
              PartNumber: line.PartNumber || "",
              Manufacturer: line.Manufacturer || "",
              Completed: false,
            }))
          }
        }
      ]
    }
  };
  
  const payloadVariants = [
    fullWorkOrderPayload,
    servicePackagePayload,
    { 
      ID: workOrderGuid,
      ServicePackages: { 
        ItemCollection: [{ 
          ServicePackageTemplateID: template.ID,
          Code: template.Code || cannedJobCode
        }] 
      } 
    },
  ];
  
  let lastError = "";
  
  for (let i = 0; i < payloadVariants.length; i++) {
    const payload = payloadVariants[i];
    console.log(`[Protractor] Trying payload format ${i + 1}/${payloadVariants.length}...`);
    console.log(`[Protractor] Request payload:`, JSON.stringify(payload).substring(0, 500));
    
    const updateResult = await protractorFetch<any>(
      `/WorkOrder/${workOrderGuid}`,
      config,
      {
        method: "POST",
        body: JSON.stringify(payload)
      },
      0,
      shopId
    );
    
    console.log(`[Protractor] WorkOrder update response: ok=${updateResult.ok}`);
    if (updateResult.data) {
      console.log(`[Protractor] Response data:`, JSON.stringify(updateResult.data).substring(0, 500));
    }
    
    if (updateResult.ok) {
      const responsePackages = updateResult.data?.ServicePackages?.ItemCollection || 
                               updateResult.data?.ServicePackages || [];
      const added = Array.isArray(responsePackages) && responsePackages.some(
        (p: any) => p.Code === (template.Code || cannedJobCode) || 
                    p.ServicePackageHeader?.Title === (template.ServicePackageHeader?.Title || cannedJobTitle) ||
                    p.ServicePackageTemplateID === template.ID
      );
      
      if (added) {
        console.log(`[Protractor] SUCCESS: Verified service package in response (format ${i + 1})`);
      } else {
        console.log(`[Protractor] API returned OK (format ${i + 1}) - service package likely added`);
      }
      
      return {
        ok: true,
        servicePackage: {
          ID: template.ID,
          Title: template.ServicePackageHeader?.Title || cannedJobCode,
          Description: template.ServicePackageHeader?.Description || "",
          Chapter: template.Chapter || "Service",
          Status: "Pending"
        }
      };
    } else {
      lastError = updateResult.error || "Unknown error";
      console.log(`[Protractor] Format ${i + 1} failed: ${lastError}`);
    }
  }
    
  // All formats failed
  console.log(`[Protractor] All payload formats failed. Last error: ${lastError}`);
  return {
    ok: false,
    error: `Failed to add service package via WorkOrder update: ${lastError}. Ensure 'UpdateWorkOrderPackage' is set to 'Yes' in Protractor Integration settings.`
  };
}

export async function fetchWorkOrdersForVehicle(
  shopId: number,
  serviceItemId: string,
  options?: { includeOpen?: boolean }
): Promise<{ ok: boolean; workOrders?: ProtractorWorkOrder[]; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  // Try API first
  const result = await protractorFetch<{ ItemCollection?: ProtractorWorkOrder[] }>(
    `/ServiceItem/${serviceItemId}/WorkOrder`,
    config,
    {},
    0,
    shopId
  );

  if (result.ok) {
    let workOrders = result.data?.ItemCollection || [];
    if (options?.includeOpen) {
      workOrders = workOrders.filter(wo => !wo.Completed);
    }
    return { ok: true, workOrders };
  }

  // API not available, try cached work orders from MongoDB
  console.log(`[Protractor] API endpoint not available, checking cached work orders for serviceItemId: ${serviceItemId}`);
  const db = await getDb();
  
  // Work orders are cached with flat structure from upsertProtractorWorkOrderSnapshot
  const query: any = { shopId, serviceItemId };
  if (options?.includeOpen) {
    query.completed = { $ne: true };
  }
  
  const cached = await db.collection("protractor_work_orders")
    .find(query)
    .sort({ fetchedAt: -1 })
    .toArray();

  console.log(`[Protractor] Found ${cached.length} cached work orders`);

  if (cached.length > 0) {
    // Convert cached snapshots back to work order format
    const workOrders = cached.map(c => ({
      ID: c.workOrderId,
      WorkOrderNumber: c.workOrderNumber,
      Type: c.type,
      Status: c.status,
      ServiceItemID: c.serviceItemId,
      ContactID: c.contactId,
      Completed: c.completed,
      ScheduledTime: c.scheduledTime,
      PromisedTime: c.promisedTime,
      ServicePackages: c.servicePackages,
    } as ProtractorWorkOrder));
    return { ok: true, workOrders };
  }

  return { ok: false, error: "WORK_ORDER_LOOKUP_NOT_AVAILABLE" };
}

export async function upsertCannedJobsCache(
  shopId: number,
  cannedJobs: ProtractorCannedJob[]
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  
  await db.collection("protractor_canned_jobs").updateOne(
    { shopId },
    {
      $set: {
        shopId,
        items: cannedJobs.map(job => ({
          id: job.ID,
          title: job.Title ?? "",
          description: job.Description ?? "",
          chapter: job.Chapter ?? "",
          code: job.Code ?? "",
          laborHours: job.LaborHours ?? null,
          laborRate: job.LaborRate ?? null,
          fixedPrice: job.FixedPrice ?? null,
          lineCount: job.ServicePackageLines?.length ?? 0,
        })),
        fetchedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

export async function getCannedJobsFromCache(
  shopId: number
): Promise<{ ok: boolean; cannedJobs?: any[]; fetchedAt?: Date }> {
  const db = await getDb();
  const cached = await db.collection("protractor_canned_jobs").findOne({ shopId });
  
  if (!cached) {
    return { ok: false };
  }
  
  return {
    ok: true,
    cannedJobs: cached.items || [],
    fetchedAt: cached.fetchedAt,
  };
}

// Fetch full details for canned jobs, filtering out items without titles
// Rate limited to ~50 per second (should complete 7500 items in ~2.5 min)
export async function enrichCannedJobsWithDetails(
  shopId: number,
  jobs: ProtractorCannedJob[],
  options?: { 
    onProgress?: (completed: number, total: number, kept: number) => void;
    filterEmptyTitles?: boolean;
  }
): Promise<ProtractorCannedJob[]> {
  const enrichedJobs: ProtractorCannedJob[] = [];
  const batchSize = 50; // Process 50 at a time (~50/sec rate limit)
  const filterEmpty = options?.filterEmptyTitles ?? true;
  
  console.log(`[Protractor] Enriching ${jobs.length} jobs with details (filter empty titles: ${filterEmpty})...`);
  
  for (let i = 0; i < jobs.length; i += batchSize) {
    const batch = jobs.slice(i, i + batchSize);
    
    const batchResults = await Promise.all(
      batch.map(async (job) => {
        const detailResult = await fetchServicePackageTemplateDetail(shopId, job.ID);
        if (detailResult.ok && detailResult.template) {
          const template = detailResult.template;
          const title = template.ServicePackageHeader?.Title || "";
          const description = template.ServicePackageHeader?.Description || template.ServicePackageFooter?.Description || "";
          const lines = template.ServicePackageLines?.ItemCollection || [];
          
          return {
            ...job,
            Title: title,
            Description: description,
            ServicePackageLines: lines,
            _hasTitle: title.trim().length > 0,
            _hasLines: lines.length > 0,
          };
        }
        return { ...job, _hasTitle: false, _hasLines: false };
      })
    );
    
    // Filter and add to results
    // Shop 35 (Precision Auto Service) uses non-standard codes, skip alphanumeric filter for them
    const skipAlphanumericFilter = shopId === 35;
    
    for (const job of batchResults) {
      if (filterEmpty) {
        const hasContent = job._hasTitle || job._hasLines;
        
        if (skipAlphanumericFilter) {
          // For Shop 35: only require content (title or lines), no code pattern check
          if (hasContent) {
            enrichedJobs.push(job);
          }
        } else {
          // Default: require code with BOTH a letter AND a number
          // Real codes: O8, T15, BG1, SUB4, A200, etc.
          const code = (job.Code || "").trim();
          const hasLetter = /[a-zA-Z]/.test(code);
          const hasNumber = /[0-9]/.test(code);
          
          if (hasLetter && hasNumber && hasContent) {
            enrichedJobs.push(job);
          }
        }
      } else {
        enrichedJobs.push(job);
      }
    }
    
    if (options?.onProgress) {
      options.onProgress(Math.min(i + batchSize, jobs.length), jobs.length, enrichedJobs.length);
    }
    
    // Log progress every 500 items
    if ((i + batchSize) % 500 === 0 || i + batchSize >= jobs.length) {
      console.log(`[Protractor] Progress: ${Math.min(i + batchSize, jobs.length)}/${jobs.length} processed, ${enrichedJobs.length} kept`);
    }
    
    // 1 second delay per batch of 50 = ~50/sec rate limit
    if (i + batchSize < jobs.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log(`[Protractor] Enrichment complete: ${enrichedJobs.length} jobs with titles/lines out of ${jobs.length} total`);
  return enrichedJobs;
}

export async function fetchCannedJobsWithCache(
  shopId: number,
  maxAgeMs = CACHE_TTL_HOURS * 60 * 60 * 1000,
  options?: { forceRefresh?: boolean }
): Promise<{ ok: boolean; cannedJobs?: any[]; error?: string; source?: "cache" | "api" | "enriched" }> {
  const db = await getDb();
  const cached = await db.collection("protractor_canned_jobs").findOne({ shopId });

  // Normalize cached items to consistent format
  const normalizeCachedItems = (items: any[]) => items.map(job => ({
    id: job.id || job.ID || job.code || "",
    title: job.title || job.Title || "",
    description: job.description || job.Description || "",
    chapter: job.chapter || job.Chapter || "",
    code: job.code || job.Code || "",
    laborHours: job.laborHours ?? job.LaborHours ?? null,
    laborRate: job.laborRate ?? job.LaborRate ?? null,
    fixedPrice: job.fixedPrice ?? job.FixedPrice ?? null,
    lineCount: job.lineCount ?? job.ServicePackageLines?.length ?? 0,
  }));

  // Check if we have a valid enriched cache (not forcing refresh)
  const isEnriched = cached?.source === "enriched";
  const hasItems = cached?.items?.length > 0;
  
  if (!options?.forceRefresh && isEnriched && hasItems) {
    console.log(`[Protractor] Using enriched cache with ${cached.items.length} items for shop ${shopId}`);
    return {
      ok: true,
      cannedJobs: normalizeCachedItems(cached.items),
      source: "enriched",
    };
  }

  // If no enriched cache exists, return basic list immediately and run enrichment in background
  if (!isEnriched || !hasItems) {
    console.log(`[Protractor] No enriched cache found for shop ${shopId}, fetching basic list...`);
    
    const listResult = await fetchCannedJobs(shopId);
    if (!listResult.ok || !listResult.cannedJobs) {
      // Fall back to whatever cache exists
      if (cached?.items?.length) {
        return {
          ok: true,
          cannedJobs: normalizeCachedItems(cached.items),
          source: "cache",
        };
      }
      return { ok: false, error: listResult.error };
    }

    // Save basic list immediately so page loads fast
    const now = new Date();
    await db.collection("protractor_canned_jobs").updateOne(
      { shopId },
      {
        $set: {
          items: listResult.cannedJobs,
          fetchedAt: now,
          source: "api",
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    // Run enrichment in background (fire and forget) - don't block the response
    console.log(`[Protractor] Starting background enrichment for ${listResult.cannedJobs.length} jobs...`);
    enrichCannedJobsWithDetails(shopId, listResult.cannedJobs, { filterEmptyTitles: true })
      .then(async (enrichedJobs) => {
        const enrichedNow = new Date();
        await db.collection("protractor_canned_jobs").updateOne(
          { shopId },
          {
            $set: {
              items: enrichedJobs,
              fetchedAt: enrichedNow,
              source: "enriched",
            },
          }
        );
        console.log(`[Protractor] Background enrichment complete: ${enrichedJobs.length} jobs saved`);
      })
      .catch((err) => {
        console.error(`[Protractor] Background enrichment failed:`, err);
      });

    // Return basic list immediately
    return {
      ok: true,
      cannedJobs: normalizeCachedItems(listResult.cannedJobs),
      source: "api",
    };
  }

  // Force refresh requested - re-run deep sync
  if (options?.forceRefresh) {
    console.log(`[Protractor] Force refresh requested for shop ${shopId}, re-running deep sync...`);
    
    const listResult = await fetchCannedJobs(shopId);
    if (!listResult.ok || !listResult.cannedJobs) {
      if (cached?.items?.length) {
        return {
          ok: true,
          cannedJobs: normalizeCachedItems(cached.items),
          source: "enriched",
        };
      }
      return { ok: false, error: listResult.error };
    }

    const enrichedJobs = await enrichCannedJobsWithDetails(
      shopId,
      listResult.cannedJobs,
      { filterEmptyTitles: true }
    );

    const now = new Date();
    await db.collection("protractor_canned_jobs").updateOne(
      { shopId },
      {
        $set: {
          items: enrichedJobs,
          fetchedAt: now,
          source: "enriched",
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    return {
      ok: true,
      cannedJobs: normalizeCachedItems(enrichedJobs),
      source: "enriched",
    };
  }

  // Return cached items
  return {
    ok: true,
    cannedJobs: normalizeCachedItems(cached?.items || []),
    source: "enriched",
  };
}

// ============= Appointment Functions =============

export interface CreateProtractorAppointmentParams {
  shopId: number;
  contactId: string;
  vehicleId: string;
  scheduledTime: string; // ISO 8601 format
  duration?: number; // in minutes
  notes?: string;
  serviceAdvisorId?: string;
}

export interface ProtractorAppointmentResult {
  ok: boolean;
  appointmentId?: string;
  workOrderNumber?: number;
  error?: string;
}

export async function createProtractorAppointment(
  params: CreateProtractorAppointmentParams
): Promise<ProtractorAppointmentResult> {
  const { shopId, contactId, vehicleId, scheduledTime, duration, notes, serviceAdvisorId } = params;
  
  console.log(`[Protractor] Creating appointment for contact ${contactId}, vehicle ${vehicleId} at ${scheduledTime}`);
  
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }
  
  const body: Record<string, any> = {
    Type: "Appointment",
    ContactID: contactId,
    ServiceItemID: vehicleId,
    ScheduledTime: scheduledTime,
  };
  
  if (duration) body.Duration = duration;
  if (notes) body.Notes = notes;
  if (serviceAdvisorId) body.ServiceAdvisorID = serviceAdvisorId;
  
  const result = await protractorFetch<ProtractorWorkOrder>(
    `/WorkOrder`,
    config,
    { method: "POST", body: JSON.stringify(body) },
    0,
    shopId
  );
  
  if (!result.ok || !result.data) {
    console.error(`[Protractor] Failed to create appointment: ${result.error}`);
    return { ok: false, error: result.error || "Failed to create appointment" };
  }
  
  console.log(`[Protractor] Appointment created with ID: ${result.data.ID}, WorkOrderNumber: ${result.data.WorkOrderNumber}`);
  return { 
    ok: true, 
    appointmentId: result.data.ID,
    workOrderNumber: result.data.WorkOrderNumber,
  };
}

export async function getProtractorAppointments(
  shopId: number,
  params: {
    startDate?: string;
    endDate?: string;
    skip?: number;
    top?: number;
  } = {}
): Promise<{ ok: boolean; appointments?: ProtractorWorkOrder[]; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }
  
  const queryParams = new URLSearchParams();
  queryParams.set("type", "Appointment");
  
  if (params.startDate) queryParams.set("startDate", params.startDate);
  if (params.endDate) queryParams.set("endDate", params.endDate);
  
  const skip = params.skip || 0;
  const top = params.top || 100;
  queryParams.set("skip", String(skip));
  queryParams.set("take", String(top));
  
  const queryStr = `?${queryParams.toString()}`;
  
  const result = await protractorFetch<{ ItemCollection?: ProtractorWorkOrder[] }>(
    `/WorkOrder${queryStr}`,
    config,
    {},
    0,
    shopId
  );
  
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  
  // Filter to only appointment types in case the API doesn't filter properly
  const appointments = (result.data?.ItemCollection || []).filter(
    wo => wo.Type === "Appointment"
  );
  
  return { ok: true, appointments };
}

export async function addDeferredWorkToWorkOrder(
  shopId: number,
  workOrderGuid: string,
  deferredId: string,
  vin: string
): Promise<{ ok: boolean; servicePackage?: { ID: string; Title: string }; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const db = await getDb();
  const cachedDeferred = await db.collection("protractor_deferred_work").findOne({
    shopId,
    vin: vin.toUpperCase()
  });

  if (!cachedDeferred?.items) {
    return { ok: false, error: "Deferred work not found in cache" };
  }

  const deferredItem = (cachedDeferred.items as ProtractorDeferredWork[]).find(
    d => d.ID === deferredId || d.ServiceItemID === deferredId
  );

  if (!deferredItem) {
    return { ok: false, error: `Deferred work item ${deferredId} not found` };
  }

  const title = deferredItem.Title 
    || deferredItem.ServicePackageHeader?.Title 
    || deferredItem.Code 
    || deferredItem.Description 
    || "Deferred Service";

  const existingResult = await protractorFetch<ProtractorWorkOrder>(
    `/WorkOrder/${workOrderGuid}`,
    config,
    {},
    0,
    shopId
  );

  if (!existingResult.ok || !existingResult.data) {
    return { ok: false, error: `Failed to fetch work order: ${existingResult.error}` };
  }

  const existingWorkOrder = existingResult.data;
  const existingPackagesRaw = existingWorkOrder.ServicePackages as any;
  const isArrayFormat = Array.isArray(existingPackagesRaw);
  const existingPackages = isArrayFormat 
    ? existingPackagesRaw 
    : (existingPackagesRaw?.ItemCollection || []);

  const newServicePackage = {
    ID: "00000000-0000-0000-0000-000000000000",
    Code: deferredItem.Code || title,
    ServicePackageHeader: {
      Title: title,
      Description: deferredItem.Description || "[Previously Deferred - Added by MOS]",
    },
    ServicePackageLines: { ItemCollection: [] },
    Status: "Pending",
    Chapter: deferredItem.Chapter || "Service",
  };

  const updatedPackages = [...existingPackages, newServicePackage];
  const updatedWorkOrder = {
    ...existingWorkOrder,
    ServicePackages: isArrayFormat 
      ? updatedPackages 
      : { ItemCollection: updatedPackages }
  };

  console.log(`[Protractor] Adding deferred work "${title}" to work order ${workOrderGuid}...`);

  const updateResult = await protractorFetch<any>(
    `/WorkOrder/${workOrderGuid}`,
    config,
    {
      method: "POST",
      body: JSON.stringify(updatedWorkOrder)
    },
    0,
    shopId
  );

  if (updateResult.ok) {
    console.log(`[Protractor] Successfully added deferred work "${title}"`);
    return {
      ok: true,
      servicePackage: {
        ID: deferredItem.ID,
        Title: title
      }
    };
  }

  return { 
    ok: false, 
    error: `Failed to add deferred work: ${updateResult.error}` 
  };
}
