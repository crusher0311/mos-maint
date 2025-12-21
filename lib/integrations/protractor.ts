import "server-only";
import crypto from "node:crypto";
import { getDb } from "@/lib/mongo";

const BASE_URL = "https://integration.protractor.com/IntegrationServices/2.0";

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

export async function resolveProtractorConfig(shopId: number): Promise<ProtractorConfig> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
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

async function protractorFetch<T>(
  endpoint: string,
  config: ProtractorConfig,
  options: RequestInit = {}
): Promise<{ ok: boolean; data?: T; error?: string }> {
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured" };
  }

  const url = `${BASE_URL}${endpoint}`;
  
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        connectionId: config.connectionId,
        apiKey: config.apiKey,
        authentication: config.authentication,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
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
    config
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
    config
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

  const params = new URLSearchParams();
  if (options?.startDate) params.set("startDate", options.startDate);
  if (options?.endDate) params.set("endDate", options.endDate);
  if (options?.readInProgress !== undefined) {
    params.set("readInProgress", String(options.readInProgress));
  }

  const queryStr = params.toString() ? `?${params.toString()}` : "";
  const result = await protractorFetch<{ ItemCollection?: ProtractorWorkOrder[] }>(
    `/WorkOrder/${queryStr}`,
    config
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, workOrders: result.data?.ItemCollection || [] };
}

export async function fetchWorkOrderById(
  shopId: number,
  workOrderId: string
): Promise<{ ok: boolean; workOrder?: ProtractorWorkOrder; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const result = await protractorFetch<ProtractorWorkOrder>(
    `/WorkOrder/${workOrderId}`,
    config
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, workOrder: result.data };
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
    config
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
    config
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
    config
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
  
  await db.collection("protractor_work_orders").updateOne(
    { shopId, workOrderId: workOrder.ID },
    {
      $set: {
        shopId,
        workOrderId: workOrder.ID,
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
        fetchedAt: now,
        source: "protractor",
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

  const endpoints = [
    "/ServicePackage/",
    "/ServicePackage/Search/",
    "/ServicePackage/CannedJob",
  ];

  for (const endpoint of endpoints) {
    const result = await protractorFetch<{ ItemCollection?: ProtractorCannedJob[] }>(
      endpoint,
      config
    );

    if (result.ok && result.data?.ItemCollection?.length) {
      return { ok: true, cannedJobs: result.data.ItemCollection };
    }
  }

  return { 
    ok: false, 
    error: "Could not fetch canned jobs from Protractor. The Canned Jobs API endpoint may not be available for your account. Please contact Protractor support to verify API access." 
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
    config
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, cannedJob: result.data };
}

export async function applyCannedJobToWorkOrder(
  shopId: number,
  workOrderId: string,
  cannedJobCode: string
): Promise<{ ok: boolean; servicePackage?: ProtractorServicePackage; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured for this shop" };
  }

  const endpoints = [
    `/WorkOrder/${workOrderId}/ServicePackage/${encodeURIComponent(cannedJobCode)}`,
    `/WorkOrder/${workOrderId}/ServicePackage/Code/${encodeURIComponent(cannedJobCode)}`,
    `/WorkOrder/${workOrderId}/ServicePackage/CannedJob/${encodeURIComponent(cannedJobCode)}`,
  ];

  for (const endpoint of endpoints) {
    const result = await protractorFetch<ProtractorServicePackage>(
      endpoint,
      config,
      { method: "POST" }
    );

    if (result.ok) {
      return { ok: true, servicePackage: result.data };
    }
  }

  return { ok: false, error: "Failed to apply service package to work order. Please verify the code is correct." };
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

  const result = await protractorFetch<{ ItemCollection?: ProtractorWorkOrder[] }>(
    `/ServiceItem/${serviceItemId}/WorkOrder`,
    config
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  let workOrders = result.data?.ItemCollection || [];
  
  if (options?.includeOpen) {
    workOrders = workOrders.filter(wo => !wo.Completed);
  }

  return { ok: true, workOrders };
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

export async function fetchCannedJobsWithCache(
  shopId: number,
  maxAgeMs = CACHE_TTL_HOURS * 60 * 60 * 1000
): Promise<{ ok: boolean; cannedJobs?: any[]; error?: string; source?: "cache" | "api" }> {
  const db = await getDb();
  const cached = await db.collection("protractor_canned_jobs").findOne({ shopId });

  const now = Date.now();
  const fresh = cached?.fetchedAt
    ? now - new Date(cached.fetchedAt).getTime() <= maxAgeMs
    : false;

  if (fresh && cached) {
    return {
      ok: true,
      cannedJobs: cached.items || [],
      source: "cache",
    };
  }

  const result = await fetchCannedJobs(shopId);
  if (result.ok && result.cannedJobs) {
    await upsertCannedJobsCache(shopId, result.cannedJobs);
    return {
      ok: true,
      cannedJobs: result.cannedJobs.map(job => ({
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
      source: "api",
    };
  }

  return { ok: false, error: result.error };
}
