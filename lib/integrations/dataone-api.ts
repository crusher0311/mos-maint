// lib/integrations/dataone-api.ts
// Integration with external DataOne API for VIN decoding and maintenance schedules
// Includes MongoDB Atlas caching to avoid repeated API calls

import { getDb } from "@/lib/mongo";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { getMaintenanceScheduleLocal, decodeVinLocal } from "@/lib/integrations/dataone-local";

const DATAONE_API_BASE = process.env.DATAONE_API_URL || "http://3.144.191.161:3000";
const CACHE_TTL_HOURS = 24 * 7; // Cache for 7 days (OEM data rarely changes)
const FETCH_TIMEOUT_MS = 5000; // 5 second timeout for API calls

// ---------------------------------------------------------------------------
// Circuit breaker for the DataOne lookup path (2026-08-17 incident).
// DataOne's "local" tables live on the SAME Supabase Postgres as the canonical
// app store; when that box gets disk-IO starved, every cache-miss lookup hangs
// for minutes, each plan build pins a web request for its full 15s race
// timeout, builds stack up on the web instances, and unrelated endpoints
// (extension features → print button) start 503ing. Plans already degrade
// gracefully without OEM data (`oemMissing`, short TTL), so during a brownout
// the right move is to fail INSTANTLY, not slowly.
//
// Semantics: cache HITs are always served (they're one indexed read). Only the
// miss/expired fetch path is gated. N consecutive slow/failed fetches open the
// breaker for a cooldown; while open, misses return ok:false immediately. The
// first fetch after cooldown is the probe — success closes the breaker.
// Env: DATAONE_BREAKER_DISABLED=true kill switch;
//      DATAONE_BREAKER_THRESHOLD (default 3 consecutive failures);
//      DATAONE_BREAKER_COOLDOWN_MS (default 10 min);
//      DATAONE_LOCAL_TIMEOUT_MS (default 12000 — deliberately below the
//      plan-builder 15s race so the failure is observed HERE and counted).
const BREAKER_THRESHOLD = Math.max(1, Number(process.env.DATAONE_BREAKER_THRESHOLD) || 3);
const BREAKER_COOLDOWN_MS = Math.max(30_000, Number(process.env.DATAONE_BREAKER_COOLDOWN_MS) || 10 * 60 * 1000);
const LOCAL_FETCH_TIMEOUT_MS = Math.max(2_000, Number(process.env.DATAONE_LOCAL_TIMEOUT_MS) || 12_000);
let breakerConsecutiveFailures = 0;
let breakerOpenUntil = 0;
// Generation guards against late completions from requests that started
// before the breaker opened: their success/failure must not mutate newer
// state. Bumped every time the breaker opens.
let breakerGeneration = 0;
// While open-and-cooldown-expired, exactly ONE request is let through as the
// half-open probe; everyone else keeps failing fast until it reports back.
let breakerProbeInFlight = false;

type BreakerToken = { gen: number; isProbe: boolean };

function breakerEnabled(): boolean {
  return process.env.DATAONE_BREAKER_DISABLED !== "true";
}

/** Returns a token when the caller may attempt the fetch, or null to fail fast. */
function breakerAcquire(): BreakerToken | null {
  if (!breakerEnabled()) return { gen: breakerGeneration, isProbe: false };
  if (breakerOpenUntil === 0) return { gen: breakerGeneration, isProbe: false };
  const now = Date.now();
  if (now < breakerOpenUntil) return null;
  if (breakerProbeInFlight) return null;
  breakerProbeInFlight = true;
  console.log(`[DataOne Breaker] cooldown expired — letting one half-open probe through`);
  return { gen: breakerGeneration, isProbe: true };
}

function breakerRecordSuccess(token: BreakerToken): void {
  if (token.isProbe) breakerProbeInFlight = false;
  if (token.gen !== breakerGeneration) return; // stale pre-open request
  if (breakerConsecutiveFailures > 0 || breakerOpenUntil > 0) {
    console.log(`[DataOne Breaker] lookup healthy again — closing (was ${breakerConsecutiveFailures} consecutive failures)`);
  }
  breakerConsecutiveFailures = 0;
  breakerOpenUntil = 0;
}

function breakerOpen(reason: string): void {
  breakerGeneration++;
  breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
  breakerProbeInFlight = false;
  console.warn(
    `[DataOne Breaker] OPEN for ${Math.round(BREAKER_COOLDOWN_MS / 60000)}min (${reason}) — OEM lookups will fail fast`
  );
}

function breakerRecordFailure(token: BreakerToken, reason: string): void {
  if (token.isProbe) {
    // Probe failed: re-open for another cooldown.
    breakerProbeInFlight = false;
    breakerOpen(`half-open probe failed: ${reason}`);
    return;
  }
  if (token.gen !== breakerGeneration) return; // stale pre-open request
  breakerConsecutiveFailures++;
  if (breakerEnabled() && breakerConsecutiveFailures >= BREAKER_THRESHOLD) {
    breakerOpen(`${breakerConsecutiveFailures} consecutive failures, last: ${reason}`);
  } else {
    console.warn(`[DataOne Breaker] failure ${breakerConsecutiveFailures}/${BREAKER_THRESHOLD} (${reason})`);
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

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
  /** Task #166: duty-cycle aware intervals from DataOne `interval_type`. */
  intervalMilesNormal: number | null;
  intervalMonthsNormal: number | null;
  intervalMilesSevere: number | null;
  intervalMonthsSevere: number | null;
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
          intervalMilesNormal: null,
          intervalMonthsNormal: null,
          intervalMilesSevere: null,
          intervalMonthsSevere: null,
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

        const it = String(intervalDef.interval_type || "").toLowerCase();
        const isSevere = it.includes("severe");
        const isNormal = it.includes("normal");
        const units = String(intervalDef.units || "");
        const value: number | null = typeof intervalDef.value === "number" ? intervalDef.value : null;

        if (units === "Miles" && value != null && value > 0) {
          if (item.miles === null || value < item.miles) item.miles = value;
          if (isSevere && (item.intervalMilesSevere === null || value < item.intervalMilesSevere)) {
            item.intervalMilesSevere = value;
          }
          if (isNormal && (item.intervalMilesNormal === null || value < item.intervalMilesNormal)) {
            item.intervalMilesNormal = value;
          }
        }
        if (units === "Months" && value != null && value > 0) {
          if (item.months === null || value < item.months) item.months = value;
          if (isSevere && (item.intervalMonthsSevere === null || value < item.intervalMonthsSevere)) {
            item.intervalMonthsSevere = value;
          }
          if (isNormal && (item.intervalMonthsNormal === null || value < item.intervalMonthsNormal)) {
            item.intervalMonthsNormal = value;
          }
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

interface CachedVehicleInfo {
  year: number;
  make: string;
  model: string;
  engine: string;
  /** Optional fields added in Task #166 for the engine-risk classifier. */
  transType?: string | null;
  engine_size?: number | null;
  engine_block?: string | null;
  engine_cylinders?: number | null;
  engine_induction?: string | null;
  engine_aspiration?: string | null;
  fuel_type?: string | null;
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
  vehicle?: CachedVehicleInfo;
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
  vehicle?: CachedVehicleInfo;
  error?: string;
  source: "api" | "cache";
  cachedAt?: Date;
}> {
  const squish = toSquish(vin);
  const now = new Date();
  
  // Acquired up front (before the cache read, which sits on the same
  // brownout-prone Postgres); null = breaker open, fail fast on any DB touch
  // that errors and on the miss path.
  const breakerToken = breakerAcquire();
  const fastFail = (error: string) => ({
    ok: false,
    vin,
    squish,
    count: 0,
    items: [] as MaintenanceItem[],
    error,
    source: "cache" as const,
  });

  try {
    // Wave 1 (task #342): canonical cache now in Postgres. The read is
    // deadline-bounded — it lives on the same Postgres as the slow path, so a
    // hung cache read must not pin the request either.
    const { pgFindDataOneCache } = await import("@/lib/db/repositories/wave1");
    let cached: CachedMaintenanceData | null;
    try {
      cached = (await withDeadline(
        pgFindDataOneCache(squish),
        LOCAL_FETCH_TIMEOUT_MS,
        "DataOne cache read",
      )) as CachedMaintenanceData | null;
    } catch (cacheErr: any) {
      if (breakerToken) breakerRecordFailure(breakerToken, cacheErr?.message || "cache read failed");
      return fastFail(`DataOne cache read failed: ${cacheErr?.message || cacheErr}`);
    }
    
    if (cached && cached.expiresAt > now && cached.vehicle) {
      const cachedHasIntervals = cached.data.items?.some((item: any) => item.miles || item.months);
      const isEmptyResult = cached.data.count === 0;
      if (isEmptyResult) {
        console.log(`[DataOne Cache] HIT but empty result for squish ${squish}, re-fetching (empty results always re-checked)...`);
      } else if (cachedHasIntervals) {
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
    
    // Circuit breaker: during a DB brownout, fail the miss path instantly
    // instead of hanging plan builds for their full 15s race timeout.
    if (!breakerToken) {
      console.warn(`[DataOne Breaker] open — failing fast for squish ${squish} (retry after ${new Date(breakerOpenUntil).toISOString()})`);
      return fastFail("DataOne lookup skipped: circuit breaker open (recent lookups timed out)");
    }

    // Cache miss or expired - fetch from LOCAL PostgreSQL database (fast!)
    console.log(`[DataOne Cache] ${cached ? 'EXPIRED' : 'MISS'} for squish ${squish}, fetching from local PostgreSQL...`);
    
    // Fetch both maintenance schedule and vehicle decode from local database in
    // parallel, bounded by our own deadline (below the plan-builder 15s race)
    // so slowness is observed and counted here.
    let localResult: Awaited<ReturnType<typeof getMaintenanceScheduleLocal>>;
    let decoded: Awaited<ReturnType<typeof decodeVinLocal>>;
    try {
      [localResult, decoded] = await withDeadline(
        Promise.all([
          getMaintenanceScheduleLocal(vin),
          decodeVinLocal(vin),
        ]),
        LOCAL_FETCH_TIMEOUT_MS,
        "DataOne local fetch",
      );
    } catch (fetchErr: any) {
      breakerRecordFailure(breakerToken, fetchErr?.message || "local fetch failed");
      return fastFail(`DataOne local fetch failed: ${fetchErr?.message || fetchErr}`);
    }
    
    // Extract vehicle info from decode
    const vehicleInfo: CachedVehicleInfo | undefined = decoded.ok && decoded.decoded ? {
      year: decoded.decoded.year,
      make: decoded.decoded.make,
      model: decoded.decoded.model,
      engine: decoded.decoded.engine_name,
      transType: decoded.decoded.trans_type || null,
      // Task #166: extra fields used by the engine-risk classifier.
      engine_size: typeof decoded.decoded.engine_size === "number" ? decoded.decoded.engine_size : null,
      engine_block: decoded.decoded.engine_block ?? null,
      engine_cylinders: typeof decoded.decoded.engine_cylinders === "number" ? decoded.decoded.engine_cylinders : null,
      engine_induction: decoded.decoded.engine_induction ?? null,
      engine_aspiration: decoded.decoded.engine_aspiration ?? null,
      fuel_type: decoded.decoded.fuel_type ?? null,
    } : undefined;
    
    // Check if local data has intervals - if items exist but none have miles/months, fall back to API
    const hasUsableIntervals = localResult.items.some(item => item.miles || item.months);
    let finalItems = localResult.items;
    let finalCount = localResult.count;
    let finalOk = localResult.ok;
    let finalError = localResult.error;
    let dataSource: "cache" | "api" = "cache";
    
    // Both DataOne paths (local PostgreSQL + external HTTP API) are reachable;
    // they're picked at runtime based on data quality (`hasUsableIntervals`),
    // not by code-path branching. The external-API fallback is gated by a
    // single env switch (`DATAONE_API_FALLBACK_ENABLED`, default ON) so on-call
    // can disable the external dependency entirely without a code deploy if
    // the upstream HTTP service degrades. When OFF, the cached path returns
    // the local result as-is (which is what every other caller of
    // `dataone-local` already does).
    const apiFallbackEnabled = process.env.DATAONE_API_FALLBACK_ENABLED !== "false";

    if (apiFallbackEnabled && localResult.ok && localResult.count > 0 && !hasUsableIntervals) {
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

    if (isDbError) {
      breakerRecordFailure(breakerToken, finalError || "db error");
    } else {
      breakerRecordSuccess(breakerToken);
    }

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
    
    const cacheData = {
      ok: finalOk,
      count: finalCount,
      items: finalItems,
      error: finalError,
    };

    // Wave 1 dual-write: PG canonical (must succeed) + Mongo legacy mirror.
    const { pgUpsertDataOneCache } = await import("@/lib/db/repositories/wave1");
    await pgUpsertDataOneCache({
      squish, vin, data: cacheData, vehicle: vehicleInfo,
      fetchedAt: now, expiresAt, source: dataSource,
    });
    try {
      const db2 = await getDb();
      await db2.collection("dataone_cache").updateOne(
        { squish },
        {
          $set: {
            squish, vin, data: cacheData, vehicle: vehicleInfo,
            fetchedAt: now, expiresAt, source: dataSource,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      console.error("[DataOne Cache] Mongo mirror failed (non-fatal):", err);
    }
    
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
    // Fallback to direct local database call if the cache layer fails — but
    // breaker-gated and deadline-bounded: the fallback hits the same Postgres,
    // so an unbounded retry here would bypass the whole brownout protection.
    if (!breakerToken || Date.now() < breakerOpenUntil) {
      return fastFail("DataOne fallback skipped: circuit breaker open");
    }
    try {
      const localResult = await withDeadline(
        getMaintenanceScheduleLocal(vin),
        LOCAL_FETCH_TIMEOUT_MS,
        "DataOne fallback fetch",
      );
      if (localResult.ok) breakerRecordSuccess(breakerToken);
      return {
        ...localResult,
        source: "local" as "api" | "cache",
      };
    } catch (fallbackErr: any) {
      breakerRecordFailure(breakerToken, fallbackErr?.message || "fallback fetch failed");
      return fastFail(`DataOne fallback failed: ${fallbackErr?.message || fallbackErr}`);
    }
  }
}

export async function invalidateMaintenanceCache(vin: string): Promise<boolean> {
  try {
    const squish = toSquish(vin);
    const db = await getDb();
    const { pgDeleteDataOneCache } = await import("@/lib/db/repositories/wave1");
    const deleted = await pgDeleteDataOneCache(squish);
    // Best-effort Mongo cleanup so the legacy collection drains during soak.
    try { await db.collection("dataone_cache").deleteOne({ squish }); } catch { /* swallow */ }
    console.log(`[DataOne Cache] Invalidated cache for squish ${squish}`);
    return deleted;
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
    const { pgDataOneCacheStats } = await import("@/lib/db/repositories/wave1");
    const { totalCached, expiredCount } = await pgDataOneCacheStats();
    return { totalCached, expiredCount, recentHits: 0 };
  } catch (error) {
    console.error("[DataOne Cache] Stats error:", error);
    return { totalCached: 0, expiredCount: 0, recentHits: 0 };
  }
}
