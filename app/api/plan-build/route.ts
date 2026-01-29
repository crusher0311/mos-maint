import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getCachedPlan, setCachedPlan, type CachedPlanData, type TriagedItemCache } from "@/lib/plan-cache";
import { resolveAutoflowConfig, fetchDviWithCache } from "@/lib/integrations/autoflow";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import {
  resolveProtractorConfig,
  fetchVehicleWithCache as fetchProtractorVehicle,
  fetchDeferredWorkWithCache as fetchProtractorDeferredWork,
} from "@/lib/integrations/protractor";
import {
  resolveAutoVitalsConfig,
  fetchAutoVitalsInspectionByVin,
} from "@/lib/integrations/autovitals";
import { searchVehiclesByVin, getRepairOrders } from "@/lib/integrations/tekmetric/client";
import { isConfigured as isTekmetricConfigured } from "@/lib/integrations/tekmetric/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours
const PROTRACTOR_CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours
const DVI_CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days
const DEFAULT_SOON_MILES = 3000;
const DEFAULT_SOON_DAYS = 90;

function toKeyFromName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function toKeyFromFreeText(text: string): string[] {
  const lower = text.toLowerCase();
  const keys: string[] = [];
  
  if (lower.includes("oil") && (lower.includes("change") || lower.includes("filter"))) {
    keys.push("engine_oil");
  }
  if (lower.includes("tire") && lower.includes("rotat")) keys.push("tire_rotation");
  if (lower.includes("air") && lower.includes("filter") && !lower.includes("cabin")) keys.push("air_filter");
  if (lower.includes("cabin") && lower.includes("filter")) keys.push("cabin_air_filter");
  if (lower.includes("brake") && (lower.includes("fluid") || lower.includes("flush"))) keys.push("brake_fluid");
  if (lower.includes("transmission") && lower.includes("fluid")) keys.push("transmission_fluid");
  if (lower.includes("coolant") || (lower.includes("antifreeze"))) keys.push("engine_coolant");
  if (lower.includes("spark") && lower.includes("plug")) keys.push("spark_plugs");
  if (lower.includes("battery")) keys.push("battery");
  if (lower.includes("wiper") && lower.includes("blade")) keys.push("wiper_blades");
  if (lower.includes("alignment")) keys.push("wheel_alignment");
  if (lower.includes("timing") && lower.includes("belt")) keys.push("timing_belt");
  if (lower.includes("serpentine") || (lower.includes("drive") && lower.includes("belt"))) keys.push("serpentine_belt");
  if (lower.includes("fuel") && lower.includes("filter")) keys.push("fuel_filter");
  if (lower.includes("differential") && lower.includes("fluid")) keys.push("differential_fluid");
  if (lower.includes("transfer") && lower.includes("case")) keys.push("transfer_case_fluid");
  if (lower.includes("power") && lower.includes("steering") && lower.includes("fluid")) keys.push("power_steering_fluid");
  if (lower.includes("brake") && lower.includes("pad")) keys.push("brake_pads");
  if (lower.includes("brake") && lower.includes("rotor")) keys.push("brake_rotors");
  
  if (keys.length === 0) {
    keys.push(toKeyFromName(text));
  }
  
  return keys;
}

function parseCarfaxDate(d?: string | null): Date | null {
  if (!d) return null;
  const trimmed = String(d).trim();
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = Number(m[1]), dd = Number(m[2]), yy = Number(m[3]);
    const dt = new Date(yy, mm - 1, dd);
    return isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(trimmed);
  return isNaN(dt.getTime()) ? null : dt;
}

function addMonths(d: Date, months: number) {
  const dt = new Date(d);
  dt.setMonth(dt.getMonth() + months);
  return dt;
}

interface OEMItem {
  maintenance_id?: string | number;
  name?: string;
  miles?: number | null;
  months?: number | null;
}

interface TriagedItem {
  key: string;
  serviceKey: string;
  title: string;
  category?: string;
  intervalMiles?: number | null;
  intervalMonths?: number | null;
  last?: { miles?: number | null; date?: Date | null; source?: "carfax" | "protractor" | "shop" };
  dueAtMiles?: number | null;
  dueAtDate?: Date | null;
  milesToGo?: number | null;
  daysToGo?: number | null;
  bump?: "red" | "yellow" | null;
  source?: "oem" | "dvi" | "protractor";
  dviSource?: "autoflow" | "autovitals";
  reason?: string;
  usingShopInterval?: boolean;
  protractorDeferredId?: string;
  matchedDeferred?: { id: string; title: string };
}

interface Buckets {
  overdue: TriagedItem[];
  dueSoon: TriagedItem[];
  upcoming: TriagedItem[];
}

function simpleTriage(
  oemItems: OEMItem[],
  currentMiles: number | null,
  carfaxRecords: Array<{ date?: string; odometer?: number; description?: string }>,
  soonMiles: number,
  soonDays: number,
  milesPerDay: number | null
): Buckets {
  const today = new Date();
  const buckets: Buckets = { overdue: [], dueSoon: [], upcoming: [] };
  const usedServiceKeys = new Set<string>();
  
  const lastMap = new Map<string, { miles: number | null; date: Date | null; source: "carfax" }>();
  for (const r of carfaxRecords || []) {
    const date = parseCarfaxDate(r.date);
    const miles = r.odometer ?? null;
    const desc = String(r.description || "").trim();
    const keys = toKeyFromFreeText(desc);
    for (const k of keys) {
      const prev = lastMap.get(k);
      const cand = { miles, date, source: "carfax" as const };
      const prevScore = prev?.date ? prev.date.getTime() : -Infinity;
      const candScore = date ? date.getTime() : -Infinity;
      if (!prev || candScore > prevScore) lastMap.set(k, cand);
    }
  }
  
  for (const o of oemItems) {
    const serviceKey = toKeyFromName(o.name || "") || `misc_${o.maintenance_id}`;
    if (usedServiceKeys.has(serviceKey) && !serviceKey.startsWith("misc_")) continue;
    usedServiceKeys.add(serviceKey);
    
    const uniqueKey = `${serviceKey}_${o.maintenance_id}`;
    const last = lastMap.get(serviceKey) ?? null;
    const intervalMiles = o.miles ?? null;
    const intervalMonths = o.months ?? null;
    
    let dueAtMiles: number | null = null;
    let dueAtDate: Date | null = null;
    let neverDone = false;
    
    if (intervalMiles && intervalMiles > 0) {
      if (last?.miles != null) {
        dueAtMiles = last.miles + intervalMiles;
      } else if (currentMiles != null) {
        dueAtMiles = intervalMiles;
        neverDone = true;
      }
    }
    
    if (intervalMonths && intervalMonths > 0) {
      if (last?.date) dueAtDate = addMonths(last.date, intervalMonths);
      else if (!neverDone) dueAtDate = addMonths(today, intervalMonths);
    }
    
    const milesToGo = currentMiles != null && dueAtMiles != null ? dueAtMiles - currentMiles : null;
    
    if (dueAtDate == null && milesToGo != null && milesPerDay != null && milesPerDay > 0) {
      const daysUntilDue = milesToGo / milesPerDay;
      dueAtDate = new Date(today.getTime() + daysUntilDue * 24 * 60 * 60 * 1000);
    }
    
    const daysToGo = dueAtDate ? Math.round((dueAtDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)) : null;
    
    const item: TriagedItem = {
      key: uniqueKey,
      serviceKey,
      title: o.name || "Maintenance Item",
      intervalMiles,
      intervalMonths,
      last: last ? { miles: last.miles, date: last.date, source: last.source } : undefined,
      dueAtMiles,
      dueAtDate,
      milesToGo,
      daysToGo,
      source: "oem",
    };
    
    const isOverdueMiles = milesToGo != null && milesToGo < 0;
    const isOverdueTime = daysToGo != null && daysToGo < 0;
    const isSoonMiles = milesToGo != null && milesToGo >= 0 && milesToGo <= soonMiles;
    const isSoonTime = daysToGo != null && daysToGo >= 0 && daysToGo <= soonDays;
    
    if (isOverdueMiles || isOverdueTime) {
      buckets.overdue.push(item);
    } else if (isSoonMiles || isSoonTime) {
      buckets.dueSoon.push(item);
    } else {
      buckets.upcoming.push(item);
    }
  }
  
  return buckets;
}

function convertToCache(item: TriagedItem): TriagedItemCache {
  return {
    key: item.key,
    serviceKey: item.serviceKey,
    title: item.title,
    category: item.category,
    intervalMiles: item.intervalMiles,
    intervalMonths: item.intervalMonths,
    last: item.last ? {
      miles: item.last.miles,
      date: item.last.date?.toISOString() ?? null,
      source: item.last.source,
    } : undefined,
    dueAtMiles: item.dueAtMiles,
    dueAtDate: item.dueAtDate?.toISOString() ?? null,
    milesToGo: item.milesToGo,
    daysToGo: item.daysToGo,
    bump: item.bump,
    source: item.source,
    dviSource: item.dviSource,
    reason: item.reason,
    usingShopInterval: item.usingShopInterval,
    protractorDeferredId: item.protractorDeferredId,
    matchedDeferred: item.matchedDeferred,
  };
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const vin = req.nextUrl.searchParams.get("vin")?.toUpperCase();
    const mileageParam = req.nextUrl.searchParams.get("mileage");
    const mileage = mileageParam ? parseInt(mileageParam, 10) : null;
    
    if (!vin || vin.length !== 17) {
      return NextResponse.json({ error: "Valid 17-character VIN required" }, { status: 400 });
    }
    
    if (!mileage || mileage <= 0) {
      return NextResponse.json({ ok: true, vin, skipped: true, reason: "No mileage" }, { status: 200 });
    }

    const db = await getDb();

    const existingCache = await getCachedPlan(db, vin, shopId, mileage);
    if (existingCache) {
      return NextResponse.json({
        ok: true,
        vin,
        cached: true,
        message: "Plan already cached",
        duration: Date.now() - startTime,
      }, { status: 200 });
    }
    
    console.log(`[PlanBuild] Shop ${shopId}: Building full plan for ${vin} at ${mileage} miles`);

    const shopDoc = await db.collection("shops").findOne({ shopId });
    const soonMiles = shopDoc?.settings?.planPage?.soonMiles ?? DEFAULT_SOON_MILES;
    const soonDays = shopDoc?.settings?.planPage?.soonDays ?? DEFAULT_SOON_DAYS;
    const showInspectItems = shopDoc?.settings?.planPage?.showInspectItems ?? false;
    const distanceUnit = (shopDoc?.settings?.distanceUnit ?? "miles") as "miles" | "kilometers";

    const [oemData, carfaxResult, protractorCfg] = await Promise.all([
      getMaintenanceScheduleCached(vin),
      (async () => {
        const cfg = await resolveCarfaxConfig(shopId);
        if (!cfg.configured) return { ok: false };
        return fetchCarfaxWithCache(shopId, vin, CACHE_TTL_MS);
      })(),
      resolveProtractorConfig(shopId),
    ]);

    const oemItems: OEMItem[] = (oemData.items || []).map((item: any) => ({
      maintenance_id: item.maintenance_id,
      name: item.maintenance_name || item.name,
      miles: item.miles,
      months: item.months,
    }));
    const carfaxRecords = (carfaxResult as any).ok ? ((carfaxResult as any).serviceRecords || []) : [];
    
    let mpdBlended: number | null = null;
    if ((carfaxResult as any).ok && Array.isArray((carfaxResult as any).serviceRecords)) {
      const validRecords = (carfaxResult as any).serviceRecords
        .filter((r: any) => r.odometer && r.date)
        .sort((a: any, b: any) => {
          const da = parseCarfaxDate(a.date);
          const db = parseCarfaxDate(b.date);
          return (da?.getTime() || 0) - (db?.getTime() || 0);
        });
      
      if (validRecords.length >= 2) {
        const first = validRecords[0];
        const last = validRecords[validRecords.length - 1];
        const firstDate = parseCarfaxDate(first.date);
        const lastDate = parseCarfaxDate(last.date);
        if (firstDate && lastDate && first.odometer && last.odometer) {
          const daysBetween = (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24);
          const milesDiff = last.odometer - first.odometer;
          if (daysBetween > 30 && milesDiff > 0) {
            mpdBlended = Math.round((milesDiff / daysBetween) * 10) / 10;
          }
        }
      }
    }

    let customerName: string | null = null;
    let latestRoNumber: string | null = null;

    if (isTekmetricConfigured()) {
      try {
        const vehicleResult = await searchVehiclesByVin(shopId, vin);
        if (vehicleResult.content?.length > 0) {
          const vehicle = vehicleResult.content[0];
          if (vehicle.id) {
            const rosResult = await getRepairOrders(shopId, { vehicleId: vehicle.id, size: 1 });
            if (rosResult.content?.length > 0) {
              latestRoNumber = String(rosResult.content[0].repairOrderNumber);
              const ro = rosResult.content[0] as any;
              if (ro.customer) {
                customerName = [ro.customer.firstName, ro.customer.lastName].filter(Boolean).join(" ") || null;
              }
            }
          }
        }
      } catch (err) {
        console.log(`[PlanBuild] Tekmetric fetch error for ${vin}:`, err);
      }
    }

    let protractorVehicleId: string | null = null;
    if (!customerName && protractorCfg.configured) {
      try {
        const vehicleResult = await fetchProtractorVehicle(shopId, vin, PROTRACTOR_CACHE_TTL);
        if ((vehicleResult as any).ok && (vehicleResult as any).vehicle) {
          const v = (vehicleResult as any).vehicle;
          customerName = v.CustomerName || [v.FirstName, v.LastName].filter(Boolean).join(" ") || null;
          protractorVehicleId = v.ID || null;
        }
      } catch (err) {
        console.log(`[PlanBuild] Protractor fetch error for ${vin}:`, err);
      }
    }
    
    // Fetch deferred work for Protractor shops
    let deferredWork: Array<{ ID?: string; ServiceItemID?: string; Title?: string; Description?: string }> = [];
    if (protractorCfg.configured && protractorVehicleId) {
      try {
        const deferredResult = await fetchProtractorDeferredWork(shopId, vin, protractorVehicleId, PROTRACTOR_CACHE_TTL);
        if ((deferredResult as any).ok && (deferredResult as any).deferredWork) {
          deferredWork = (deferredResult as any).deferredWork.map((dw: any) => ({
            ID: dw.ID,
            ServiceItemID: dw.ServiceItemID,
            Title: dw.Title,
            Description: dw.Description,
          }));
        }
      } catch (err) {
        console.log(`[PlanBuild] Protractor deferred work fetch error for ${vin}:`, err);
      }
    }

    const buckets = simpleTriage(oemItems, mileage, carfaxRecords, soonMiles, soonDays, mpdBlended);

    const isInspectItem = (item: TriagedItem) => {
      const title = item.title.toLowerCase();
      return title.includes("inspect") || title.startsWith("check ");
    };
    
    const filteredBuckets = showInspectItems ? buckets : {
      overdue: buckets.overdue.filter(i => !isInspectItem(i)),
      dueSoon: buckets.dueSoon.filter(i => !isInspectItem(i)),
      upcoming: buckets.upcoming.filter(i => !isInspectItem(i)),
    };

    const planData: CachedPlanData = {
      buckets: {
        overdue: filteredBuckets.overdue.map(convertToCache),
        dueSoon: filteredBuckets.dueSoon.map(convertToCache),
        upcoming: filteredBuckets.upcoming.map(convertToCache),
      },
      vehicle: {
        year: oemData.vehicle?.year ?? null,
        make: oemData.vehicle?.make ?? null,
        model: oemData.vehicle?.model ?? null,
        engine: oemData.vehicle?.engine ?? null,
      },
      currentMiles: mileage,
      mpdBlended,
      customerName,
      latestRoNumber,
      distanceUnit,
      soonMiles,
      soonDays,
      showInspectItems,
      deferredWork: deferredWork.length > 0 ? deferredWork : undefined,
    };

    await setCachedPlan(db, vin, shopId, mileage, planData);

    const duration = Date.now() - startTime;
    console.log(`[PlanBuild] Shop ${shopId}: Built and cached plan for ${vin} in ${duration}ms`);

    return NextResponse.json({
      ok: true,
      vin,
      built: true,
      message: "Plan built and cached",
      duration,
      counts: {
        overdue: filteredBuckets.overdue.length,
        dueSoon: filteredBuckets.dueSoon.length,
        upcoming: filteredBuckets.upcoming.length,
      },
    }, { status: 200 });

  } catch (err: any) {
    console.error("[PlanBuild] Error:", err);
    return NextResponse.json(
      { error: "Plan build failed", details: err.message },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json({ error: "Use POST method to build plan" }, { status: 405 });
}
