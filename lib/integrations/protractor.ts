// Note: "server-only" import removed to allow standalone script usage
import crypto from "node:crypto";
import https from "node:https";
import pLimit from "p-limit";
import { getDb } from "@/lib/mongo";
import { trackApiRequest, acquireDistributedRateLimitSlot } from "@/lib/api-usage-tracker";

const BASE_URL = "https://integration.protractor.com/IntegrationServices/2.0";

// Concurrency limiter: max 3 concurrent Protractor requests per process (for background tasks)
const protractorConcurrencyLimit = pLimit(3);

// PRIORITY concurrency limiter: separate pool for user-initiated requests (bypasses background queue)
const priorityConcurrencyLimit = pLimit(2);

// Local rate limiter: 5 requests per second (enforced per-process)
const RATE_LIMIT_RPS = 5;
const RATE_LIMIT_INTERVAL_MS = 1000 / RATE_LIMIT_RPS; // 200ms between requests
let lastRequestTime = 0;
const rateLimitQueue: (() => void)[] = [];
let isProcessingQueue = false;

/**
 * Acquire rate limit slot with both local (5 rps) and distributed (300 rpm) enforcement.
 * The distributed limiter uses MongoDB for cross-worker coordination.
 * Priority requests skip the local queue for faster execution.
 * Returns false if circuit breaker is open.
 */
async function acquireRateLimitSlot(priority: boolean = false): Promise<{ acquired: boolean; waitedMs?: number }> {
  const startTime = Date.now();
  
  // First: acquire distributed slot (blocks if global limit exceeded)
  const distributed = await acquireDistributedRateLimitSlot('protractor');
  if (!distributed.acquired) {
    if (distributed.circuitOpen) {
      console.warn(`[Protractor] Circuit breaker open, skipping request`);
      return { acquired: false, waitedMs: Date.now() - startTime };
    }
    console.warn(`[Protractor] Rate limit slot not acquired after ${distributed.waitedMs}ms, skipping request`);
    return { acquired: false, waitedMs: distributed.waitedMs };
  }
  
  // For priority requests, use a faster path - skip local queue
  if (priority) {
    const waited = Date.now() - startTime;
    if (waited > 100) {
      console.log(`[Protractor:PRIORITY] Distributed slot acquired after ${waited}ms`);
    }
    return { acquired: true, waitedMs: waited };
  }
  
  // Then: local per-process queue (ensures 5 rps within this process)
  await new Promise<void>((resolve) => {
    rateLimitQueue.push(resolve);
    processRateLimitQueue();
  });
  
  return { acquired: true, waitedMs: Date.now() - startTime };
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

function cleanServicePackageForPost(pkg: any): any {
  const cleaned: any = { ID: pkg.ID };
  if (pkg.Code) cleaned.Code = pkg.Code;
  if (pkg.Chapter) cleaned.Chapter = pkg.Chapter;
  if (pkg.Rank != null) cleaned.Rank = pkg.Rank;
  if (pkg.Flag) cleaned.Flag = pkg.Flag;
  if (pkg.ServicePackageTemplateID) cleaned.ServicePackageTemplateID = pkg.ServicePackageTemplateID;
  if (pkg.ServiceCategoryID) cleaned.ServiceCategoryID = pkg.ServiceCategoryID;
  if (pkg.ServicePackageHeader) {
    cleaned.ServicePackageHeader = {
      Title: pkg.ServicePackageHeader.Title || "",
      Description: pkg.ServicePackageHeader.Description || "",
    };
  }
  if (pkg.ServicePackageFooter) {
    cleaned.ServicePackageFooter = {
      Title: pkg.ServicePackageFooter.Title || "",
      Description: pkg.ServicePackageFooter.Description || "",
    };
  }
  const linesRaw = pkg.ServicePackageLines;
  const lines = Array.isArray(linesRaw) ? linesRaw : (linesRaw?.ItemCollection || []);
  if (lines.length > 0) {
    cleaned.ServicePackageLines = {
      ItemCollection: lines.map((line: any) => {
        const cl: any = { ID: line.ID };
        if (line.Type) cl.Type = line.Type;
        if (line.Rank != null) cl.Rank = line.Rank;
        if (line.Description) cl.Description = line.Description;
        if (line.Quantity != null) cl.Quantity = line.Quantity;
        if (line.Price != null) cl.Price = line.Price;
        if (line.UnitPrice != null) cl.UnitPrice = line.UnitPrice;
        if (line.Total != null) cl.Total = line.Total;
        if (line.ExtendedTotal != null) cl.ExtendedTotal = line.ExtendedTotal;
        if (line.RateCode) cl.RateCode = line.RateCode;
        if (line.TechnicianHour != null) cl.TechnicianHour = line.TechnicianHour;
        if (line.Unit) cl.Unit = line.Unit;
        if (line.Cost != null) cl.Cost = line.Cost;
        if (line.TotalCost != null) cl.TotalCost = line.TotalCost;
        if (line.MinimumCharge != null) cl.MinimumCharge = line.MinimumCharge;
        if (line.Discount != null) cl.Discount = line.Discount;
        if (line.PartNumber) cl.PartNumber = line.PartNumber;
        if (line.Manufacturer) cl.Manufacturer = line.Manufacturer;
        if (line.Completed != null) cl.Completed = line.Completed;
        return cl;
      })
    };
  } else {
    cleaned.ServicePackageLines = { ItemCollection: [] };
  }
  return cleaned;
}

function buildMinimalWorkOrderPayload(
  existingWorkOrder: Record<string, any>,
  servicePackages: any[]
): Record<string, any> {
  const ew = existingWorkOrder as any;
  const payload: Record<string, any> = {
    ID: ew.ID,
    Type: ew.Type || "WorkOrder",
    WorkOrderNumber: ew.WorkOrderNumber || 0,
    Completed: ew.Completed || false,
    WorkflowStage: ew.WorkflowStage || "Unassigned",
    ServicePackages: { ItemCollection: servicePackages },
  };

  if (ew.Contact?.ID) payload.Contact = { ID: ew.Contact.ID };
  else if (ew.ContactID) payload.Contact = { ID: ew.ContactID };

  if (ew.ServiceItem?.ID) payload.ServiceItem = { ID: ew.ServiceItem.ID };
  else if (ew.ServiceItemID) payload.ServiceItem = { ID: ew.ServiceItemID };

  if (ew.ServiceAdvisor?.ID) payload.ServiceAdvisor = { ID: ew.ServiceAdvisor.ID };
  if (ew.Technician?.ID) payload.Technician = { ID: ew.Technician.ID };

  const optionalFields = [
    'ScheduledTime', 'PromisedTime', 'InUsage', 'OutUsage',
    'Flag', 'Tags', 'Note', 'SearchString', 'OtherChargeCode',
    'PurchaseOrderNumber', 'Duration', 'InvoiceTime', 'InvoiceNumber',
    'WorkOrderFlags',
  ];
  for (const field of optionalFields) {
    if (ew[field] != null) payload[field] = ew[field];
  }

  return payload;
}

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
  shopId?: number,
  opts?: { priority?: boolean }
): Promise<{ ok: boolean; data?: T; error?: string }> {
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured" };
  }
  
  const isPriority = opts?.priority === true;
  
  // Use separate concurrency pool for priority (user-initiated) vs background requests
  const concurrencyLimiter = isPriority ? priorityConcurrencyLimit : protractorConcurrencyLimit;

  return concurrencyLimiter(async () => {
    const concurrencyWaitStart = Date.now();
    const rateSlot = await acquireRateLimitSlot(isPriority);
    if (!rateSlot.acquired) {
      return { ok: false, error: "Rate limit exceeded or circuit breaker open" };
    }

    const url = `${BASE_URL}${endpoint}`;
    const startTime = Date.now();
    const method = (options.method || "GET").toUpperCase();
    const totalWaitMs = Date.now() - concurrencyWaitStart;
    
    if (isPriority) {
      console.log(`[Protractor:PRIORITY] ${method} ${endpoint} (queue wait: ${totalWaitMs}ms, rate wait: ${rateSlot.waitedMs || 0}ms)`);
    }
  
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
      
      let body = options.body ? String(options.body) : undefined;
      if (body && method === 'POST' && endpoint.startsWith('/WorkOrder/')) {
        try {
          const parsed = JSON.parse(body);
          const stripStatus = (obj: any): any => {
            if (Array.isArray(obj)) return obj.map(stripStatus);
            if (obj && typeof obj === 'object') {
              const cleaned: any = {};
              for (const [key, val] of Object.entries(obj)) {
                if (key === 'Status') continue;
                cleaned[key] = stripStatus(val);
              }
              return cleaned;
            }
            return obj;
          };
          body = JSON.stringify(stripStatus(parsed));
        } catch {}
      }
      const res = await httpsRequest(url, method, headers, body);

      const latencyMs = Date.now() - startTime;
      const isServerError = res.statusCode >= 500;
      const isRateLimited = res.statusCode === 429;
      
      trackApiRequest('protractor', endpoint, method, res.statusCode, latencyMs, shopId, {
        retryCount: retryCount > 0 ? retryCount : undefined,
        errorMessage: res.statusCode >= 400 ? res.body?.substring(0, 200) : undefined,
        sourceWorker: process.env.RENDER ? 'render' : 'replit'
      }).catch(() => {});

      const maxRetries = (method === 'POST' || method === 'PUT') ? 6 : 3;
      if ((isRateLimited || isServerError) && retryCount < maxRetries) {
        const baseWaitMs = Math.min(Math.pow(2, retryCount + 1) * 1000, 10000);
        const jitter = Math.random() * 500;
        const waitMs = baseWaitMs + jitter;
        
        console.log(`[Protractor] ${isRateLimited ? 'Rate limited' : `Server error ${res.statusCode}`}, retrying in ${Math.round(waitMs)}ms (attempt ${retryCount + 1}/${maxRetries}) | Body: ${(res.body || '').substring(0, 500)}`);

        await new Promise(r => setTimeout(r, waitMs));
        return protractorFetch<T>(endpoint, config, options, retryCount + 1, shopId, opts);
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

export async function searchContacts(
  shopId: number,
  searchString: string
): Promise<{ ok: boolean; contacts?: ProtractorContact[]; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const result = await protractorFetch<{ ItemCollection?: ProtractorContact[] }>(
    `/Contact/Search/?searchString=${encodeURIComponent(searchString)}`,
    config,
    {},
    0,
    shopId,
    { priority: true }
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, contacts: result.data?.ItemCollection || [] };
}

export async function fetchVehiclesByOwner(
  shopId: number,
  ownerId: string
): Promise<{ ok: boolean; vehicles?: ProtractorVehicle[]; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const result = await protractorFetch<{ ItemCollection?: ProtractorVehicle[] }>(
    `/ServiceItem/Search/OwnerID/${ownerId}`,
    config,
    {},
    0,
    shopId,
    { priority: true }
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, vehicles: result.data?.ItemCollection || [] };
}

export async function createContact(
  shopId: number,
  params: {
    firstName: string;
    lastName: string;
    phone1?: string;
    phone2?: string;
    email?: string;
    company?: string;
    street?: string;
    city?: string;
    province?: string;
    postalCode?: string;
    country?: string;
    marketingSource?: string;
    note?: string;
    noMessaging?: boolean;
    noEmail?: boolean;
    noPostCard?: boolean;
  }
): Promise<{ ok: boolean; contactId?: string; contact?: ProtractorContact; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const newContactId = crypto.randomUUID();

  const body: Record<string, any> = {
    ID: newContactId,
    Name: {
      FirstName: params.firstName,
      LastName: params.lastName,
    },
  };

  if (params.phone1) body.Phone1 = params.phone1;
  if (params.phone2) body.Phone2 = params.phone2;
  if (params.email) body.Email = params.email;
  if (params.company) body.Company = params.company;
  if (params.marketingSource) body.MarketingSource = params.marketingSource;
  if (params.note) body.Note = params.note;
  if (params.noMessaging !== undefined) body.NoMessaging = params.noMessaging;
  if (params.noEmail !== undefined) body.NoEmail = params.noEmail;
  if (params.noPostCard !== undefined) body.NoPostCard = params.noPostCard;

  if (params.street || params.city || params.province || params.postalCode || params.country) {
    body.Address = {};
    if (params.street) body.Address.Street = params.street;
    if (params.city) body.Address.City = params.city;
    if (params.province) body.Address.Province = params.province;
    if (params.postalCode) body.Address.PostalCode = params.postalCode;
    if (params.country) body.Address.Country = params.country;
  }

  body.FileAs = `${params.lastName}, ${params.firstName}`.trim();

  const result = await protractorFetch<ProtractorContact>(
    `/Contact/${newContactId}`,
    config,
    { method: "POST", body: JSON.stringify(body) },
    0,
    shopId
  );

  if (!result.ok || !result.data) {
    return { ok: false, error: result.error || "Failed to create contact" };
  }

  console.log(`[Protractor] Created contact ${newContactId}: ${params.firstName} ${params.lastName}`);
  return { ok: true, contactId: result.data.ID || newContactId, contact: result.data };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildServiceItemVehicleXml(fields: {
  id: string;
  ownerId: string;
  lookup?: string;
  description?: string;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  submodel?: string;
  color?: string;
  engine?: string;
  transmission?: string;
  plateRegistration?: string;
  usage?: number;
}): string {
  const lines: string[] = [
    '<ServiceItem xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xsi:type="ServiceItemVehicle">',
    `  <ID>${escapeXml(fields.id)}</ID>`,
    `  <Type>Vehicle</Type>`,
    `  <Lookup>${escapeXml(fields.lookup || "")}</Lookup>`,
    `  <Description>${escapeXml(fields.description || "")}</Description>`,
    `  <Usage>${fields.usage ?? 0}</Usage>`,
    `  <ProductionDate>0001-01-01T00:00:00</ProductionDate>`,
    `  <Note />`,
    `  <NoEmail>false</NoEmail>`,
    `  <NoPostCard>false</NoPostCard>`,
    `  <OwnerID>${escapeXml(fields.ownerId)}</OwnerID>`,
    `  <PlateRegistration>${escapeXml(fields.plateRegistration || "")}</PlateRegistration>`,
    `  <VIN>${escapeXml(fields.vin || "")}</VIN>`,
    `  <Unit />`,
    `  <Color>${escapeXml(fields.color || "")}</Color>`,
    `  <Year>${fields.year || 0}</Year>`,
    `  <Make>${escapeXml(fields.make || "")}</Make>`,
    `  <Model>${escapeXml(fields.model || "")}</Model>`,
    `  <Submodel>${escapeXml(fields.submodel || "")}</Submodel>`,
    `  <Engine>${escapeXml(fields.engine || "")}</Engine>`,
    "</ServiceItem>",
  ];
  return lines.join("\n");
}

const PROTRACTOR_SOAP_URL = "https://integration.protractor.com/IntegrationServices/2.0/ContactServices.asmx";
const PROTRACTOR_SOAP_WO_URL = "https://integration.protractor.com/IntegrationServices/2.0/WorkOrderServices.asmx";
const PROTRACTOR_SOAP_NS = "http://www.protractor.com/Integration/";

async function protractorSoapServiceItemUpdate(
  config: { connectionId: string; apiKey: string; authentication: string },
  serviceItemXml: string
): Promise<{ ok: boolean; error?: string }> {
  const soapEnvelope = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"',
    `               xmlns:tns="${PROTRACTOR_SOAP_NS}">`,
    '  <soap:Body>',
    '    <tns:ServiceItemUpdate>',
    `      <tns:connectionId>${escapeXml(config.connectionId)}</tns:connectionId>`,
    `      <tns:apiKey>${escapeXml(config.apiKey)}</tns:apiKey>`,
    `      <tns:authentication>${escapeXml(config.authentication)}</tns:authentication>`,
    `      <tns:serviceItem><![CDATA[${serviceItemXml}]]></tns:serviceItem>`,
    '    </tns:ServiceItemUpdate>',
    '  </soap:Body>',
    '</soap:Envelope>',
  ].join("\n");

  try {
    const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const url = new URL(PROTRACTOR_SOAP_URL);
      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "text/xml; charset=utf-8",
            "SOAPAction": `${PROTRACTOR_SOAP_NS}ServiceItemUpdate`,
          },
        },
        (response) => {
          let data = "";
          response.on("data", (chunk: string) => (data += chunk));
          response.on("end", () => resolve({ statusCode: response.statusCode || 0, body: data }));
        }
      );
      req.on("error", reject);
      req.write(soapEnvelope);
      req.end();
    });

    if (res.statusCode === 200 && !res.body.includes("<soap:Fault>")) {
      return { ok: true };
    }

    const faultMatch = res.body.match(/faultstring>([^<]+)/);
    return { ok: false, error: faultMatch ? faultMatch[1] : `HTTP ${res.statusCode}` };
  } catch (err: any) {
    return { ok: false, error: err.message || "SOAP request failed" };
  }
}

function buildWorkOrderXml(wo: Record<string, any>): string {
  const x: string[] = ['<WorkOrder>'];
  
  if (wo.ID) x.push(`  <ID>${escapeXml(wo.ID)}</ID>`);
  if (wo.Type) x.push(`  <Type>${escapeXml(wo.Type)}</Type>`);
  if (wo.WorkOrderNumber !== undefined) x.push(`  <WorkOrderNumber>${wo.WorkOrderNumber}</WorkOrderNumber>`);
  if (wo.Completed !== undefined) x.push(`  <Completed>${wo.Completed}</Completed>`);
  if (wo.WorkflowStage) x.push(`  <WorkflowStage>${escapeXml(wo.WorkflowStage)}</WorkflowStage>`);
  if (wo.ScheduledTime) x.push(`  <ScheduledTime>${escapeXml(wo.ScheduledTime)}</ScheduledTime>`);
  if (wo.PromisedTime) x.push(`  <PromisedTime>${escapeXml(wo.PromisedTime)}</PromisedTime>`);
  if (wo.InUsage !== undefined) x.push(`  <InUsage>${wo.InUsage}</InUsage>`);
  if (wo.OutUsage !== undefined) x.push(`  <OutUsage>${wo.OutUsage}</OutUsage>`);
  if (wo.Note) x.push(`  <Note>${escapeXml(wo.Note)}</Note>`);
  if (wo.SearchString) x.push(`  <SearchString>${escapeXml(wo.SearchString)}</SearchString>`);
  if (wo.Flag) x.push(`  <Flag>${escapeXml(wo.Flag)}</Flag>`);
  if (wo.Tags) x.push(`  <Tags>${escapeXml(wo.Tags)}</Tags>`);
  if (wo.OtherChargeCode) x.push(`  <OtherChargeCode>${escapeXml(wo.OtherChargeCode)}</OtherChargeCode>`);
  if (wo.PurchaseOrderNumber) x.push(`  <PurchaseOrderNumber>${escapeXml(wo.PurchaseOrderNumber)}</PurchaseOrderNumber>`);

  if (wo.Contact?.ID) {
    x.push(`  <Contact><ID>${escapeXml(wo.Contact.ID)}</ID></Contact>`);
  }
  if (wo.ServiceItem?.ID) {
    x.push(`  <ServiceItem><ID>${escapeXml(wo.ServiceItem.ID)}</ID></ServiceItem>`);
  }
  if (wo.ServiceAdvisor?.ID) {
    x.push(`  <ServiceAdvisor><ID>${escapeXml(wo.ServiceAdvisor.ID)}</ID></ServiceAdvisor>`);
  }
  if (wo.Technician?.ID) {
    x.push(`  <Technician><ID>${escapeXml(wo.Technician.ID)}</ID></Technician>`);
  }

  const pkgs = Array.isArray(wo.ServicePackages)
    ? wo.ServicePackages
    : wo.ServicePackages?.ItemCollection || [];
  
  if (pkgs.length > 0) {
    x.push('  <ServicePackages>');
    for (const pkg of pkgs) {
      x.push('    <ServicePackage>');
      if (pkg.ID) x.push(`      <ID>${escapeXml(pkg.ID)}</ID>`);
      if (pkg.Chapter) x.push(`      <Chapter>${escapeXml(pkg.Chapter)}</Chapter>`);
      if (pkg.Code) x.push(`      <Code>${escapeXml(pkg.Code)}</Code>`);
      if (pkg.Rank !== undefined) x.push(`      <Rank>${pkg.Rank}</Rank>`);
      if (pkg.ServicePackageHeader) {
        x.push('      <ServicePackageHeader>');
        if (pkg.ServicePackageHeader.Title) x.push(`        <Title>${escapeXml(pkg.ServicePackageHeader.Title)}</Title>`);
        if (pkg.ServicePackageHeader.Description) x.push(`        <Description>${escapeXml(pkg.ServicePackageHeader.Description)}</Description>`);
        x.push('      </ServicePackageHeader>');
      }
      const lines = Array.isArray(pkg.ServicePackageLines)
        ? pkg.ServicePackageLines
        : pkg.ServicePackageLines?.ItemCollection || [];
      if (lines.length > 0) {
        x.push('      <ServicePackageLines>');
        for (const line of lines) {
          x.push('        <ServicePackageLine>');
          if (line.ID) x.push(`          <ID>${escapeXml(line.ID)}</ID>`);
          if (line.Rank !== undefined) x.push(`          <Rank>${line.Rank}</Rank>`);
          if (line.Type) x.push(`          <Type>${escapeXml(line.Type)}</Type>`);
          if (line.Description) x.push(`          <Description>${escapeXml(line.Description)}</Description>`);
          if (line.Quantity !== undefined) x.push(`          <Quantity>${line.Quantity}</Quantity>`);
          if (line.Price !== undefined) x.push(`          <Price>${line.Price}</Price>`);
          if (line.Total !== undefined) x.push(`          <Total>${line.Total}</Total>`);
          if (line.ExtendedTotal !== undefined) x.push(`          <ExtendedTotal>${line.ExtendedTotal}</ExtendedTotal>`);
          if (line.RateCode) x.push(`          <RateCode>${escapeXml(line.RateCode)}</RateCode>`);
          if (line.TechnicianHour !== undefined) x.push(`          <TechnicianHour>${line.TechnicianHour}</TechnicianHour>`);
          if (line.Unit) x.push(`          <Unit>${escapeXml(line.Unit)}</Unit>`);
          if (line.Cost !== undefined) x.push(`          <Cost>${line.Cost}</Cost>`);
          if (line.TotalCost !== undefined) x.push(`          <TotalCost>${line.TotalCost}</TotalCost>`);
          if (line.MinimumCharge !== undefined) x.push(`          <MinimumCharge>${line.MinimumCharge}</MinimumCharge>`);
          if (line.Discount !== undefined) x.push(`          <Discount>${line.Discount}</Discount>`);
          if (line.PartNumber) x.push(`          <PartNumber>${escapeXml(line.PartNumber)}</PartNumber>`);
          if (line.Manufacturer) x.push(`          <Manufacturer>${escapeXml(line.Manufacturer)}</Manufacturer>`);
          if (line.Completed !== undefined) x.push(`          <Completed>${line.Completed}</Completed>`);
          x.push('        </ServicePackageLine>');
        }
        x.push('      </ServicePackageLines>');
      }
      x.push('    </ServicePackage>');
    }
    x.push('  </ServicePackages>');
  }

  x.push('</WorkOrder>');
  return x.join('\n');
}

async function protractorSoapWorkOrderUpdate(
  config: { connectionId: string; apiKey: string; authentication: string },
  workOrderId: string,
  workOrderXml: string,
  shopId?: number | string
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const soapEnvelope = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"',
    `               xmlns:tns="${PROTRACTOR_SOAP_NS}">`,
    '  <soap:Body>',
    '    <tns:WorkOrderUpdate>',
    `      <tns:connectionId>${escapeXml(config.connectionId)}</tns:connectionId>`,
    `      <tns:apiKey>${escapeXml(config.apiKey)}</tns:apiKey>`,
    `      <tns:authentication>${escapeXml(config.authentication)}</tns:authentication>`,
    `      <tns:workOrder><![CDATA[${workOrderXml}]]></tns:workOrder>`,
    '    </tns:WorkOrderUpdate>',
    '  </soap:Body>',
    '</soap:Envelope>',
  ].join('\n');

  const maxRetries = 6;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const startTime = Date.now();
      const res = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const url = new URL(PROTRACTOR_SOAP_WO_URL);
        const req = https.request(
          {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'text/xml; charset=utf-8',
              'SOAPAction': `${PROTRACTOR_SOAP_NS}WorkOrderUpdate`,
            },
          },
          (response) => {
            let data = '';
            response.on('data', (chunk: string) => (data += chunk));
            response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: data }));
          }
        );
        req.on('error', reject);
        req.write(soapEnvelope);
        req.end();
      });

      const latencyMs = Date.now() - startTime;
      trackApiRequest('protractor', `/WorkOrder/${workOrderId}`, 'POST-SOAP', res.statusCode, latencyMs, shopId);

      if (res.statusCode === 200 && !res.body.includes('<soap:Fault>')) {
        const resultMatch = res.body.match(/WorkOrderUpdateResult>([\s\S]*?)<\//);
        const resultXml = resultMatch?.[1]
          ?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
          || '';
        const hasServicePkgs = resultXml.includes('ServicePackage');
        const pkgCount = (resultXml.match(/<ServicePackage>/g) || []).length;
        console.log(`[Protractor:SOAP] WorkOrderUpdate succeeded in ${latencyMs}ms (attempt ${attempt + 1}/${maxRetries + 1}) | Response length: ${res.body.length} | ServicePackages in response: ${pkgCount} | Has packages: ${hasServicePkgs}`);
        if (pkgCount === 0 && resultXml.length > 0) {
          console.log(`[Protractor:SOAP] WARNING: Response has no service packages. Response XML (first 1000): ${resultXml.substring(0, 1000)}`);
        }
        return { ok: true };
      }

      const faultMatch = res.body.match(/faultstring>([^<]+)/);
      const errorMsg = faultMatch ? faultMatch[1] : `HTTP ${res.statusCode}`;
      console.log(`[Protractor:SOAP] WorkOrderUpdate error (attempt ${attempt + 1}/${maxRetries + 1}): ${errorMsg}`);

      if (res.statusCode >= 500 && attempt < maxRetries) {
        const delay = Math.min(2000 * Math.pow(1.5, attempt), 10000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      return { ok: false, error: errorMsg };
    } catch (err: any) {
      console.log(`[Protractor:SOAP] WorkOrderUpdate exception (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
      if (attempt < maxRetries) {
        const delay = Math.min(2000 * Math.pow(1.5, attempt), 10000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return { ok: false, error: err.message || 'SOAP request failed' };
    }
  }
  return { ok: false, error: 'Max retries exceeded' };
}

export async function createServiceItem(
  shopId: number,
  params: {
    ownerId: string;
    vin?: string;
    year?: number;
    make?: string;
    model?: string;
    submodel?: string;
    color?: string;
    engine?: string;
    transmission?: string;
    odometer?: number;
    licensePlate?: string;
  }
): Promise<{ ok: boolean; vehicleId?: string; vehicle?: ProtractorVehicle; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const newVehicleId = crypto.randomUUID();

  const descParts = [
    params.year ? String(params.year) : null,
    params.make || null,
    params.model || null,
    params.submodel || null,
  ].filter(Boolean);
  const description = descParts.join(" ");

  const lookup = params.licensePlate || "";

  const xmlBody = buildServiceItemVehicleXml({
    id: newVehicleId,
    ownerId: params.ownerId,
    lookup,
    description,
    vin: params.vin?.toUpperCase(),
    year: params.year ? Number(params.year) : undefined,
    make: params.make,
    model: params.model,
    submodel: params.submodel,
    color: params.color,
    engine: params.engine,
    transmission: params.transmission,
    usage: params.odometer,
  });

  console.log(`[Protractor] Creating vehicle via SOAP ServiceItemUpdate: ${description} VIN:${params.vin || 'N/A'}`);

  const soapResult = await protractorSoapServiceItemUpdate(
    { connectionId: config.connectionId, apiKey: config.apiKey, authentication: config.authentication },
    xmlBody
  );

  if (!soapResult.ok) {
    console.error(`[Protractor] SOAP vehicle creation failed: ${soapResult.error}`);
    return { ok: false, error: soapResult.error || "Failed to create vehicle via SOAP" };
  }

  console.log(`[Protractor] Created vehicle ${newVehicleId}: ${description} VIN:${params.vin || 'N/A'}`);
  return { ok: true, vehicleId: newVehicleId };
}

export interface WorkOrderServicePackage {
  chapter?: string;
  title: string;
  description?: string;
  code?: string;
  source: "canned" | "deferred" | "history";
  originalWorkOrderId?: string;
  deferredId?: string;
  lines?: Array<{
    description?: string;
    lineType?: string;
    quantity?: number;
    unitPrice?: number;
  }>;
}

export async function createProtractorWorkOrder(
  shopId: number,
  params: {
    contactId: string;
    vehicleId: string;
    vin?: string;
    concernText?: string;
    note?: string;
    mileage?: number;
    workflowStage?: string;
    servicePackages?: WorkOrderServicePackage[];
  }
): Promise<{ ok: boolean; workOrderId?: string; workOrderNumber?: number; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const newWorkOrderId = crypto.randomUUID();
  const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

  const body: Record<string, any> = {
    ID: newWorkOrderId,
    WorkOrderNumber: 0,
    Type: "WorkOrder",
    Completed: false,
    WorkflowStage: params.workflowStage || "Unassigned",
    Contact: { ID: params.contactId },
    ServiceItem: { ID: params.vehicleId },
  };

  if (params.mileage && params.mileage > 0) {
    body.InUsage = params.mileage;
  }
  if (params.note) body.Note = params.note;

  const initialPackages: any[] = [];
  let rank = 1;

  if (params.concernText) {
    initialPackages.push({
      ID: ZERO_GUID,
      Chapter: "Concern",
      Rank: rank++,
      ServicePackageHeader: {
        Title: "Customer Concern Assistant",
        Description: params.concernText,
      },
      ServicePackageLines: { ItemCollection: [] },
    });
  }

  if (initialPackages.length > 0) {
    body.ServicePackages = { ItemCollection: initialPackages };
  }

  const result = await protractorFetch<ProtractorWorkOrder>(
    `/WorkOrder/${newWorkOrderId}`,
    config,
    { method: "POST", body: JSON.stringify(body) },
    0,
    shopId
  );

  if (!result.ok || !result.data) {
    return { ok: false, error: result.error || "Failed to create work order" };
  }

  const workOrderId = result.data.ID;
  const workOrderNumber = result.data.WorkOrderNumber;
  console.log(`[Create WO] Created WO #${workOrderNumber} (${workOrderId})`);

  if (params.servicePackages?.length) {
    const db = await getDb();

    const mapLineType = (lineType?: string): string => {
      if (!lineType) return "Labor";
      const normalized = lineType.toLowerCase();
      if (normalized === "laborline" || normalized === "labor") return "Labor";
      if (normalized === "partline" || normalized === "part" || normalized === "material") return "Material";
      if (normalized === "subletline" || normalized === "sublet") return "Sublet";
      return "Material";
    };

    const normalizeOneLine = (l: any) => ({
      description: l.Description || l.description || "",
      lineType: l.Type || l.LineType || l.lineType || "Labor",
      quantity: parseFloat(String(l.Quantity ?? l.quantity ?? 1)),
      unitPrice: parseFloat(String(l.Price ?? l.UnitPrice ?? l.unitPrice ?? 0)),
      partNumber: l.PartNumber || l.partNumber || "",
      manufacturer: l.Manufacturer || l.manufacturer || "",
    });

    const extractLinesFromRaw = (raw: any): any[] => {
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (raw?.ItemCollection) return raw.ItemCollection;
      return [];
    };

    let shopLaborRate = 0;
    const shop = await db.collection("shops").findOne({ shopId }, { projection: { cachedLaborRate: 1 } });
    if (shop?.cachedLaborRate && shop.cachedLaborRate > 0) {
      shopLaborRate = shop.cachedLaborRate;
    }

    for (const pkg of params.servicePackages) {
      try {
        let resolvedLines = pkg.lines || [];

        if (resolvedLines.length === 0 && pkg.source === "canned") {
          const rawCache = await db.collection("protractor_canned_jobs").findOne({ shopId });
          const rawItems = rawCache?.items || [];
          const titleLower = pkg.title.toLowerCase();
          const codeLower = (pkg.code || '').toLowerCase();
          const match = rawItems.find((t: any) => {
            const tTitle = (t.ServicePackageHeader?.Title || t.Title || t.title || '').toLowerCase();
            const tCode = (t.Code || t.code || '').toLowerCase();
            const tId = (t.ID || t.id || '');
            return tTitle === titleLower || (codeLower && tCode === codeLower) || tId === pkg.deferredId;
          });
          if (match) {
            const matchLines = extractLinesFromRaw(match.ServicePackageLines);
            if (matchLines.length > 0) {
              resolvedLines = matchLines.map(normalizeOneLine);
              console.log(`[Create WO] Resolved ${resolvedLines.length} lines from canned cache for "${pkg.title}"`);
            }
          }
          if (resolvedLines.length === 0 && pkg.deferredId) {
            const templateResult = await fetchServicePackageTemplateDetail(shopId, pkg.deferredId);
            if (templateResult.ok && templateResult.template) {
              const tplLines = extractLinesFromRaw(templateResult.template.ServicePackageLines);
              if (tplLines.length > 0) {
                resolvedLines = tplLines.map(normalizeOneLine);
                console.log(`[Create WO] Resolved ${resolvedLines.length} lines from template API for "${pkg.title}"`);
              }
            }
          }
        }

        if (resolvedLines.length === 0 && (pkg.source === "deferred" || pkg.source === "canned")) {
          const cachedPricing = await findCachedJobPricing(shopId, {
            serviceItemId: params.vehicleId,
            vin: params.vin,
            jobTitle: pkg.title,
            jobCode: pkg.code,
          });
          if (cachedPricing.found && cachedPricing.lines?.length) {
            resolvedLines = cachedPricing.lines.map(normalizeOneLine);
            console.log(`[Create WO] Resolved ${resolvedLines.length} lines from cached job pricing for "${pkg.title}"`);
          }
        }

        if (resolvedLines.length === 0 && pkg.source === "deferred" && pkg.originalWorkOrderId) {
          const origResult = await protractorFetch<ProtractorWorkOrder>(
            `/WorkOrder/${pkg.originalWorkOrderId}`,
            config,
            {},
            0,
            shopId,
            { priority: true }
          );
          if (origResult.ok && origResult.data) {
            const origPkgsRaw = origResult.data.ServicePackages as any;
            const origPkgs = Array.isArray(origPkgsRaw) ? origPkgsRaw : (origPkgsRaw?.ItemCollection || []);
            const titleLower = pkg.title.toLowerCase();
            const codeLower = (pkg.code || '').toLowerCase();
            const match = origPkgs.find((op: any) => {
              const opTitle = (op.ServicePackageHeader?.Title || op.Title || '').toLowerCase();
              const opCode = (op.Code || '').toLowerCase();
              return opTitle === titleLower || (codeLower && opCode === codeLower);
            });
            if (match) {
              const matchLines = extractLinesFromRaw(match.ServicePackageLines);
              if (matchLines.length > 0) {
                resolvedLines = matchLines.map(normalizeOneLine);
                console.log(`[Create WO] Resolved ${resolvedLines.length} lines from original WO for "${pkg.title}"`);
              }
            }
          }
        }

        if (resolvedLines.length === 0 && pkg.source === "history") {
          const histDoc = await db.collection("job_index").findOne({
            shopId,
            'job.title': pkg.title,
            lines: { $exists: true, $ne: [] }
          });
          if (histDoc?.lines?.length) {
            resolvedLines = histDoc.lines.map(normalizeOneLine);
            console.log(`[Create WO] Resolved ${resolvedLines.length} lines from job_index for "${pkg.title}"`);
          }
        }

        const currentWoResult = await protractorFetch<ProtractorWorkOrder>(
          `/WorkOrder/${workOrderId}`,
          config,
          {},
          0,
          shopId,
          { priority: true }
        );

        if (!currentWoResult.ok || !currentWoResult.data) {
          console.error(`[Create WO] Failed to fetch WO for package update: ${currentWoResult.error}`);
          continue;
        }

        const currentWo = currentWoResult.data;
        const existingPkgsRaw = currentWo.ServicePackages as any;
        const existingPkgs = Array.isArray(existingPkgsRaw) ? existingPkgsRaw : (existingPkgsRaw?.ItemCollection || []);

        if (shopLaborRate === 0) {
          for (const existPkg of existingPkgs) {
            const pLines = Array.isArray(existPkg.ServicePackageLines) ? existPkg.ServicePackageLines : (existPkg.ServicePackageLines?.ItemCollection || []);
            for (const line of pLines) {
              if ((line.Type === 'Labor' || line.LineType === 'Labor') && parseFloat(String(line.Price || 0)) > 0) {
                shopLaborRate = parseFloat(String(line.Price));
                break;
              }
            }
            if (shopLaborRate > 0) break;
          }
        }

        if (shopLaborRate === 0) {
          const laborLine = resolvedLines.find((l: any) => {
            const lt = (l.lineType || '').toLowerCase();
            return lt === 'labor' || lt === 'laborline';
          });
          if (laborLine && (laborLine.unitPrice || 0) > 0) {
            shopLaborRate = laborLine.unitPrice || 0;
          }
        }

        const servicePackageLines = resolvedLines.map((l: any, idx: number) => {
          const lineType = mapLineType(l.lineType);
          const qty = l.quantity ?? 1;
          const price = l.unitPrice ?? 0;

          if (lineType === "Labor") {
            const laborRate = shopLaborRate > 0 ? shopLaborRate : price;
            const laborTotal = qty * laborRate;
            return {
              ID: ZERO_GUID,
              Rank: idx + 1,
              Type: "Labor",
              Description: l.description || "Labor",
              Quantity: String(qty),
              RateCode: "1",
              TechnicianHour: String(qty),
              Price: String(laborRate.toFixed(2)),
              Total: String(laborTotal.toFixed(2)),
              ExtendedTotal: String(laborTotal.toFixed(2)),
              MinimumCharge: 0,
              Discount: 0,
              TotalCost: String(laborTotal.toFixed(2)),
              Completed: false,
            };
          } else {
            const extPrice = qty * price;
            return {
              ID: ZERO_GUID,
              Rank: idx + 1,
              Type: lineType,
              Description: l.description || "",
              Quantity: String(qty),
              Unit: "Each",
              Price: String(price.toFixed(2)),
              Total: String(extPrice.toFixed(2)),
              ExtendedTotal: String(extPrice.toFixed(2)),
              MinimumCharge: 0,
              Discount: 0,
              Cost: String((price * 0.6).toFixed(2)),
              TotalCost: String((extPrice * 0.6).toFixed(2)),
              PartNumber: l.partNumber || "",
              Manufacturer: l.manufacturer || "",
              Completed: false,
            };
          }
        });

        const chapter = (pkg.source === "deferred" || (pkg.chapter || "").toLowerCase() === "deferred")
          ? "Service"
          : (pkg.chapter || "Service");

        const description = pkg.source === "deferred"
          ? `${pkg.description || ""}\n[Previously Deferred - Added by MOS]`.trim()
          : (pkg.description ? `${pkg.description} [Added by MOS]` : "[Added by MOS]");

        const newPkg = {
          ID: ZERO_GUID,
          Chapter: chapter,
          Code: pkg.code || "",
          Rank: existingPkgs.length + 1,
          ServicePackageHeader: {
            Title: pkg.title,
            Description: description,
          },
          ServicePackageLines: { ItemCollection: servicePackageLines },
        };

        console.log(`[Create WO] Adding "${pkg.title}" (${pkg.source}): ${servicePackageLines.length} lines`);
        servicePackageLines.forEach((l: any, i: number) => {
          console.log(`[Create WO]   Line ${i}: ${l.Type} - "${l.Description}" Qty:${l.Quantity} Price:${l.Price}`);
        });

        const cw = currentWo as any;
        const updatedWo: Record<string, any> = {
          ID: cw.ID,
          Type: cw.Type,
          WorkOrderNumber: cw.WorkOrderNumber,
          Completed: cw.Completed,
          WorkflowStage: cw.WorkflowStage,
          ScheduledTime: cw.ScheduledTime,
          PromisedTime: cw.PromisedTime,
          InUsage: cw.InUsage,
          OutUsage: cw.OutUsage,
          Flag: cw.Flag,
          Tags: cw.Tags,
          Note: cw.Note,
          SearchString: cw.SearchString,
          OtherChargeCode: cw.OtherChargeCode,
          PurchaseOrderNumber: cw.PurchaseOrderNumber,
          Duration: cw.Duration,
          InvoiceTime: cw.InvoiceTime,
          InvoiceNumber: cw.InvoiceNumber,
          WorkOrderFlags: cw.WorkOrderFlags,
          ServicePackages: { ItemCollection: [...existingPkgs.map((p: any) => {
            const { Status: _s, ...rest } = p;
            if (rest.ServicePackageLines?.ItemCollection) {
              rest.ServicePackageLines = {
                ItemCollection: rest.ServicePackageLines.ItemCollection.map(({ Status: _ls, ...lRest }: any) => lRest)
              };
            }
            return rest;
          }), newPkg] },
        };
        if (cw.Contact?.ID) updatedWo.Contact = { ID: cw.Contact.ID };
        if (cw.ServiceItem?.ID) updatedWo.ServiceItem = { ID: cw.ServiceItem.ID };
        if (cw.ServiceAdvisor?.ID) updatedWo.ServiceAdvisor = { ID: cw.ServiceAdvisor.ID };
        if (cw.Technician?.ID) updatedWo.Technician = { ID: cw.Technician.ID };
        Object.keys(updatedWo).forEach(k => {
          if (updatedWo[k] === undefined || updatedWo[k] === null) delete updatedWo[k];
        });

        const updateResult = await protractorFetch<any>(
          `/WorkOrder/${workOrderId}`,
          config,
          { method: "POST", body: JSON.stringify(updatedWo) },
          0,
          shopId,
          { priority: true }
        );

        if (updateResult.ok) {
          console.log(`[Create WO] Successfully added "${pkg.title}" to WO #${workOrderNumber}`);
        } else {
          console.error(`[Create WO] Failed to add "${pkg.title}": ${updateResult.error}`);
        }
      } catch (err: any) {
        console.error(`[Create WO] Error adding "${pkg.title}": ${err.message}`);
      }
    }
  }

  return {
    ok: true,
    workOrderId,
    workOrderNumber,
  };
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
  workOrderId: string,
  opts?: { priority?: boolean }
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
    numShopId,
    opts
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

  // Use the correct endpoint: /Invoice?serviceItemID=xxx (per Protractor API docs)
  params.set("serviceItemID", serviceItemId);
  const queryStr = `?${params.toString()}`;
  const result = await protractorFetch<{ ItemCollection?: ProtractorInvoice[] }>(
    `/Invoice${queryStr}`,
    config,
    {},
    0,
    shopId
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Debug: Log the raw response structure
  const rawData = result.data as any;
  console.log(`[Protractor] Invoice fetch raw response keys:`, Object.keys(rawData || {}));
  console.log(`[Protractor] Invoice fetch ItemCollection length:`, rawData?.ItemCollection?.length ?? 'undefined');
  
  // Check if data is returned in a different format (array directly, or different property name)
  let invoices: ProtractorInvoice[] = [];
  if (Array.isArray(rawData)) {
    invoices = rawData;
  } else if (rawData?.ItemCollection) {
    invoices = rawData.ItemCollection;
  } else if (rawData?.Invoices) {
    invoices = rawData.Invoices;
  }
  
  return { ok: true, invoices };
}

/**
 * Search job_index (MongoDB) for historical job pricing instead of making live API calls.
 * This uses data already backfilled from Protractor invoices.
 */
export async function findCachedJobPricing(
  shopId: number,
  options: {
    serviceItemId?: string;
    vin?: string;
    jobTitle?: string;
    jobCode?: string;
  }
): Promise<{
  found: boolean;
  lines?: Array<{
    lineType: string;
    description: string;
    partNumber?: string;
    manufacturer?: string;
    quantity: number;
    unitPrice: number;
    extendedPrice: number;
  }>;
  source?: string;
  workOrderNumber?: number;
  performedAt?: Date;
}> {
  const db = await getDb();
  
  const normalize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
  const targetTitle = options.jobTitle ? normalize(options.jobTitle) : '';
  const targetCode = options.jobCode ? normalize(options.jobCode) : '';
  
  // Build query - search by serviceItemId OR VIN
  const orConditions: any[] = [];
  if (options.serviceItemId) {
    orConditions.push({ 'vehicle.serviceItemId': options.serviceItemId });
  }
  if (options.vin) {
    orConditions.push({ 'vehicle.vin': options.vin.toUpperCase() });
    orConditions.push({ 'vehicle.vin': options.vin.toLowerCase() });
  }
  
  if (orConditions.length === 0) {
    console.log(`[Protractor Cache] No serviceItemId or VIN provided for job lookup`);
    return { found: false };
  }
  
  // Query job_index for this vehicle's history
  const jobs = await db.collection('job_index').find({
    shopId,
    $or: orConditions,
  }).sort({ performedAt: -1 }).limit(100).toArray();
  
  console.log(`[Protractor Cache] Found ${jobs.length} cached jobs for vehicle (shopId: ${shopId}, serviceItemId: ${options.serviceItemId || 'N/A'}, vin: ${options.vin || 'N/A'})`);
  
  if (jobs.length === 0) {
    return { found: false };
  }
  
  // Search for matching job by code or title
  for (const job of jobs) {
    const jobTitle = job.job?.title || '';
    const jobCode = job.job?.code || '';
    const normalizedJobTitle = normalize(jobTitle);
    const normalizedJobCode = normalize(jobCode);
    
    let matched = false;
    let matchType = '';
    
    // Exact code match
    if (targetCode && normalizedJobCode === targetCode) {
      matched = true;
      matchType = 'exact code';
    }
    // Exact title match
    else if (targetTitle && normalizedJobTitle === targetTitle) {
      matched = true;
      matchType = 'exact title';
    }
    // Partial title match - only match when cached job title CONTAINS target title
    // NOT the reverse (which caused "Air Filter" to match "Cabin Air Filter")
    else if (targetTitle && targetTitle.length > 5 && normalizedJobTitle.includes(targetTitle)) {
      matched = true;
      matchType = 'partial title';
    }
    
    if (matched && job.lines && job.lines.length > 0) {
      console.log(`[Protractor Cache] Found matching job (${matchType}): "${jobTitle}" with ${job.lines.length} lines from WO#${job.workOrderNumber}`);
      
      // Convert cached lines to Protractor format
      const protractorLines = job.lines.map((line: any) => ({
        lineType: line.lineType === 'labor' ? 'Labor' : 'Material',
        description: line.description,
        partNumber: line.partNumber,
        manufacturer: line.manufacturer,
        quantity: line.quantity || 1,
        unitPrice: line.unitPrice || 0,
        extendedPrice: line.extendedPrice || 0,
      }));
      
      return {
        found: true,
        lines: protractorLines,
        source: `cached from WO#${job.workOrderNumber}`,
        workOrderNumber: job.workOrderNumber,
        performedAt: job.performedAt,
      };
    }
  }
  
  console.log(`[Protractor Cache] No matching job found for "${options.jobTitle}" (code: ${options.jobCode})`);
  return { found: false };
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
  const rawVin = workOrder.ServiceItem?.VIN 
    || workOrder.ServiceItem?.Lookup 
    || (workOrder as any).VIN 
    || null;
  const vin = rawVin ? String(rawVin).trim().toUpperCase() : null;
  
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
  
  const woInUsage = workOrder.InUsage && workOrder.InUsage > 0 ? workOrder.InUsage : null;

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
        serviceItemId: workOrder.ServiceItemID ?? workOrder.ServiceItem?.ID ?? null,
        contactId: workOrder.ContactID ?? workOrder.Contact?.ID ?? null,
        contactName,
        companyName,
        odometer: woInUsage,
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

  if (vin) {
    const si = workOrder.ServiceItem || {} as any;
    let year = si.Year ?? null;
    let make = si.Make ?? null;
    let model = si.Model ?? null;

    if (!year && !make && !model && vin.length === 17) {
      try {
        const { decodeVinLocal } = await import("@/lib/integrations/dataone-local");
        const decoded = await decodeVinLocal(vin);
        if (decoded.ok && decoded.decoded) {
          year = decoded.decoded.year ?? null;
          make = decoded.decoded.make ?? null;
          model = decoded.decoded.model ?? null;
        }
      } catch (decodeErr: any) {
        console.error(`[Protractor Snapshot] VIN decode fallback error for ${vin}:`, decodeErr.message);
      }
    }

    const vehicleUpdate: Record<string, any> = {
      shopId,
      vin,
      year,
      make,
      model,
      protractorId: si.ID ?? null,
      licensePlate: si.LicensePlate ?? null,
      updatedAt: now,
    };
    if (woInUsage) {
      vehicleUpdate.mileage = woInUsage;
      vehicleUpdate.odometer = woInUsage;
    }
    await db.collection("protractor_vehicles").updateOne(
      { shopId, vin },
      {
        $set: vehicleUpdate,
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
  }
}

export async function upsertProtractorInvoiceSnapshot(
  shopId: number,
  invoice: ProtractorInvoice
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const rawVin = invoice.ServiceItem?.VIN 
    || invoice.ServiceItem?.Lookup 
    || null;
  const vin = rawVin ? String(rawVin).trim().toUpperCase() : null;
  
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

const TEMPLATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TEMPLATE_404_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for 404s

export async function fetchServicePackageTemplateDetail(
  shopId: number,
  templateId: string
): Promise<{ ok: boolean; template?: ProtractorServicePackageTemplate; error?: string; cached?: boolean }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const db = await getDb();
  const cacheKey = `protractor_template_${shopId}_${templateId}`;
  
  // Check cache first
  const cached = await db.collection("protractor_template_cache").findOne({ 
    cacheKey,
    expiresAt: { $gt: new Date() }
  });
  
  if (cached) {
    if (cached.is404) {
      return { ok: false, error: "Template not found (cached 404)", cached: true };
    }
    if (cached.template) {
      return { ok: true, template: cached.template, cached: true };
    }
  }

  // Try the most reliable endpoint first (skip noisy fallbacks)
  const result = await protractorFetch<ProtractorServicePackageTemplate | { ServicePackageTemplate?: ProtractorServicePackageTemplate }>(
    `/ServicePackageTemplate/Read/${templateId}`,
    config,
    {},
    0,
    shopId
  );

  if (result.ok && result.data) {
    const template = (result.data as any).ServicePackageTemplate || result.data;
    
    if (template.ID) {
      // Cache successful response
      await db.collection("protractor_template_cache").updateOne(
        { cacheKey },
        { 
          $set: { 
            cacheKey,
            template,
            is404: false,
            shopId,
            templateId,
            fetchedAt: new Date(),
            expiresAt: new Date(Date.now() + TEMPLATE_CACHE_TTL_MS)
          }
        },
        { upsert: true }
      );
      return { ok: true, template };
    }
  }
  
  // Check if this is a 404 response
  const is404 = result.error?.includes("404") || result.error?.includes("not found");
  
  if (is404) {
    // Cache 404 to avoid repeated requests
    await db.collection("protractor_template_cache").updateOne(
      { cacheKey },
      { 
        $set: { 
          cacheKey,
          is404: true,
          template: null,
          shopId,
          templateId,
          fetchedAt: new Date(),
          expiresAt: new Date(Date.now() + TEMPLATE_404_TTL_MS)
        }
      },
      { upsert: true }
    );
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
    
    if (!template) {
      console.log(`[Protractor] No template found, using direct WorkOrder update to add service package "${cannedJobCode}"...`);
      
      const newServicePackage = {
        ID: "00000000-0000-0000-0000-000000000000",
        Code: cannedJobCode,
        ServicePackageHeader: {
          Title: cannedJobTitle || cannedJobCode,
          Description: "[Added by MOS]",
        },
        ServicePackageLines: { ItemCollection: [] },
      };
      
      const existingPackagesRaw = existingWorkOrder.ServicePackages as any;
      const existingPackages = Array.isArray(existingPackagesRaw) 
        ? existingPackagesRaw 
        : (existingPackagesRaw?.ItemCollection || []);

      const cleanedPkgs = existingPackages.map(cleanServicePackageForPost);

      const minimalWorkOrder = buildMinimalWorkOrderPayload(
        existingWorkOrder as Record<string, any>,
        [...cleanedPkgs, newServicePackage]
      );
      
      console.log(`[Protractor] POSTing minimal work order update with ${cleanedPkgs.length} existing + 1 new service package...`);
      console.log(`[Protractor] Payload keys:`, Object.keys(minimalWorkOrder).join(', '));
      
      const updateResult = await protractorFetch<any>(
        `/WorkOrder/${workOrderGuid}`,
        config,
        {
          method: "POST",
          body: JSON.stringify(minimalWorkOrder)
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
          console.log(`[Protractor] WARNING: API returned OK but service package "${cannedJobCode}" not found in response. Packages in response: ${JSON.stringify(responsePackages).substring(0, 300)}`);
          return {
            ok: false,
            error: `Service package was not confirmed by Protractor. The API accepted the request but the package "${cannedJobTitle || cannedJobCode}" was not found in the updated work order.`
          };
        }
      } else {
        console.log(`[Protractor] WorkOrder update failed: ${updateResult.error}`);
        return {
          ok: false,
          error: `Failed to add service package: ${updateResult.error}`
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
  
  const stripStatusDeep = (obj: any): any => {
    if (Array.isArray(obj)) return obj.map(stripStatusDeep);
    if (obj && typeof obj === 'object') {
      const cleaned: any = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'Status') continue;
        cleaned[k] = stripStatusDeep(v);
      }
      return cleaned;
    }
    return obj;
  };

  const cleanedExistingPackages = stripStatusDeep(existingPackages);
  const fullWorkOrderPayload = {
    ...existingWorkOrder,
    ID: workOrderGuid,
    ServicePackages: {
      ItemCollection: [
        ...cleanedExistingPackages,
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
  
  delete (fullWorkOrderPayload as any).Status;

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
  
  // Generate a new GUID for the work order - crypto.randomUUID() creates a v4 UUID
  const newWorkOrderId = crypto.randomUUID();
  
  // Per Protractor API docs section 1.9.3:
  // - POST to /WorkOrder/{workOrderID} with a new GUID
  // - Set WorkOrderNumber to 0 for new work orders
  // - "If the work order exists by ID then the work order will be updated. 
  //    Otherwise a new work order will be created."
  // Note: Protractor expects nested objects for Contact and ServiceItem, not just IDs
  const body: Record<string, any> = {
    ID: newWorkOrderId,
    WorkOrderNumber: 0,  // Required for new work orders
    Type: "Appointment",
    Contact: { ID: contactId },
    ServiceItem: { ID: vehicleId },
    ScheduledTime: scheduledTime,
  };
  
  // Duration is passed in minutes but Protractor expects hours
  if (duration) body.Duration = duration / 60;
  if (notes) body.Note = notes;  // Field is "Note" not "Notes"
  if (serviceAdvisorId) body.ServiceAdvisor = { ID: serviceAdvisorId };
  
  console.log(`[Protractor] POST /WorkOrder/${newWorkOrderId} with body:`, JSON.stringify(body));
  
  const result = await protractorFetch<ProtractorWorkOrder>(
    `/WorkOrder/${newWorkOrderId}`,
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

  // Fetch the current work order (priority = user-initiated)
  const existingResult = await protractorFetch<ProtractorWorkOrder>(
    `/WorkOrder/${workOrderGuid}`,
    config,
    {},
    0,
    shopId,
    { priority: true }
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

  // Debug: Log work order fields to find vehicle ID
  const woAny = existingWorkOrder as any;
  console.log(`[Protractor] Work order fields for vehicle lookup:`, JSON.stringify({
    ServiceItemID: existingWorkOrder.ServiceItemID,
    ServiceItem: woAny.ServiceItem ? { ID: woAny.ServiceItem.ID, VIN: woAny.ServiceItem.VIN } : null,
    ContactID: existingWorkOrder.ContactID,
    allTopLevelKeys: Object.keys(existingWorkOrder).slice(0, 20)
  }, null, 2));

  // Try to get service package lines from the deferred item directly, or fetch from original work order
  let originalServicePackageLines: any[] = [];
  
  // Log the deferred item details for debugging
  console.log(`[Protractor] Deferred item details:`, JSON.stringify({
    ID: deferredItem.ID,
    ServiceItemID: deferredItem.ServiceItemID,
    OriginalWorkOrderID: deferredItem.OriginalWorkOrderID,
    Code: deferredItem.Code,
    Title: deferredItem.Title,
    hasEstimatedCost: !!deferredItem.EstimatedCost,
    estimatedCost: deferredItem.EstimatedCost,
    allKeys: Object.keys(deferredItem)
  }, null, 2));
  
  // First, try to get ServicePackageLines directly from the deferred item (the API sometimes includes them)
  const deferredItemAny = deferredItem as any;
  
  // Log what ServicePackageLines actually contains
  console.log(`[Protractor] ServicePackageLines on deferred item:`, JSON.stringify(deferredItemAny.ServicePackageLines, null, 2));
  
  if (deferredItemAny.ServicePackageLines) {
    const linesRaw = deferredItemAny.ServicePackageLines;
    if (Array.isArray(linesRaw)) {
      originalServicePackageLines = linesRaw;
    } else if (linesRaw?.ItemCollection) {
      originalServicePackageLines = linesRaw.ItemCollection;
    }
    
    if (originalServicePackageLines.length > 0) {
      console.log(`[Protractor] Found ${originalServicePackageLines.length} lines directly on deferred item`);
      originalServicePackageLines.forEach((line: any, i: number) => {
        console.log(`[Protractor]   Line ${i}: ${line.LineType || 'Unknown'} - "${line.Description}" Qty:${line.Quantity} Price:${line.UnitPrice}`);
      });
    } else {
      console.log(`[Protractor] ServicePackageLines exists but is empty (array/ItemCollection length = 0)`);
    }
  }
  
  // If no lines found on the deferred item, try to fetch from original work order
  if (originalServicePackageLines.length === 0 && deferredItem.OriginalWorkOrderID) {
    console.log(`[Protractor] Fetching original work order ${deferredItem.OriginalWorkOrderID} for deferred work details...`);
    
    const originalWoResult = await protractorFetch<ProtractorWorkOrder>(
      `/WorkOrder/${deferredItem.OriginalWorkOrderID}`,
      config,
      {},
      0,
      shopId,
      { priority: true }
    );
    
    if (originalWoResult.ok && originalWoResult.data) {
      const originalWo = originalWoResult.data;
      const originalPackagesRaw = originalWo.ServicePackages as any;
      const originalPackages = Array.isArray(originalPackagesRaw) 
        ? originalPackagesRaw 
        : (originalPackagesRaw?.ItemCollection || []);
      
      console.log(`[Protractor] Original work order has ${originalPackages.length} service packages`);
      
      // Log all package titles for debugging
      originalPackages.forEach((pkg: any, i: number) => {
        const pkgTitle = pkg.ServicePackageHeader?.Title || pkg.Title || pkg.Code || 'Unknown';
        const linesRaw = pkg.ServicePackageLines;
        const lineCount = Array.isArray(linesRaw) ? linesRaw.length : (linesRaw?.ItemCollection?.length || 0);
        console.log(`[Protractor]   Package ${i}: "${pkgTitle}" (ID: ${pkg.ID}, Lines: ${lineCount})`);
      });
      
      // Find the matching service package by ID or title (case-insensitive)
      // Priority: exact ID match > exact title match > exact code match > partial title match
      const titleLower = title.toLowerCase();
      const codeLower = (deferredItem.Code || '').toLowerCase();
      
      // First try exact matches
      let matchingPackage = originalPackages.find((pkg: any) => {
        const pkgTitle = (pkg.ServicePackageHeader?.Title || pkg.Title || '').toLowerCase();
        const pkgCode = (pkg.Code || '').toLowerCase();
        return (
          pkg.ID === deferredItem.ID || 
          pkgTitle === titleLower ||
          (codeLower && pkgCode === codeLower)
        );
      });
      
      // If no exact match, try partial matches (only where pkg title contains search term, not reverse)
      if (!matchingPackage) {
        matchingPackage = originalPackages.find((pkg: any) => {
          const pkgTitle = (pkg.ServicePackageHeader?.Title || pkg.Title || '').toLowerCase();
          // Only match if the package title contains our search term
          // NOT the reverse (which caused "Air Filter" to match "Cabin Air Filter")
          return pkgTitle.includes(titleLower);
        });
      }
      
      if (matchingPackage) {
        // Extract the service package lines (labor and parts)
        const linesRaw = matchingPackage.ServicePackageLines;
        if (Array.isArray(linesRaw)) {
          originalServicePackageLines = linesRaw;
        } else if (linesRaw?.ItemCollection) {
          originalServicePackageLines = linesRaw.ItemCollection;
        }
        
        console.log(`[Protractor] Found matching package with ${originalServicePackageLines.length} lines`);
        
        // Log line details
        originalServicePackageLines.forEach((line: any, i: number) => {
          console.log(`[Protractor]   Line ${i}: ${line.LineType || 'Unknown'} - "${line.Description}" Qty:${line.Quantity} Price:${line.UnitPrice}`);
        });
      } else {
        console.log(`[Protractor] Could not find matching service package. Looking for: "${title}" or code: "${deferredItem.Code}"`);
      }
    } else {
      console.log(`[Protractor] Failed to fetch original work order: ${originalWoResult.error}`);
    }
  } else if (originalServicePackageLines.length === 0) {
    console.log(`[Protractor] No OriginalWorkOrderID on deferred item and no lines found directly - searching closed work orders...`);
  }
  
  // If still no lines, search the vehicle's job history from CACHED data (job_index)
  // This uses already-backfilled invoice data instead of making live API calls
  // Use vehicle ServiceItemID from deferred item OR from the work order we're adding to
  // Note: Work order has ServiceItem.ID (nested), not ServiceItemID (flat)
  const vehicleServiceItemId = deferredItem.ServiceItemID || existingWorkOrder.ServiceItemID || woAny.ServiceItem?.ID;
  
  if (originalServicePackageLines.length === 0) {
    console.log(`[Protractor] Searching cached job history for service package matching: "${title}" (code: ${deferredItem.Code})`);
    console.log(`[Protractor] Vehicle ServiceItemID: ${vehicleServiceItemId || 'N/A'}, VIN: ${vin}`);
    
    // Use cached job_index data instead of live API calls
    const cachedResult = await findCachedJobPricing(shopId, {
      serviceItemId: vehicleServiceItemId,
      vin: vin,
      jobTitle: title,
      jobCode: deferredItem.Code,
    });
    
    if (cachedResult.found && cachedResult.lines && cachedResult.lines.length > 0) {
      console.log(`[Protractor] Using cached pricing (${cachedResult.source}) with ${cachedResult.lines.length} lines:`);
      
      // Convert cached lines to Protractor ServicePackageLine format
      originalServicePackageLines = cachedResult.lines.map((line, i) => {
        console.log(`[Protractor]   Line ${i}: ${line.lineType} - "${line.description}" Qty:${line.quantity} Price:$${line.unitPrice}`);
        return {
          Type: line.lineType === 'Labor' ? 'Labor' : 'Material',
          Description: line.description,
          PartNumber: line.partNumber || '',
          Manufacturer: line.manufacturer || '',
          Quantity: line.quantity,
          Price: line.unitPrice,
          Total: line.extendedPrice,
          ExtendedTotal: line.extendedPrice,
        };
      });
    } else {
      console.log(`[Protractor] No cached job pricing found for "${title}"`);
    }
  }
  
  // Note: /ServicePackage/DeferredWorks endpoint does NOT exist in Protractor API (returns 404)
  // Skip that fallback and go straight to ServicePackageTemplate
  
  // If still no lines, try fetching from ServicePackageTemplate (canned job) - last resort
  if (originalServicePackageLines.length === 0 && deferredItemAny.ServicePackageTemplateID) {
    const templateId = deferredItemAny.ServicePackageTemplateID;
    console.log(`[Protractor] Trying to fetch ServicePackageTemplate (fallback): ${templateId}`);
    
    const templateResult = await protractorFetch<any>(
      `/ServicePackageTemplate/${templateId}`,
      config,
      {},
      0,
      shopId
    );
    
    if (templateResult.ok && templateResult.data) {
      const templateLinesRaw = templateResult.data.ServicePackageLines;
      const templateLines = Array.isArray(templateLinesRaw) 
        ? templateLinesRaw 
        : (templateLinesRaw?.ItemCollection || []);
      
      if (templateLines.length > 0) {
        originalServicePackageLines = templateLines;
        console.log(`[Protractor] Found ${templateLines.length} lines from ServicePackageTemplate`);
        console.log(`[Protractor] Template raw response keys:`, Object.keys(templateResult.data));
        templateLines.forEach((line: any, i: number) => {
          console.log(`[Protractor]   Line ${i} keys:`, Object.keys(line));
          console.log(`[Protractor]   Line ${i} raw:`, JSON.stringify(line, null, 2));
        });
      } else {
        console.log(`[Protractor] ServicePackageTemplate exists but has no lines`);
      }
    } else {
      console.log(`[Protractor] Failed to fetch ServicePackageTemplate: ${templateResult.error}`);
    }
  }

  // Create new service package for the active work order
  // Use Chapter: "Service" and Status: "Pending" to add to active work order (NOT deferred section)
  // Get description from ServicePackageHeader (where Protractor stores it)
  const originalDescription = deferredItem.ServicePackageHeader?.Description 
    || deferredItem.Description 
    || "";
  const packageDescription = originalDescription 
    ? `${originalDescription}\n[Previously Deferred - Added by MOS]`
    : "[Previously Deferred - Added by MOS]";
  
  const newServicePackage = {
    ID: "00000000-0000-0000-0000-000000000000",
    Code: deferredItem.Code || title,
    ServicePackageHeader: {
      Title: title,
      Description: packageDescription,
    },
    // Include the original labor and parts lines
    ServicePackageLines: { 
      ItemCollection: originalServicePackageLines.map(({ Status: _s, ...line }: any) => ({
        ...line,
        ID: "00000000-0000-0000-0000-000000000000",
      }))
    },
    Chapter: "Service",
  };

  const cleanedExistingPackages = existingPackages.map(cleanServicePackageForPost);
  const updatedPackages = [...cleanedExistingPackages, newServicePackage];
  
  const updatedWorkOrder = buildMinimalWorkOrderPayload(
    existingWorkOrder as Record<string, any>,
    updatedPackages
  );

  console.log(`[Protractor] Adding deferred work "${title}" to work order ${workOrderGuid} with ${originalServicePackageLines.length} lines...`);
  console.log(`[Protractor] Payload keys:`, Object.keys(updatedWorkOrder).join(', '));

  const updateResult = await protractorFetch<any>(
    `/WorkOrder/${workOrderGuid}`,
    config,
    {
      method: "POST",
      body: JSON.stringify(updatedWorkOrder)
    },
    0,
    shopId,
    { priority: true }
  );

  if (updateResult.ok) {
    console.log(`[Protractor] Successfully added deferred work "${title}" with all details`);
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
