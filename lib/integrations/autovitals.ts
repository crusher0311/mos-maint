import { getDb } from "../mongo";

export interface AutoVitalsConfig {
  shopId: number;
  userId?: number;
  sessionCookie: string;
  jwtToken?: string;
}

export interface AutoVitalsCredentials {
  welcomeCode: string;
  personalCode: string;
}

export interface AutoVitalsVehicle {
  vehicleId: number;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  mileage?: number;
  licensePlate?: string;
  color?: string;
  customerId?: number;
  customerName?: string;
}

export interface AutoVitalsAppointment {
  appointmentId: number;
  vehicleId: number;
  vin?: string;
  customerId?: number;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  status?: string;
  promisedTime?: string;
  dropOffTime?: string;
  serviceAdvisorId?: number;
  serviceAdvisorName?: string;
  technicianId?: number;
  technicianName?: string;
  concern?: string;
  mileageIn?: number;
  vehicle?: AutoVitalsVehicle;
}

export interface AutoVitalsInspectionItem {
  id: number;
  name: string;
  category?: string;
  status: "green" | "yellow" | "red";
  notes?: string;
  techNotes?: string;
  photos?: string[];
  videos?: string[];
}

export interface AutoVitalsInspectionResult {
  inspectionResultId: number;
  appointmentId: number;
  completedAt?: string;
  technicianId?: number;
  technicianName?: string;
  items: AutoVitalsInspectionItem[];
}

export interface AutoVitalsJob {
  jobId: number;
  appointmentId: number;
  code?: string;
  title: string;
  description?: string;
  laborHours?: number;
  laborRate?: number;
  partsTotal?: number;
  total?: number;
  status?: string;
  approved?: boolean;
  declined?: boolean;
  declinedReason?: string;
}

const AUTOVITALS_BASE_URL = "https://tvpx.autovitals.com";
const AUTOVITALS_SHOP_URL = "https://shop.autovitals.com";

async function autovitalsFetch<T>(
  endpoint: string,
  config: AutoVitalsConfig,
  options: {
    method?: string;
    body?: any;
    useShopUrl?: boolean;
    useFormData?: boolean;
  } = {}
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const { method = "POST", body, useShopUrl = false, useFormData = false } = options;
  const baseUrl = useShopUrl ? AUTOVITALS_SHOP_URL : AUTOVITALS_BASE_URL;
  const url = `${baseUrl}${endpoint}`;

  const headers: Record<string, string> = {
    accept: "application/json, text/javascript, */*; q=0.01",
    "x-requested-with": "XMLHttpRequest",
  };

  if (useFormData) {
    headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
  } else {
    headers["content-type"] = "application/json; charset=UTF-8";
  }

  if (config.sessionCookie) {
    headers["cookie"] = config.sessionCookie;
  }

  if (config.jwtToken) {
    headers["authorization"] = `Bearer ${config.jwtToken}`;
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: useFormData ? body : (body ? JSON.stringify(body) : undefined),
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const data = await response.json();
    
    if (data.d !== undefined) {
      return { ok: true, data: typeof data.d === "string" ? JSON.parse(data.d) : data.d };
    }
    
    return { ok: true, data };
  } catch (error) {
    console.error(`[AutoVitals] Error calling ${endpoint}:`, error);
    return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export async function getVehicle(
  vehicleId: number,
  config: AutoVitalsConfig
): Promise<{ ok: true; data: AutoVitalsVehicle } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Fetching vehicle ${vehicleId}`);
  
  const result = await autovitalsFetch<any>(
    "/TvpxService.asmx/GetData?sp=Vehicle_Get",
    config,
    {
      body: {
        spName: "Vehicle_Get",
        request: { vehicleId }
      }
    }
  );

  if (!result.ok) return result;

  const data = result.data;
  const vehicle: AutoVitalsVehicle = {
    vehicleId: data.VehicleId || data.vehicleId || vehicleId,
    vin: data.VIN || data.Vin || data.vin,
    year: data.Year || data.year,
    make: data.Make || data.make,
    model: data.Model || data.model,
    mileage: data.Mileage || data.mileage || data.Odometer || data.odometer,
    licensePlate: data.LicensePlate || data.licensePlate,
    color: data.Color || data.color,
    customerId: data.CustomerId || data.customerId,
    customerName: data.CustomerName || data.customerName,
  };

  return { ok: true, data: vehicle };
}

export async function getAppointment(
  appointmentId: number,
  config: AutoVitalsConfig
): Promise<{ ok: true; data: AutoVitalsAppointment } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Fetching appointment ${appointmentId}`);
  
  const result = await autovitalsFetch<any>(
    "/TvpxService.asmx/GetData?sp=Appointment_Get_AdditionalInfo",
    config,
    {
      body: {
        spName: "Appointment_Get_AdditionalInfo",
        request: { appointmentId }
      }
    }
  );

  if (!result.ok) return result;

  const data = result.data;
  const appointment: AutoVitalsAppointment = {
    appointmentId: data.AppointmentId || data.appointmentId || appointmentId,
    vehicleId: data.VehicleId || data.vehicleId,
    vin: data.VIN || data.Vin || data.vin,
    customerId: data.CustomerId || data.customerId,
    customerName: data.CustomerName || data.customerName,
    customerPhone: data.CustomerPhone || data.customerPhone,
    customerEmail: data.CustomerEmail || data.customerEmail,
    status: data.Status || data.status,
    promisedTime: data.PromisedTime || data.promisedTime,
    dropOffTime: data.DropOffTime || data.dropOffTime,
    serviceAdvisorId: data.ServiceAdvisorId || data.serviceAdvisorId,
    serviceAdvisorName: data.ServiceAdvisorName || data.serviceAdvisorName,
    technicianId: data.TechnicianId || data.technicianId,
    technicianName: data.TechnicianName || data.technicianName,
    concern: data.Concern || data.concern,
    mileageIn: data.MileageIn || data.mileageIn || data.Odometer || data.odometer,
  };

  return { ok: true, data: appointment };
}

export async function getInspectionResults(
  appointmentId: number,
  config: AutoVitalsConfig
): Promise<{ ok: true; data: AutoVitalsInspectionResult } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Fetching inspection results for appointment ${appointmentId}`);
  
  const result = await autovitalsFetch<any>(
    "/TvpxService.asmx/GetData?sp=InspectionResults_Get",
    config,
    {
      body: {
        spName: "InspectionResults_Get",
        request: { appointmentId }
      }
    }
  );

  if (!result.ok) return result;

  const data = result.data;
  const items: AutoVitalsInspectionItem[] = [];

  if (Array.isArray(data.Items || data.items || data)) {
    const rawItems = data.Items || data.items || data;
    for (const item of rawItems) {
      const statusNum = item.Status ?? item.status ?? item.Condition ?? item.condition;
      let status: "green" | "yellow" | "red" = "green";
      if (statusNum === 0 || statusNum === "red" || statusNum === "Red") status = "red";
      else if (statusNum === 1 || statusNum === "yellow" || statusNum === "Yellow") status = "yellow";

      items.push({
        id: item.Id || item.id || item.ItemId || item.itemId,
        name: item.Name || item.name || item.Title || item.title,
        category: item.Category || item.category || item.CategoryName || item.categoryName,
        status,
        notes: item.Notes || item.notes,
        techNotes: item.TechNotes || item.techNotes,
        photos: item.Photos || item.photos || [],
        videos: item.Videos || item.videos || [],
      });
    }
  }

  return {
    ok: true,
    data: {
      inspectionResultId: data.InspectionResultId || data.inspectionResultId || 0,
      appointmentId,
      completedAt: data.CompletedAt || data.completedAt,
      technicianId: data.TechnicianId || data.technicianId,
      technicianName: data.TechnicianName || data.technicianName,
      items,
    }
  };
}

export async function getRepairOrderJobs(
  appointmentId: number,
  config: AutoVitalsConfig
): Promise<{ ok: true; data: AutoVitalsJob[] } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Fetching RO jobs for appointment ${appointmentId}`);
  
  const result = await autovitalsFetch<any>(
    "/TvpxService.asmx/GetData?sp=VehicleRepairOrderJobs_Get",
    config,
    {
      body: {
        spName: "VehicleRepairOrderJobs_Get",
        request: { appointmentId }
      }
    }
  );

  if (!result.ok) return result;

  const jobs: AutoVitalsJob[] = [];
  const rawJobs = Array.isArray(result.data) ? result.data : (result.data?.Jobs || result.data?.jobs || []);

  for (const job of rawJobs) {
    jobs.push({
      jobId: job.JobId || job.jobId || job.Id || job.id,
      appointmentId,
      code: job.Code || job.code,
      title: job.Title || job.title || job.Name || job.name,
      description: job.Description || job.description,
      laborHours: job.LaborHours || job.laborHours,
      laborRate: job.LaborRate || job.laborRate,
      partsTotal: job.PartsTotal || job.partsTotal,
      total: job.Total || job.total,
      status: job.Status || job.status,
      approved: job.Approved || job.approved,
      declined: job.Declined || job.declined,
      declinedReason: job.DeclinedReason || job.declinedReason,
    });
  }

  return { ok: true, data: jobs };
}

export async function getAppointmentUpdates(
  config: AutoVitalsConfig,
  timestamp?: number,
  lastUpdate?: string
): Promise<{ ok: true; data: AutoVitalsAppointment[] } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Fetching appointment updates`);
  
  const result = await autovitalsFetch<any>(
    "/TvpxService.asmx/GetData?sp=Appointments_GetUpdates",
    config,
    {
      body: {
        spName: "Appointments_GetUpdates",
        request: {
          timestamp: timestamp || Date.now(),
          lastUpdate: lastUpdate || new Date().toISOString(),
          techView: true,
          userId: config.userId || 0,
          isAvSupport: false
        }
      }
    }
  );

  if (!result.ok) return result;

  const appointments: AutoVitalsAppointment[] = [];
  const rawAppointments = Array.isArray(result.data) ? result.data : (result.data?.Appointments || []);

  for (const apt of rawAppointments) {
    appointments.push({
      appointmentId: apt.AppointmentId || apt.appointmentId || apt.Id || apt.id,
      vehicleId: apt.VehicleId || apt.vehicleId,
      vin: apt.VIN || apt.Vin || apt.vin,
      customerId: apt.CustomerId || apt.customerId,
      customerName: apt.CustomerName || apt.customerName,
      customerPhone: apt.CustomerPhone || apt.customerPhone,
      status: apt.Status || apt.status,
      promisedTime: apt.PromisedTime || apt.promisedTime,
      serviceAdvisorId: apt.ServiceAdvisorId || apt.serviceAdvisorId,
      technicianId: apt.TechnicianId || apt.technicianId,
      concern: apt.Concern || apt.concern,
      mileageIn: apt.MileageIn || apt.mileageIn,
    });
  }

  return { ok: true, data: appointments };
}

export async function getTechInfo(
  config: AutoVitalsConfig
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Fetching tech info`);
  
  return autovitalsFetch<any>(
    "/TvpxService.asmx/GetData?sp=TechInfo_Get2",
    config,
    {
      body: {
        spName: "TechInfo_Get2",
        request: {}
      }
    }
  );
}

export async function getServerSettings(
  config: AutoVitalsConfig
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Fetching server settings`);
  
  return autovitalsFetch<any>(
    "/TvpxService.asmx/GetServerSettingsUpdates",
    config,
    { body: null }
  );
}

export async function cacheAutoVitalsVehicle(
  vehicle: AutoVitalsVehicle,
  shopId: string
): Promise<void> {
  const db = await getDb();
  const collection = db.collection("autovitals_vehicles");

  await collection.updateOne(
    { vehicleId: vehicle.vehicleId, shopId },
    {
      $set: {
        ...vehicle,
        shopId,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      }
    },
    { upsert: true }
  );
}

export async function cacheAutoVitalsAppointment(
  appointment: AutoVitalsAppointment,
  shopId: string
): Promise<void> {
  const db = await getDb();
  const collection = db.collection("autovitals_appointments");

  await collection.updateOne(
    { appointmentId: appointment.appointmentId, shopId },
    {
      $set: {
        ...appointment,
        shopId,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      }
    },
    { upsert: true }
  );
}

export async function cacheAutoVitalsInspection(
  inspection: AutoVitalsInspectionResult,
  shopId: string
): Promise<void> {
  const db = await getDb();
  const collection = db.collection("autovitals_inspections");

  await collection.updateOne(
    { appointmentId: inspection.appointmentId, shopId },
    {
      $set: {
        ...inspection,
        shopId,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      }
    },
    { upsert: true }
  );
}

export async function getCachedAutoVitalsVehicleByVin(
  vin: string,
  shopId: string
): Promise<AutoVitalsVehicle | null> {
  const db = await getDb();
  const collection = db.collection("autovitals_vehicles");
  return collection.findOne({ vin, shopId }) as Promise<AutoVitalsVehicle | null>;
}

export async function getCachedAutoVitalsInspection(
  appointmentId: number,
  shopId: string
): Promise<AutoVitalsInspectionResult | null> {
  const db = await getDb();
  const collection = db.collection("autovitals_inspections");
  return collection.findOne({ appointmentId, shopId }) as Promise<AutoVitalsInspectionResult | null>;
}

export async function getShopAutoVitalsConfig(shopId: string): Promise<AutoVitalsConfig | null> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne({ _id: shopId });
  
  if (!shop?.autovitals?.shopId || !shop?.autovitals?.sessionCookie) {
    return null;
  }

  return {
    shopId: shop.autovitals.shopId,
    userId: shop.autovitals.userId,
    sessionCookie: shop.autovitals.sessionCookie,
    jwtToken: shop.autovitals.jwtToken,
  };
}

export async function testAutoVitalsConnection(
  config: AutoVitalsConfig
): Promise<{ ok: true; shopName?: string } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Testing connection for shop ${config.shopId}`);
  
  const result = await getServerSettings(config);
  
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { 
    ok: true, 
    shopName: result.data?.ShopName || result.data?.shopName 
  };
}

export async function loginWithCodes(
  credentials: AutoVitalsCredentials
): Promise<{ ok: true; config: AutoVitalsConfig; shopName?: string } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Logging in with welcome code`);
  
  const { welcomeCode, personalCode } = credentials;
  
  if (!welcomeCode || !personalCode) {
    return { ok: false, error: "Welcome code and personal code are required" };
  }
  
  try {
    const loginUrl = `${AUTOVITALS_BASE_URL}/TvpxService.asmx/LoginStart`;
    
    const response = await fetch(loginUrl, {
      method: "POST",
      headers: {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/json; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify({
        welcomeCode: welcomeCode.trim(),
        personalCode: personalCode.trim(),
      }),
    });
    
    if (!response.ok) {
      return { ok: false, error: `Login failed: HTTP ${response.status}` };
    }
    
    const setCookieHeader = response.headers.get("set-cookie");
    const data = await response.json();
    
    const parsedData = data.d ? (typeof data.d === "string" ? JSON.parse(data.d) : data.d) : data;
    
    if (parsedData.Error || parsedData.error) {
      return { ok: false, error: parsedData.Error || parsedData.error || "Login failed" };
    }
    
    const shopId = parsedData.ShopId || parsedData.shopId || parsedData.sid;
    const userId = parsedData.UserId || parsedData.userId || parsedData.uid;
    const shopName = parsedData.ShopName || parsedData.shopName;
    
    if (!shopId) {
      return { ok: false, error: "Login succeeded but no shop ID returned. Please verify your codes." };
    }
    
    let sessionCookie = setCookieHeader || "";
    
    if (!sessionCookie && parsedData.SessionId) {
      sessionCookie = `ASP.NET_SessionId=${parsedData.SessionId}`;
    }
    
    if (!sessionCookie) {
      return { ok: false, error: "Login succeeded but no session was established. Please try again." };
    }
    
    const config: AutoVitalsConfig = {
      shopId,
      userId,
      sessionCookie,
    };
    
    return { ok: true, config, shopName };
    
  } catch (error) {
    console.error("[AutoVitals] Login error:", error);
    return { ok: false, error: error instanceof Error ? error.message : "Login failed" };
  }
}

export async function resolveAutoVitalsConfig(
  shopId: number
): Promise<{ configured: boolean; config?: AutoVitalsConfig }> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId });
  
  if (!shop?.autovitals?.shopId || !shop?.autovitals?.sessionCookie) {
    return { configured: false };
  }

  return {
    configured: true,
    config: {
      shopId: shop.autovitals.shopId,
      userId: shop.autovitals.userId,
      sessionCookie: shop.autovitals.sessionCookie,
      jwtToken: shop.autovitals.jwtToken,
    },
  };
}

export async function fetchAutoVitalsInspectionByVin(
  shopId: number,
  vin: string,
  ttlMs: number = 6 * 60 * 60 * 1000
): Promise<{ ok: true; inspection: AutoVitalsInspectionResult; items: AutoVitalsInspectionItem[] } | { ok: false; error: string }> {
  const db = await getDb();
  const shopIdStr = String(shopId);
  const vinUpper = vin.toUpperCase();
  
  // First check cache for recent inspection by VIN
  const cachedVehicle = await db.collection("autovitals_vehicles").findOne({
    shopId: shopIdStr,
    vin: { $regex: new RegExp(`^${vinUpper}$`, 'i') }
  });
  
  if (!cachedVehicle?.vehicleId) {
    return { ok: false, error: "Vehicle not found in AutoVitals cache. Run sync first." };
  }
  
  // Find the most recent appointment for this vehicle
  const cachedAppointment = await db.collection("autovitals_appointments").findOne(
    { shopId: shopIdStr, vehicleId: cachedVehicle.vehicleId },
    { sort: { updatedAt: -1 } }
  );
  
  if (!cachedAppointment?.appointmentId) {
    return { ok: false, error: "No appointment found for this vehicle in AutoVitals." };
  }
  
  // Check cache for inspection
  const cachedInspection = await db.collection("autovitals_inspections").findOne({
    shopId: shopIdStr,
    appointmentId: cachedAppointment.appointmentId
  });
  
  const cacheAge = cachedInspection?.updatedAt 
    ? Date.now() - new Date(cachedInspection.updatedAt).getTime() 
    : Infinity;
  
  if (cachedInspection && cacheAge < ttlMs && cachedInspection.items?.length > 0) {
    console.log(`[AutoVitals] Using cached inspection for VIN ${vin}, age: ${Math.round(cacheAge / 1000 / 60)}m`);
    return {
      ok: true,
      inspection: cachedInspection as AutoVitalsInspectionResult,
      items: cachedInspection.items || []
    };
  }
  
  // Fetch fresh from API
  const configResult = await resolveAutoVitalsConfig(shopId);
  if (!configResult.configured || !configResult.config) {
    return { ok: false, error: "AutoVitals not configured for this shop." };
  }
  
  const inspectionResult = await getInspectionResults(cachedAppointment.appointmentId, configResult.config);
  
  if (!inspectionResult.ok) {
    return { ok: false, error: inspectionResult.error };
  }
  
  // Cache the result
  await cacheAutoVitalsInspection(inspectionResult.data, shopIdStr);
  
  return {
    ok: true,
    inspection: inspectionResult.data,
    items: inspectionResult.data.items || []
  };
}
