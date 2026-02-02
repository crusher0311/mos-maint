import sql from "@/lib/db/postgres";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { getMaintenanceScheduleLocal, decodeVinLocal } from "@/lib/integrations/dataone-local";

const DATAONE_API_BASE = process.env.DATAONE_API_URL || "http://3.144.191.161:3000";
const CACHE_TTL_HOURS = 24 * 7;
const FETCH_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

interface VinReferenceData {
  vin_id: number;
  vehicle_id: number;
  vin_pattern: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  style: string;
  mfr_model_num: string | null;
  doors: number;
  drive_type: string;
  vehicle_type: string;
  body_type: string;
  body_subtype: string;
  bed_length: string | null;
  engine_id: number;
  engine_name: string;
  engine_size: number;
  engine_block: string;
  engine_cylinders: number;
  engine_valves: number;
  engine_induction: string;
  engine_aspiration: string;
  engine_cam_type: string;
  fuel_type: string;
  trans_id: number;
  trans_name: string;
  trans_type: string;
  trans_speeds: number;
  wheelbase: number;
  gross_vehicle_weight_range: string;
  restraint_type: string;
  brake_system: string;
  country_of_mfr: string;
  plant: string;
}

interface MaintenanceItem {
  maintenance_id: number;
  maintenance_category: string;
  maintenance_name: string;
  maintenance_notes: string | null;
  intervals: {
    interval_id: number;
    interval_type: string;
    value: number;
    units: string;
    initial_value: number;
  }[];
  miles: number | null;
  months: number | null;
}

interface DataOneApiResponse<T> {
  data: T[];
  total: number;
  limit: number;
  skip: number;
}

function toSquish(vin: string): string {
  const v = String(vin).toUpperCase().trim();
  return v.slice(0, 8) + v.slice(9, 11);
}

export async function decodeVin(vin: string): Promise<{
  ok: boolean;
  vin: string;
  decoded?: VinReferenceData;
  error?: string;
}> {
  try {
    const squish = toSquish(vin);
    const url = `${DATAONE_API_BASE}/api/data/VIN_REFERENCE?vin_pattern__regex=^${squish}&limit=1`;
    const startTime = Date.now();
    
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    trackApiRequest('dataone', '/VIN_REFERENCE', 'GET', response.status, Date.now() - startTime).catch(() => {});

    if (!response.ok) {
      return { ok: false, vin, error: `API error: ${response.status}` };
    }

    const result: DataOneApiResponse<VinReferenceData> = await response.json();
    
    if (result.data.length === 0) {
      return { ok: false, vin, error: "VIN not found in database" };
    }

    return { ok: true, vin, decoded: result.data[0] };
  } catch (error) {
    console.error("DataOne VIN decode error:", error);
    return { ok: false, vin, error: String(error) };
  }
}

export async function getMaintenanceSchedule(vin: string): Promise<{
  ok: boolean;
  vin: string;
  squish: string;
  count: number;
  items: MaintenanceItem[];
  error?: string;
}> {
  try {
    const squish = toSquish(vin);
    const startTime = Date.now();
    
    const vinMaintenanceUrl = `${DATAONE_API_BASE}/api/data/LKP_VIN_MAINTENANCE?squish=${squish}&limit=500`;
    const vinMaintenanceResponse = await fetchWithTimeout(vinMaintenanceUrl);
    
    trackApiRequest('dataone', '/LKP_VIN_MAINTENANCE', 'GET', vinMaintenanceResponse.status, Date.now() - startTime).catch(() => {});
    
    if (!vinMaintenanceResponse.ok) {
      return { ok: false, vin, squish, count: 0, items: [], error: `API error: ${vinMaintenanceResponse.status}` };
    }

    const vinMaintenanceData = await vinMaintenanceResponse.json();
    
    if (vinMaintenanceData.data.length === 0) {
      return { ok: false, vin, squish, count: 0, items: [], error: "No maintenance data found for this VIN" };
    }

    const maintenanceIds = [...new Set(vinMaintenanceData.data.map((d: Record<string, unknown>) => d.maintenance_id))];
    const vinMaintenanceIds = vinMaintenanceData.data.map((d: Record<string, unknown>) => d.vin_maintenance_id);

    const [maintenanceDefsResponse, intervalsResponse] = await Promise.all([
      fetchWithTimeout(`${DATAONE_API_BASE}/api/data/DEF_MAINTENANCE?maintenance_id__in=${maintenanceIds.join(",")}&limit=500`),
      fetchWithTimeout(`${DATAONE_API_BASE}/api/data/LKP_VIN_MAINTENANCE_INTERVAL?vin_maintenance_id__in=${vinMaintenanceIds.join(",")}&limit=1000`)
    ]);

    const maintenanceDefs = await maintenanceDefsResponse.json();
    const intervals = await intervalsResponse.json();

    const intervalIds = [...new Set(intervals.data.map((d: Record<string, unknown>) => d.maintenance_interval_id).filter((id: number) => id > 0))];
    
    let intervalDefs: Record<string, unknown>[] = [];
    if (intervalIds.length > 0) {
      const intervalDefsResponse = await fetchWithTimeout(`${DATAONE_API_BASE}/api/data/DEF_MAINTENANCE_INTERVAL?maintenance_interval_id__in=${intervalIds.join(",")}&limit=500`);
      const intervalDefsData = await intervalDefsResponse.json();
      intervalDefs = intervalDefsData.data;
    }

    const maintenanceDefMap = new Map<number, Record<string, unknown>>(maintenanceDefs.data.map((d: Record<string, unknown>) => [d.maintenance_id as number, d]));
    const intervalDefMap = new Map<number, Record<string, unknown>>(intervalDefs.map((d) => [d.maintenance_interval_id as number, d]));
    
    const vinMaintenanceMap = new Map<number, Record<string, unknown>>();
    for (const vm of vinMaintenanceData.data) {
      vinMaintenanceMap.set(vm.vin_maintenance_id, vm);
    }

    const itemsMap = new Map<number, MaintenanceItem>();
    
    for (const vm of vinMaintenanceData.data) {
      const def = maintenanceDefMap.get(vm.maintenance_id);
      if (!def) continue;

      if (!itemsMap.has(vm.maintenance_id)) {
        itemsMap.set(vm.maintenance_id, {
          maintenance_id: vm.maintenance_id,
          maintenance_category: (def.maintenance_category as string) || "General",
          maintenance_name: (def.maintenance_name as string) || "Unknown",
          maintenance_notes: def.maintenance_notes as string | null,
          intervals: [],
          miles: null,
          months: null,
        });
      }
    }

    for (const interval of intervals.data) {
      const vm = vinMaintenanceMap.get(interval.vin_maintenance_id);
      if (!vm) continue;

      const item = itemsMap.get(vm.maintenance_id as number);
      if (!item) continue;

      const intervalDef = intervalDefMap.get(interval.maintenance_interval_id);
      if (intervalDef) {
        item.intervals.push({
          interval_id: intervalDef.maintenance_interval_id as number,
          interval_type: intervalDef.interval_type as string,
          value: intervalDef.value as number,
          units: intervalDef.units as string,
          initial_value: intervalDef.initial_value as number,
        });

        if (intervalDef.units === "Miles" && (item.miles === null || (intervalDef.value as number) < item.miles)) {
          item.miles = intervalDef.value as number;
        }
        if (intervalDef.units === "Months" && (item.months === null || (intervalDef.value as number) < item.months)) {
          item.months = intervalDef.value as number;
        }
      }
    }

    const items = Array.from(itemsMap.values()).sort((a, b) => {
      const catCompare = a.maintenance_category.localeCompare(b.maintenance_category);
      if (catCompare !== 0) return catCompare;
      return a.maintenance_name.localeCompare(b.maintenance_name);
    });

    return { ok: true, vin, squish, count: items.length, items };
  } catch (error) {
    console.error("DataOne maintenance schedule error:", error);
    return { ok: false, vin, squish: toSquish(vin), count: 0, items: [], error: String(error) };
  }
}

export async function getEnhancedVehicleData(vin: string): Promise<{
  ok: boolean;
  vin: string;
  vehicle?: {
    year: number;
    make: string;
    model: string;
    trim: string;
    style: string;
    engine: string;
    transmission: string;
    driveType: string;
    bodyType: string;
    fuelType: string;
    cylinders: number;
    doors: number;
  };
  error?: string;
}> {
  // Use local PostgreSQL lookup instead of external API
  const decoded = await decodeVinLocal(vin);
  
  if (!decoded.ok || !decoded.decoded) {
    return { ok: false, vin, error: decoded.error };
  }

  const d = decoded.decoded;
  
  return {
    ok: true,
    vin,
    vehicle: {
      year: d.year,
      make: d.make,
      model: d.model,
      trim: d.trim,
      style: d.style,
      engine: d.engine_name,
      transmission: d.trans_name,
      driveType: d.drive_type,
      bodyType: d.body_type,
      fuelType: d.fuel_type === "G" ? "Gasoline" : d.fuel_type === "D" ? "Diesel" : d.fuel_type === "E" ? "Electric" : d.fuel_type,
      cylinders: d.engine_cylinders,
      doors: d.doors,
    },
  };
}

interface CachedMaintenanceData {
  squish: string;
  vin: string;
  data: {
    ok: boolean;
    count: number;
    items: MaintenanceItem[];
    error?: string;
  };
  vehicle?: {
    year: number;
    make: string;
    model: string;
    engine: string;
  };
  fetchedAt: Date;
  expiresAt: Date;
  source: "api" | "cache";
}

export async function getMaintenanceScheduleCached(vin: string): Promise<{
  ok: boolean;
  vin: string;
  squish: string;
  count: number;
  items: MaintenanceItem[];
  vehicle?: {
    year: number;
    make: string;
    model: string;
    engine: string;
  };
  error?: string;
  source: "api" | "cache";
  cachedAt?: Date;
}> {
  const squish = toSquish(vin);
  const now = new Date();
  
  try {
    const result = await sql`
      SELECT * FROM dataone_cache WHERE squish = ${squish} LIMIT 1
    `;
    const cached = result[0] as CachedMaintenanceData | undefined;
    
    if (cached && new Date(cached.expiresAt) > now && cached.vehicle) {
      console.log(`[DataOne Cache] HIT for squish ${squish}, cached at ${new Date(cached.fetchedAt).toISOString()}`);
      return {
        ok: cached.data.ok,
        vin,
        squish,
        count: cached.data.count,
        items: cached.data.items,
        vehicle: cached.vehicle,
        error: cached.data.error,
        source: "cache",
        cachedAt: new Date(cached.fetchedAt),
      };
    }
    
    if (cached && new Date(cached.expiresAt) > now && !cached.vehicle) {
      console.log(`[DataOne Cache] HIT but missing vehicle info for squish ${squish}, re-fetching...`);
    }
    
    console.log(`[DataOne Cache] ${cached ? 'EXPIRED' : 'MISS'} for squish ${squish}, fetching from local PostgreSQL...`);
    
    const [localResult, decoded] = await Promise.all([
      getMaintenanceScheduleLocal(vin),
      decodeVinLocal(vin)
    ]);
    
    const vehicleInfo = decoded.ok && decoded.decoded ? {
      year: decoded.decoded.year,
      make: decoded.decoded.make,
      model: decoded.decoded.model,
      engine: decoded.decoded.engine_name,
    } : undefined;
    
    const expiresAt = new Date(now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000);
    
    await sql`
      INSERT INTO dataone_cache (squish, vin, data, vehicle, fetched_at, expires_at, source)
      VALUES (${squish}, ${vin}, ${JSON.stringify({
        ok: localResult.ok,
        count: localResult.count,
        items: localResult.items,
        error: localResult.error,
      })}::jsonb, ${JSON.stringify(vehicleInfo || null)}::jsonb, ${now}, ${expiresAt}, 'cache')
      ON CONFLICT (squish) DO UPDATE SET
        vin = ${vin},
        data = ${JSON.stringify({
          ok: localResult.ok,
          count: localResult.count,
          items: localResult.items,
          error: localResult.error,
        })}::jsonb,
        vehicle = ${JSON.stringify(vehicleInfo || null)}::jsonb,
        fetched_at = ${now},
        expires_at = ${expiresAt},
        source = 'cache'
    `;
    
    console.log(`[DataOne Cache] Stored ${localResult.count} items for squish ${squish} from local DB, expires ${expiresAt.toISOString()}`);
    
    return {
      ok: localResult.ok,
      vin,
      squish,
      count: localResult.count,
      items: localResult.items,
      vehicle: vehicleInfo,
      error: localResult.error,
      source: "cache",
    };
  } catch (error) {
    console.error("[DataOne Cache] Error:", error);
    const localResult = await getMaintenanceScheduleLocal(vin);
    return {
      ...localResult,
      source: "cache",
    };
  }
}

export async function invalidateMaintenanceCache(vin: string): Promise<boolean> {
  try {
    const squish = toSquish(vin);
    const result = await sql`DELETE FROM dataone_cache WHERE squish = ${squish}`;
    console.log(`[DataOne Cache] Invalidated cache for squish ${squish}`);
    return (result as unknown[]).length > 0;
  } catch (error) {
    console.error("[DataOne Cache] Failed to invalidate:", error);
    return false;
  }
}

export async function getCacheStats(): Promise<{
  totalCached: number;
  expiredCount: number;
  recentHits: number;
}> {
  try {
    const now = new Date();
    
    const [totalResult, expiredResult] = await Promise.all([
      sql`SELECT COUNT(*) as count FROM dataone_cache`,
      sql`SELECT COUNT(*) as count FROM dataone_cache WHERE expires_at <= ${now}`,
    ]);
    
    return { 
      totalCached: Number(totalResult[0]?.count) || 0, 
      expiredCount: Number(expiredResult[0]?.count) || 0, 
      recentHits: 0 
    };
  } catch (error) {
    console.error("[DataOne Cache] Stats error:", error);
    return { totalCached: 0, expiredCount: 0, recentHits: 0 };
  }
}
