import sql from "@/lib/db/postgres";

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
    body?: unknown;
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
      body: useFormData ? (body as string) : (body ? JSON.stringify(body) : undefined),
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
  
  const result = await autovitalsFetch<Record<string, unknown>>(
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
    vehicleId: (data.VehicleId || data.vehicleId || vehicleId) as number,
    vin: (data.VIN || data.Vin || data.vin) as string,
    year: (data.Year || data.year) as number,
    make: (data.Make || data.make) as string,
    model: (data.Model || data.model) as string,
    mileage: (data.Mileage || data.mileage || data.Odometer || data.odometer) as number,
    licensePlate: (data.LicensePlate || data.licensePlate) as string,
    color: (data.Color || data.color) as string,
    customerId: (data.CustomerId || data.customerId) as number,
    customerName: (data.CustomerName || data.customerName) as string,
  };

  return { ok: true, data: vehicle };
}

export async function getAppointment(
  appointmentId: number,
  config: AutoVitalsConfig
): Promise<{ ok: true; data: AutoVitalsAppointment } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Fetching appointment ${appointmentId}`);
  
  const result = await autovitalsFetch<Record<string, unknown>>(
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
    appointmentId: (data.AppointmentId || data.appointmentId || appointmentId) as number,
    vehicleId: (data.VehicleId || data.vehicleId) as number,
    vin: (data.VIN || data.Vin || data.vin) as string,
    customerId: (data.CustomerId || data.customerId) as number,
    customerName: (data.CustomerName || data.customerName) as string,
    customerPhone: (data.CustomerPhone || data.customerPhone) as string,
    customerEmail: (data.CustomerEmail || data.customerEmail) as string,
    status: (data.Status || data.status) as string,
    promisedTime: (data.PromisedTime || data.promisedTime) as string,
    dropOffTime: (data.DropOffTime || data.dropOffTime) as string,
    serviceAdvisorId: (data.ServiceAdvisorId || data.serviceAdvisorId) as number,
    serviceAdvisorName: (data.ServiceAdvisorName || data.serviceAdvisorName) as string,
    technicianId: (data.TechnicianId || data.technicianId) as number,
    technicianName: (data.TechnicianName || data.technicianName) as string,
    concern: (data.Concern || data.concern) as string,
    mileageIn: (data.MileageIn || data.mileageIn || data.Odometer || data.odometer) as number,
  };

  return { ok: true, data: appointment };
}

export async function getInspectionResults(
  appointmentId: number,
  config: AutoVitalsConfig
): Promise<{ ok: true; data: AutoVitalsInspectionResult } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Fetching inspection results for appointment ${appointmentId}`);
  
  const result = await autovitalsFetch<Record<string, unknown>>(
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
    const rawItems = (data.Items || data.items || data) as Record<string, unknown>[];
    for (const item of rawItems) {
      const statusNum = item.Status ?? item.status ?? item.Condition ?? item.condition;
      let status: "green" | "yellow" | "red" = "green";
      if (statusNum === 0 || statusNum === "red" || statusNum === "Red") status = "red";
      else if (statusNum === 1 || statusNum === "yellow" || statusNum === "Yellow") status = "yellow";

      items.push({
        id: (item.Id || item.id || item.ItemId || item.itemId) as number,
        name: (item.Name || item.name || item.Title || item.title) as string,
        category: (item.Category || item.category || item.CategoryName || item.categoryName) as string,
        status,
        notes: (item.Notes || item.notes) as string,
        techNotes: (item.TechNotes || item.techNotes) as string,
        photos: (item.Photos || item.photos || []) as string[],
        videos: (item.Videos || item.videos || []) as string[],
      });
    }
  }

  return {
    ok: true,
    data: {
      inspectionResultId: (data.InspectionResultId || data.inspectionResultId || 0) as number,
      appointmentId,
      completedAt: (data.CompletedAt || data.completedAt) as string,
      technicianId: (data.TechnicianId || data.technicianId) as number,
      technicianName: (data.TechnicianName || data.technicianName) as string,
      items,
    }
  };
}

export async function getRepairOrderJobs(
  appointmentId: number,
  config: AutoVitalsConfig
): Promise<{ ok: true; data: AutoVitalsJob[] } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Fetching RO jobs for appointment ${appointmentId}`);
  
  const result = await autovitalsFetch<Record<string, unknown>>(
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
  const rawJobs = Array.isArray(result.data) ? result.data : ((result.data?.Jobs || result.data?.jobs || []) as Record<string, unknown>[]);

  for (const job of rawJobs) {
    jobs.push({
      jobId: (job.JobId || job.jobId || job.Id || job.id) as number,
      appointmentId,
      code: (job.Code || job.code) as string,
      title: (job.Title || job.title || job.Name || job.name) as string,
      description: (job.Description || job.description) as string,
      laborHours: (job.LaborHours || job.laborHours) as number,
      laborRate: (job.LaborRate || job.laborRate) as number,
      partsTotal: (job.PartsTotal || job.partsTotal) as number,
      total: (job.Total || job.total) as number,
      status: (job.Status || job.status) as string,
      approved: (job.Approved || job.approved) as boolean,
      declined: (job.Declined || job.declined) as boolean,
      declinedReason: (job.DeclinedReason || job.declinedReason) as string,
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
  
  const result = await autovitalsFetch<Record<string, unknown>>(
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
  const rawAppointments = Array.isArray(result.data) ? result.data : ((result.data?.Appointments || []) as Record<string, unknown>[]);

  for (const apt of rawAppointments) {
    appointments.push({
      appointmentId: (apt.AppointmentId || apt.appointmentId || apt.Id || apt.id) as number,
      vehicleId: (apt.VehicleId || apt.vehicleId) as number,
      vin: (apt.VIN || apt.Vin || apt.vin) as string,
      customerId: (apt.CustomerId || apt.customerId) as number,
      customerName: (apt.CustomerName || apt.customerName) as string,
      customerPhone: (apt.CustomerPhone || apt.customerPhone) as string,
      status: (apt.Status || apt.status) as string,
      promisedTime: (apt.PromisedTime || apt.promisedTime) as string,
      serviceAdvisorId: (apt.ServiceAdvisorId || apt.serviceAdvisorId) as number,
      technicianId: (apt.TechnicianId || apt.technicianId) as number,
      concern: (apt.Concern || apt.concern) as string,
      mileageIn: (apt.MileageIn || apt.mileageIn) as number,
    });
  }

  return { ok: true, data: appointments };
}

export async function getTechInfo(
  config: AutoVitalsConfig
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Fetching tech info`);
  
  return autovitalsFetch<unknown>(
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
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  console.log(`[AutoVitals] Fetching server settings`);
  
  return autovitalsFetch<Record<string, unknown>>(
    "/TvpxService.asmx/GetServerSettingsUpdates",
    config,
    { body: null }
  );
}

export async function cacheAutoVitalsVehicle(
  vehicle: AutoVitalsVehicle,
  shopId: string
): Promise<void> {
  await sql`
    INSERT INTO autovitals_vehicles (vehicle_id, shop_id, vin, year, make, model, mileage, license_plate, color, customer_id, customer_name, updated_at)
    VALUES (${vehicle.vehicleId}, ${shopId}, ${vehicle.vin || null}, ${vehicle.year || null}, ${vehicle.make || null},
      ${vehicle.model || null}, ${vehicle.mileage || null}, ${vehicle.licensePlate || null}, ${vehicle.color || null},
      ${vehicle.customerId || null}, ${vehicle.customerName || null}, NOW())
    ON CONFLICT (vehicle_id, shop_id) DO UPDATE SET
      vin = COALESCE(${vehicle.vin || null}, autovitals_vehicles.vin),
      year = COALESCE(${vehicle.year || null}, autovitals_vehicles.year),
      make = COALESCE(${vehicle.make || null}, autovitals_vehicles.make),
      model = COALESCE(${vehicle.model || null}, autovitals_vehicles.model),
      mileage = COALESCE(${vehicle.mileage || null}, autovitals_vehicles.mileage),
      license_plate = COALESCE(${vehicle.licensePlate || null}, autovitals_vehicles.license_plate),
      color = COALESCE(${vehicle.color || null}, autovitals_vehicles.color),
      customer_id = COALESCE(${vehicle.customerId || null}, autovitals_vehicles.customer_id),
      customer_name = COALESCE(${vehicle.customerName || null}, autovitals_vehicles.customer_name),
      updated_at = NOW()
  `;
}

export async function cacheAutoVitalsAppointment(
  appointment: AutoVitalsAppointment,
  shopId: string
): Promise<void> {
  await sql`
    INSERT INTO autovitals_appointments (appointment_id, shop_id, vehicle_id, vin, customer_id, customer_name, customer_phone, customer_email,
      status, promised_time, drop_off_time, service_advisor_id, service_advisor_name, technician_id, technician_name, concern, mileage_in, updated_at)
    VALUES (${appointment.appointmentId}, ${shopId}, ${appointment.vehicleId || null}, ${appointment.vin || null},
      ${appointment.customerId || null}, ${appointment.customerName || null}, ${appointment.customerPhone || null},
      ${appointment.customerEmail || null}, ${appointment.status || null}, ${appointment.promisedTime || null},
      ${appointment.dropOffTime || null}, ${appointment.serviceAdvisorId || null}, ${appointment.serviceAdvisorName || null},
      ${appointment.technicianId || null}, ${appointment.technicianName || null}, ${appointment.concern || null},
      ${appointment.mileageIn || null}, NOW())
    ON CONFLICT (appointment_id, shop_id) DO UPDATE SET
      vehicle_id = COALESCE(${appointment.vehicleId || null}, autovitals_appointments.vehicle_id),
      vin = COALESCE(${appointment.vin || null}, autovitals_appointments.vin),
      customer_id = COALESCE(${appointment.customerId || null}, autovitals_appointments.customer_id),
      customer_name = COALESCE(${appointment.customerName || null}, autovitals_appointments.customer_name),
      status = COALESCE(${appointment.status || null}, autovitals_appointments.status),
      updated_at = NOW()
  `;
}

export async function cacheAutoVitalsInspection(
  inspection: AutoVitalsInspectionResult,
  shopId: string
): Promise<void> {
  await sql`
    INSERT INTO autovitals_inspections (appointment_id, shop_id, inspection_result_id, completed_at, technician_id, technician_name, items, updated_at)
    VALUES (${inspection.appointmentId}, ${shopId}, ${inspection.inspectionResultId || null}, ${inspection.completedAt || null},
      ${inspection.technicianId || null}, ${inspection.technicianName || null}, ${JSON.stringify(inspection.items)}::jsonb, NOW())
    ON CONFLICT (appointment_id, shop_id) DO UPDATE SET
      inspection_result_id = COALESCE(${inspection.inspectionResultId || null}, autovitals_inspections.inspection_result_id),
      completed_at = COALESCE(${inspection.completedAt || null}, autovitals_inspections.completed_at),
      technician_id = COALESCE(${inspection.technicianId || null}, autovitals_inspections.technician_id),
      technician_name = COALESCE(${inspection.technicianName || null}, autovitals_inspections.technician_name),
      items = ${JSON.stringify(inspection.items)}::jsonb,
      updated_at = NOW()
  `;
}

export async function getCachedAutoVitalsVehicleByVin(
  vin: string,
  shopId: string
): Promise<AutoVitalsVehicle | null> {
  const vinUpper = vin.toUpperCase();
  const result = await sql`
    SELECT * FROM autovitals_vehicles WHERE shop_id = ${shopId} AND UPPER(vin) = ${vinUpper} LIMIT 1
  `;
  if (!result[0]) return null;
  const row = result[0];
  return {
    vehicleId: row.vehicle_id as number,
    vin: row.vin as string,
    year: row.year as number,
    make: row.make as string,
    model: row.model as string,
    mileage: row.mileage as number,
    licensePlate: row.license_plate as string,
    color: row.color as string,
    customerId: row.customer_id as number,
    customerName: row.customer_name as string,
  };
}

export async function getCachedAutoVitalsInspection(
  appointmentId: number,
  shopId: string
): Promise<AutoVitalsInspectionResult | null> {
  const result = await sql`
    SELECT * FROM autovitals_inspections WHERE shop_id = ${shopId} AND appointment_id = ${appointmentId} LIMIT 1
  `;
  if (!result[0]) return null;
  const row = result[0];
  return {
    inspectionResultId: row.inspection_result_id as number,
    appointmentId: row.appointment_id as number,
    completedAt: row.completed_at as string,
    technicianId: row.technician_id as number,
    technicianName: row.technician_name as string,
    items: (row.items || []) as AutoVitalsInspectionItem[],
  };
}

export async function getShopAutoVitalsConfig(shopId: string | number): Promise<AutoVitalsConfig | null> {
  const shopIdStr = String(shopId);
  const result = await sql`
    SELECT settings FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1
  `;
  
  const shop = result[0];
  const settings = shop?.settings as Record<string, unknown> | undefined;
  const autovitals = settings?.autovitals as Record<string, unknown> | undefined;
  
  if (!autovitals?.shopId || !autovitals?.sessionCookie) {
    return null;
  }

  return {
    shopId: autovitals.shopId as number,
    userId: autovitals.userId as number,
    sessionCookie: autovitals.sessionCookie as string,
    jwtToken: autovitals.jwtToken as string,
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
    shopName: (result.data?.ShopName || result.data?.shopName) as string
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
  shopId: number | string
): Promise<{ configured: boolean; config?: AutoVitalsConfig }> {
  const shopIdStr = String(shopId);
  const result = await sql`
    SELECT settings FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1
  `;
  
  const shop = result[0];
  const settings = shop?.settings as Record<string, unknown> | undefined;
  const autovitals = settings?.autovitals as Record<string, unknown> | undefined;
  
  if (!autovitals?.shopId || !autovitals?.sessionCookie) {
    return { configured: false };
  }

  return {
    configured: true,
    config: {
      shopId: autovitals.shopId as number,
      userId: autovitals.userId as number,
      sessionCookie: autovitals.sessionCookie as string,
      jwtToken: autovitals.jwtToken as string,
    },
  };
}

export async function fetchAutoVitalsInspectionByVin(
  shopId: number | string,
  vin: string,
  ttlMs: number = 6 * 60 * 60 * 1000
): Promise<{ ok: true; inspection: AutoVitalsInspectionResult; items: AutoVitalsInspectionItem[] } | { ok: false; error: string }> {
  const shopIdStr = String(shopId);
  const vinUpper = vin.toUpperCase();
  
  const cachedVehicle = await getCachedAutoVitalsVehicleByVin(vinUpper, shopIdStr);
  
  if (!cachedVehicle?.vehicleId) {
    return { ok: false, error: "Vehicle not found in AutoVitals cache. Run sync first." };
  }
  
  const appointmentResult = await sql`
    SELECT * FROM autovitals_appointments 
    WHERE shop_id = ${shopIdStr} AND vehicle_id = ${cachedVehicle.vehicleId}
    ORDER BY updated_at DESC LIMIT 1
  `;
  
  const cachedAppointment = appointmentResult[0];
  if (!cachedAppointment?.appointment_id) {
    return { ok: false, error: "No appointment found for this vehicle in AutoVitals." };
  }
  
  const inspectionResult = await sql`
    SELECT * FROM autovitals_inspections 
    WHERE shop_id = ${shopIdStr} AND appointment_id = ${cachedAppointment.appointment_id}
    LIMIT 1
  `;
  
  const cachedInspection = inspectionResult[0];
  const cacheAge = cachedInspection?.updated_at 
    ? Date.now() - new Date(cachedInspection.updated_at as string).getTime() 
    : Infinity;
  
  const items = (cachedInspection?.items || []) as AutoVitalsInspectionItem[];
  if (cachedInspection && cacheAge < ttlMs && items.length > 0) {
    console.log(`[AutoVitals] Using cached inspection for VIN ${vin}, age: ${Math.round(cacheAge / 1000 / 60)}m`);
    return {
      ok: true,
      inspection: {
        inspectionResultId: cachedInspection.inspection_result_id as number,
        appointmentId: cachedInspection.appointment_id as number,
        completedAt: cachedInspection.completed_at as string,
        technicianId: cachedInspection.technician_id as number,
        technicianName: cachedInspection.technician_name as string,
        items,
      },
      items,
    };
  }
  
  const configResult = await resolveAutoVitalsConfig(shopId);
  if (!configResult.configured || !configResult.config) {
    return { ok: false, error: "AutoVitals not configured for this shop." };
  }
  
  const freshResult = await getInspectionResults(cachedAppointment.appointment_id as number, configResult.config);
  
  if (!freshResult.ok) {
    return { ok: false, error: freshResult.error };
  }
  
  await cacheAutoVitalsInspection(freshResult.data, shopIdStr);
  
  return {
    ok: true,
    inspection: freshResult.data,
    items: freshResult.data.items || [],
  };
}
