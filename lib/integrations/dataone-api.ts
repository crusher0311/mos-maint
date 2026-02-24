// lib/integrations/dataone-api.ts
// Integration with external DataOne API for VIN decoding and maintenance schedules
// Includes MongoDB Atlas caching to avoid repeated API calls

import { getDb } from "@/lib/mongo";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { getMaintenanceScheduleLocal, decodeVinLocal } from "@/lib/integrations/dataone-local";

const DATAONE_API_BASE = process.env.DATAONE_API_URL || "http://3.144.191.161:3000";
const CACHE_TTL_HOURS = 24 * 7; // Cache for 7 days (OEM data rarely changes)
const FETCH_TIMEOUT_MS = 5000; // 5 second timeout for API calls

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

    const maintenanceIds = [...new Set(vinMaintenanceData.data.map((d: any) => d.maintenance_id))];
    const vinMaintenanceIds = vinMaintenanceData.data.map((d: any) => d.vin_maintenance_id);

    const [maintenanceDefsResponse, intervalsResponse] = await Promise.all([
      fetchWithTimeout(`${DATAONE_API_BASE}/api/data/DEF_MAINTENANCE?maintenance_id__in=${maintenanceIds.join(",")}&limit=500`),
      fetchWithTimeout(`${DATAONE_API_BASE}/api/data/LKP_VIN_MAINTENANCE_INTERVAL?vin_maintenance_id__in=${vinMaintenanceIds.join(",")}&limit=1000`)
    ]);

    const maintenanceDefs = await maintenanceDefsResponse.json();
    const intervals = await intervalsResponse.json();

    const intervalIds = [...new Set(intervals.data.map((d: any) => d.maintenance_interval_id).filter((id: number) => id > 0))];
    
    let intervalDefs: any[] = [];
    if (intervalIds.length > 0) {
      const intervalDefsResponse = await fetchWithTimeout(`${DATAONE_API_BASE}/api/data/DEF_MAINTENANCE_INTERVAL?maintenance_interval_id__in=${intervalIds.join(",")}&limit=500`);
      const intervalDefsData = await intervalDefsResponse.json();
      intervalDefs = intervalDefsData.data;
    }

    const maintenanceDefMap = new Map<number, any>(maintenanceDefs.data.map((d: any) => [d.maintenance_id, d]));
    const intervalDefMap = new Map<number, any>(intervalDefs.map((d: any) => [d.maintenance_interval_id, d]));
    
    const vinMaintenanceMap = new Map<number, any>();
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
          maintenance_category: def.maintenance_category || "General",
          maintenance_name: def.maintenance_name || "Unknown",
          maintenance_notes: def.maintenance_notes,
          intervals: [],
          miles: null,
          months: null,
        });
      }
    }

    for (const interval of intervals.data) {
      const vm = vinMaintenanceMap.get(interval.vin_maintenance_id);
      if (!vm) continue;

      const item = itemsMap.get(vm.maintenance_id);
      if (!item) continue;

      const intervalDef = intervalDefMap.get(interval.maintenance_interval_id);
      if (intervalDef) {
        item.intervals.push({
          interval_id: intervalDef.maintenance_interval_id,
          interval_type: intervalDef.interval_type,
          value: intervalDef.value,
          units: intervalDef.units,
          initial_value: intervalDef.initial_value,
        });

        if (intervalDef.units === "Miles" && (item.miles === null || intervalDef.value < item.miles)) {
          item.miles = intervalDef.value;
        }
        if (intervalDef.units === "Months" && (item.months === null || intervalDef.value < item.months)) {
          item.months = intervalDef.value;
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
  const decoded = await decodeVin(vin);
  
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

// ============================================================================
// CACHING LAYER - MongoDB Atlas cache for DataOne API responses
// ============================================================================

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
    const db = await getDb();
    const cacheCollection = db.collection<CachedMaintenanceData>("dataone_cache");
    
    // Check for cached data
    const cached = await cacheCollection.findOne({ squish });
    
    if (cached && cached.expiresAt > now && cached.vehicle) {
      const cachedHasIntervals = cached.data.items?.some((item: any) => item.miles || item.months);
      const isErrorResult = !cached.data.ok && cached.data.count === 0 && cached.data.error;
      const cachedAgeMs = now.getTime() - new Date(cached.fetchedAt).getTime();
      const isStaleEmpty = cached.data.count === 0 && cachedAgeMs > 24 * 60 * 60 * 1000;
      if (isErrorResult) {
        console.log(`[DataOne Cache] HIT but cached error result for squish ${squish} (${cached.data.error}), re-fetching...`);
      } else if (isStaleEmpty) {
        console.log(`[DataOne Cache] HIT but empty result cached ${Math.round(cachedAgeMs / 3600000)}h ago for squish ${squish}, re-fetching...`);
      } else if (cachedHasIntervals || cached.data.count === 0) {
        console.log(`[DataOne Cache] HIT for squish ${squish}, cached at ${cached.fetchedAt.toISOString()}`);
        return {
          ok: cached.data.ok,
          vin,
          squish,
          count: cached.data.count,
          items: cached.data.items,
          vehicle: cached.vehicle,
          error: cached.data.error,
          source: "cache",
          cachedAt: cached.fetchedAt,
        };
      } else {
        console.log(`[DataOne Cache] HIT but cached data has ${cached.data.count} items with NO intervals for squish ${squish}, re-fetching...`);
      }
    }
    
    // If cache hit but missing vehicle info, mark for re-fetch
    if (cached && cached.expiresAt > now && !cached.vehicle) {
      console.log(`[DataOne Cache] HIT but missing vehicle info for squish ${squish}, re-fetching...`);
    }
    
    // Cache miss or expired - fetch from LOCAL PostgreSQL database (fast!)
    console.log(`[DataOne Cache] ${cached ? 'EXPIRED' : 'MISS'} for squish ${squish}, fetching from local PostgreSQL...`);
    
    // Fetch both maintenance schedule and vehicle decode from local database in parallel
    const [localResult, decoded] = await Promise.all([
      getMaintenanceScheduleLocal(vin),
      decodeVinLocal(vin)
    ]);
    
    // Extract vehicle info from decode
    const vehicleInfo = decoded.ok && decoded.decoded ? {
      year: decoded.decoded.year,
      make: decoded.decoded.make,
      model: decoded.decoded.model,
      engine: decoded.decoded.engine_name,
    } : undefined;
    
    // Check if local data has intervals - if items exist but none have miles/months, fall back to API
    const hasUsableIntervals = localResult.items.some(item => item.miles || item.months);
    let finalItems = localResult.items;
    let finalCount = localResult.count;
    let finalOk = localResult.ok;
    let finalError = localResult.error;
    let dataSource: "cache" | "api" = "cache";
    
    if (localResult.ok && localResult.count > 0 && !hasUsableIntervals) {
      console.log(`[DataOne Cache] Local data has ${localResult.count} items but NO intervals, falling back to external API...`);
      try {
        const apiResult = await getMaintenanceSchedule(vin);
        if (apiResult.ok && apiResult.items.length > 0) {
          const apiHasIntervals = apiResult.items.some(item => item.miles || item.months);
          if (apiHasIntervals) {
            console.log(`[DataOne Cache] API returned ${apiResult.count} items WITH intervals for squish ${squish}`);
            finalItems = apiResult.items;
            finalCount = apiResult.count;
            finalOk = apiResult.ok;
            finalError = apiResult.error;
            dataSource = "api";
          } else {
            console.log(`[DataOne Cache] API also returned no intervals for squish ${squish}, using local data`);
          }
        }
      } catch (apiErr) {
        console.warn(`[DataOne Cache] API fallback failed for squish ${squish}:`, apiErr);
      }
    }
    
    const isDbError = !finalOk && finalError && (
      finalError.includes("endpoint has been disabled") ||
      finalError.includes("endpoint is disabled") ||
      finalError.includes("unavailable after retries") ||
      finalError.includes("Connection terminated") ||
      finalError.includes("ECONNREFUSED") ||
      finalError.includes("timeout")
    );

    if (isDbError && finalCount === 0) {
      console.warn(`[DataOne Cache] Skipping cache store for squish ${squish} — DB unavailable, would cache empty result`);
      return {
        ok: false,
        vin,
        squish,
        count: 0,
        items: [],
        vehicle: vehicleInfo,
        error: finalError,
        source: "cache",
      };
    }

    const expiresAt = new Date(now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000);
    
    await cacheCollection.updateOne(
      { squish },
      {
        $set: {
          squish,
          vin,
          data: {
            ok: finalOk,
            count: finalCount,
            items: finalItems,
            error: finalError,
          },
          vehicle: vehicleInfo,
          fetchedAt: now,
          expiresAt,
          source: dataSource,
        },
      },
      { upsert: true }
    );
    
    console.log(`[DataOne Cache] Stored ${finalCount} items for squish ${squish} from ${dataSource}, expires ${expiresAt.toISOString()}`);
    
    return {
      ok: finalOk,
      vin,
      squish,
      count: finalCount,
      items: finalItems,
      vehicle: vehicleInfo,
      error: finalError,
      source: dataSource,
    };
  } catch (error) {
    console.error("[DataOne Cache] Error:", error);
    // Fallback to direct local database call if cache layer fails
    const localResult = await getMaintenanceScheduleLocal(vin);
    return {
      ...localResult,
      source: "local" as "api" | "cache",
    };
  }
}

export async function invalidateMaintenanceCache(vin: string): Promise<boolean> {
  try {
    const squish = toSquish(vin);
    const db = await getDb();
    const result = await db.collection("dataone_cache").deleteOne({ squish });
    console.log(`[DataOne Cache] Invalidated cache for squish ${squish}`);
    return result.deletedCount > 0;
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
    const db = await getDb();
    const cacheCollection = db.collection("dataone_cache");
    const now = new Date();
    
    const [totalCached, expiredCount] = await Promise.all([
      cacheCollection.countDocuments(),
      cacheCollection.countDocuments({ expiresAt: { $lte: now } }),
    ]);
    
    return { totalCached, expiredCount, recentHits: 0 };
  } catch (error) {
    console.error("[DataOne Cache] Stats error:", error);
    return { totalCached: 0, expiredCount: 0, recentHits: 0 };
  }
}
