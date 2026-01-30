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
  type ProtractorDeferredWork,
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
const DEFAULT_SOON_MILES = 1000;
const DEFAULT_SOON_DAYS = 30;

// Service key mappings aligned with CARFAX categories
const SERVICE_KEYS: Record<string, string[]> = {
  oil: [
    "oil and filter", "engine oil", "oil change", "replace engine oil", 
    "oil filter", "replace oil filter", "change oil", "motor oil",
    "crankcase oil", "oil & filter"
  ],
  tire_rotation: ["rotate tires", "tire rotation", "rotate tyre", "tires rotated", "rotate wheels"],
  cabin_air: ["cabin air filter", "cabin filter", "pollen filter", "hvac filter", "interior air filter"],
  engine_air: [
    "engine air filter", "air cleaner element", "air filter element",
    "remove & replace air filter", "air filter replace", "replace air filter"
  ],
  coolant: [
    "engine coolant", "coolant flush", "replace coolant", "cooling system", 
    "antifreeze", "radiator flush", "drain and fill coolant", "coolant service",
    "bg coolant", "cooling system service"
  ],
  trans_auto: [
    "automatic transmission fluid", "atf fluid", "atf flush", "auto trans fluid",
    "transmission service", "transmission flush", "bg automatic transmission",
    "transmission fluid service"
  ],
  trans_manual: ["manual transmission fluid", "manual trans fluid", "mtf fluid"],
  transfer_case: ["transfer case fluid", "transfer case flush", "transfer case oil"],
  differential: [
    "differential fluid", "differential flush", "rear differential", 
    "front differential", "rear axle fluid", "front axle fluid",
    "bg differential", "diff service", "differential service", "gear oil"
  ],
  serpentine_belt: ["serpentine belt", "drive belt", "accessory belt", "v-belt", "fan belt"],
  fuel_system: [
    "fuel system cleaning", "fuel injector cleaning", "fuel system service", "fuel induction",
    "bg fuel", "bg platinum fuel", "induction cleaning", "throttle body cleaning"
  ],
  fuel_filter: ["fuel filter"],
  brake_pads: [
    "brake pads", "brake linings", "brake rotor", "brake pads replaced", 
    "brake lining", "disc brake", "front brakes", "rear brakes", "brake shoes"
  ],
  brake_fluid: [
    "brake fluid", "dot4", "dot 4", "dot3", "dot 3", "brake flush", 
    "brake fluid service", "brake fluid change", "brake fluid flush"
  ],
  spark_plugs: ["spark plug", "spark plugs", "ignition tune", "tune-up", "tune up"],
  alignment: ["wheel alignment", "alignment", "all wheel alignment", "front alignment", "rear alignment"],
  emissions: ["emissions test", "emissions inspection", "smog test", "smog check", "emission test"],
  power_steering: ["power steering fluid", "power steering flush", "power steering service"],
  battery: ["battery replaced", "battery replacement", "battery/charging", "replace battery", "new battery"],
  ac_refrigerant: [
    "a/c refrigerant", "ac refrigerant", "air conditioning refill", 
    "a/c recharge", "ac recharge", "refrigerant", "r-134a", "r134a"
  ],
};

const SERVICE_KEY_DISPLAY_NAMES: Record<string, string> = {
  oil: "Oil Change",
  tire_rotation: "Tire Rotation",
  cabin_air: "Cabin Air Filter",
  engine_air: "Engine Air Filter",
  coolant: "Coolant Flush",
  trans_auto: "Automatic Transmission Fluid",
  trans_manual: "Manual Transmission Fluid",
  transfer_case: "Transfer Case Fluid",
  differential: "Differential Fluid",
  serpentine_belt: "Serpentine Belt",
  fuel_system: "Fuel System Cleaning",
  fuel_filter: "Fuel Filter",
  brake_pads: "Brake Pads",
  emissions: "Emissions Inspection",
  power_steering: "Power Steering Fluid",
  battery: "Battery",
  ac_refrigerant: "A/C Refrigerant",
};

function toKeyFromName(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes("cabin") && n.includes("air") && n.includes("filter")) return "cabin_air";
  for (const [key, vals] of Object.entries(SERVICE_KEYS)) {
    if (vals.some((v) => n.includes(v))) return key;
  }
  if (n.includes("air filter") && !n.includes("cabin")) return "engine_air";
  if (n.includes("exhaust system")) return "exhaust";
  if (n.includes("transmission fluid") || n.includes("transmission flush")) return "trans_auto";
  return null;
}

function toKeyFromFreeText(desc: string): string[] {
  const d = desc.toLowerCase();
  const hits: string[] = [];
  for (const [key, vals] of Object.entries(SERVICE_KEYS)) {
    if (vals.some((v) => d.includes(v))) hits.push(key);
  }
  if (d.includes("oil") && !hits.includes("oil")) hits.push("oil");
  if (d.includes("rotate") && d.includes("tire") && !hits.includes("tire_rotation")) hits.push("tire_rotation");
  return Array.from(new Set(hits));
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

type CarfaxRecordWithParsed = {
  date: Date | null;
  miles: number | null;
  description?: string;
};

function fillCarfaxMileageGaps(
  records: Array<{ date?: string; odometer?: number; description?: string }>,
  opts: { today: Date; currentMiles: number | null; defaultRate: number | null }
): CarfaxRecordWithParsed[] {
  const parsed: CarfaxRecordWithParsed[] = records.map(r => ({
    date: parseCarfaxDate(r.date ?? null),
    miles: typeof r.odometer === "number" && r.odometer > 0 ? r.odometer : null,
    description: r.description,
  }));

  parsed.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.getTime() - b.date.getTime();
  });

  const knownPoints: Array<{ date: Date; miles: number; index: number }> = [];
  for (let i = 0; i < parsed.length; i++) {
    const rec = parsed[i];
    if (rec.date && rec.miles != null) {
      knownPoints.push({ date: rec.date, miles: rec.miles, index: i });
    }
  }

  if (opts.currentMiles != null) {
    knownPoints.push({ date: opts.today, miles: opts.currentMiles, index: -1 });
    knownPoints.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  for (let i = 0; i < parsed.length; i++) {
    const rec = parsed[i];
    if (rec.miles != null || !rec.date) continue;

    const recTime = rec.date.getTime();
    let beforeIdx = -1;
    let afterIdx = -1;

    for (let j = 0; j < knownPoints.length; j++) {
      const kp = knownPoints[j];
      if (kp.date.getTime() <= recTime) {
        beforeIdx = j;
      } else if (afterIdx === -1) {
        afterIdx = j;
        break;
      }
    }

    const before = beforeIdx >= 0 ? knownPoints[beforeIdx] : null;
    const after = afterIdx >= 0 ? knownPoints[afterIdx] : null;

    if (before && after) {
      const totalDays = (after.date.getTime() - before.date.getTime()) / (1000 * 60 * 60 * 24);
      const daysSinceBefore = (recTime - before.date.getTime()) / (1000 * 60 * 60 * 24);
      if (totalDays > 0) {
        const ratio = daysSinceBefore / totalDays;
        const estimated = Math.round(before.miles + ratio * (after.miles - before.miles));
        rec.miles = Math.max(before.miles, Math.min(after.miles, estimated));
      } else {
        rec.miles = before.miles;
      }
    } else if (before) {
      if (beforeIdx > 0) {
        const prevPoint = knownPoints[beforeIdx - 1];
        const days = (before.date.getTime() - prevPoint.date.getTime()) / (1000 * 60 * 60 * 24);
        if (days > 0) {
          const rate = (before.miles - prevPoint.miles) / days;
          const daysSince = (recTime - before.date.getTime()) / (1000 * 60 * 60 * 24);
          rec.miles = Math.round(before.miles + rate * daysSince);
        }
      } else if (opts.defaultRate != null) {
        const daysSince = (recTime - before.date.getTime()) / (1000 * 60 * 60 * 24);
        rec.miles = Math.round(before.miles + opts.defaultRate * daysSince);
      }
    } else if (after) {
      if (afterIdx < knownPoints.length - 1) {
        const nextPoint = knownPoints[afterIdx + 1];
        const days = (nextPoint.date.getTime() - after.date.getTime()) / (1000 * 60 * 60 * 24);
        if (days > 0) {
          const rate = (nextPoint.miles - after.miles) / days;
          const daysBefore = (after.date.getTime() - recTime) / (1000 * 60 * 60 * 24);
          rec.miles = Math.round(after.miles - rate * daysBefore);
        }
      } else if (opts.defaultRate != null) {
        const daysBefore = (after.date.getTime() - recTime) / (1000 * 60 * 60 * 24);
        rec.miles = Math.round(after.miles - opts.defaultRate * daysBefore);
      }
    }

    if (rec.miles != null && rec.miles < 0) rec.miles = null;
  }

  return parsed;
}

const MILEAGE_TOLERANCE = 10;
const DATE_TOLERANCE_DAYS = 3;

function isMatchingHistory(
  shopRecord: { miles?: number | null; date?: Date | null },
  carfaxRecord: { miles?: number | null; date?: Date | null }
): boolean {
  if (shopRecord.miles == null || carfaxRecord.miles == null) return false;
  if (shopRecord.date == null || carfaxRecord.date == null) return false;
  const milesDiff = Math.abs(shopRecord.miles - carfaxRecord.miles);
  const daysDiff = Math.abs(shopRecord.date.getTime() - carfaxRecord.date.getTime()) / (1000 * 60 * 60 * 24);
  return milesDiff <= MILEAGE_TOLERANCE && daysDiff <= DATE_TOLERANCE_DAYS;
}

interface OEMItem {
  maintenance_id?: string | number;
  name?: string;
  category?: string;
  miles?: number | null;
  months?: number | null;
}

type LastDone = { miles?: number | null; date?: Date | null; source?: "carfax" | "protractor" | "shop" };

type MatchedDeferred = { id: string; title: string };

type DeclinedServiceEntry = {
  serviceKey: string;
  serviceName: string;
  mileage?: number | null;
  reason?: string | null;
  declinedAt: string;
};

type ShopIntervalOverride = {
  useShop: boolean;
  miles: number | null;
  months: number | null;
};

type ShopServiceHistory = {
  serviceName: string;
  mileage: number | null;
  date: Date | null;
};

interface TriagedItem {
  key: string;
  serviceKey: string;
  title: string;
  category?: string;
  intervalMiles?: number | null;
  intervalMonths?: number | null;
  last?: LastDone;
  dueAtMiles?: number | null;
  dueAtDate?: Date | null;
  milesToGo?: number | null;
  daysToGo?: number | null;
  bump?: "red" | "yellow" | null;
  source?: "oem" | "dvi" | "protractor";
  dviSource?: "autoflow" | "autovitals";
  reason?: string;
  declined?: DeclinedServiceEntry | null;
  usingShopInterval?: boolean;
  protractorDeferredId?: string;
  matchedDeferred?: MatchedDeferred;
}

interface Buckets {
  overdue: TriagedItem[];
  dueSoon: TriagedItem[];
  upcoming: TriagedItem[];
}

function triage({
  oemItems,
  carfaxRecords,
  shopServiceHistory = [],
  currentMiles,
  today = new Date(),
  dviFindings,
  protractorDeferredWork = [],
  declinedServices = [],
  soonMiles = DEFAULT_SOON_MILES,
  soonDays = DEFAULT_SOON_DAYS,
  milesPerDay = null,
  shopIntervals = {},
  vehicleYear = null,
}: {
  oemItems: OEMItem[];
  carfaxRecords: Array<{ date?: string; odometer?: number; description?: string }>;
  shopServiceHistory?: ShopServiceHistory[];
  currentMiles: number | null;
  today?: Date;
  dviFindings: Array<{ name?: string; status?: string | number; source?: string }>;
  protractorDeferredWork?: ProtractorDeferredWork[];
  declinedServices?: DeclinedServiceEntry[];
  soonMiles?: number;
  soonDays?: number;
  milesPerDay?: number | null;
  shopIntervals?: Record<string, ShopIntervalOverride>;
  vehicleYear?: number | null;
}): Buckets {
  const earliestDate = vehicleYear 
    ? new Date(vehicleYear, 0, 1)
    : new Date(today.getTime() - 20 * 365 * 24 * 60 * 60 * 1000);

  const enrichedRecords = fillCarfaxMileageGaps(carfaxRecords || [], {
    today,
    currentMiles,
    defaultRate: milesPerDay,
  });

  const shopHistoryByKey = new Map<string, { miles: number | null; date: Date | null }[]>();
  for (const sh of shopServiceHistory || []) {
    const keys = toKeyFromFreeText(sh.serviceName || "");
    for (const k of keys) {
      if (!shopHistoryByKey.has(k)) shopHistoryByKey.set(k, []);
      shopHistoryByKey.get(k)!.push({ miles: sh.mileage, date: sh.date });
    }
  }

  const lastMap = new Map<string, LastDone>();
  
  for (const sh of shopServiceHistory || []) {
    const keys = toKeyFromFreeText(sh.serviceName || "");
    for (const k of keys) {
      const prev = lastMap.get(k);
      const cand: LastDone = { miles: sh.mileage, date: sh.date, source: "shop" };
      const prevScore = prev?.date ? prev.date.getTime() : -Infinity;
      const candScore = sh.date ? sh.date.getTime() : -Infinity;
      if (!prev || candScore > prevScore) lastMap.set(k, cand);
    }
  }

  for (const r of enrichedRecords) {
    const date = r.date;
    const miles = r.miles;
    const desc = String(r.description || "").trim();
    const keys = toKeyFromFreeText(desc);
    for (const k of keys) {
      const prev = lastMap.get(k);
      const shopRecords = shopHistoryByKey.get(k) || [];
      const matchesShop = shopRecords.some(sr => isMatchingHistory(sr, { miles, date }));
      if (matchesShop) continue;
      const cand: LastDone = { miles, date, source: "carfax" };
      const prevScore = prev?.date ? prev.date.getTime() : -Infinity;
      const candScore = date ? date.getTime() : -Infinity;
      if (!prev || candScore > prevScore) lastMap.set(k, cand);
    }
  }

  const dviMap = new Map<string, { status: "red" | "yellow"; name: string; dviSource?: "autoflow" | "autovitals" }>();
  for (const it of dviFindings || []) {
    const key = it?.name ? toKeyFromName(String(it.name)) : null;
    if (!key) continue;
    const s = String(it.status ?? "");
    const dviSource = (it.source === "autovitals" ? "autovitals" : "autoflow") as "autoflow" | "autovitals";
    if (s === "0") dviMap.set(key, { status: "red", name: String(it.name), dviSource });
    else if (s === "1" && dviMap.get(key)?.status !== "red") dviMap.set(key, { status: "yellow", name: String(it.name), dviSource });
  }

  const declinedMap = new Map<string, DeclinedServiceEntry>();
  for (const d of declinedServices || []) {
    if (d.serviceKey) declinedMap.set(d.serviceKey, d);
  }

  const triaged: TriagedItem[] = [];
  const usedDviKeys = new Set<string>();
  const usedServiceKeys = new Set<string>();
  
  const deferredByServiceKey = new Map<string, MatchedDeferred>();
  const seenDeferredTitles = new Set<string>();
  const deferredServiceKeysUsedByOem = new Set<string>();
  
  for (const dw of protractorDeferredWork || []) {
    const title = dw.Title || dw.ServicePackageHeader?.Title || dw.Code || dw.Description || dw.ServicePackageHeader?.Description || "Deferred Service";
    const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seenDeferredTitles.has(normalizedTitle)) continue;
    seenDeferredTitles.add(normalizedTitle);
    const serviceKey = toKeyFromName(title);
    if (serviceKey && !deferredByServiceKey.has(serviceKey)) {
      deferredByServiceKey.set(serviceKey, { id: dw.ID, title });
    }
  }

  for (const o of oemItems) {
    const serviceKey = toKeyFromName(o.name || "") || `misc_${o.maintenance_id}`;
    const matchedDeferred = deferredByServiceKey.get(serviceKey);
    if (matchedDeferred) deferredServiceKeysUsedByOem.add(serviceKey);
    if (usedServiceKeys.has(serviceKey) && !serviceKey.startsWith("misc_")) continue;
    usedServiceKeys.add(serviceKey);
    
    const uniqueKey = `${serviceKey}_${o.maintenance_id}`;
    const last = lastMap.get(serviceKey) ?? null;
    
    const shopOverride = shopIntervals[serviceKey];
    const lastPerformedAtShop = last?.source === 'shop';
    const usingShopInterval = shopOverride?.useShop === true && lastPerformedAtShop;
    const intervalMiles = usingShopInterval && shopOverride.miles != null ? shopOverride.miles : (o.miles ?? null);
    const intervalMonths = usingShopInterval && shopOverride.months != null ? shopOverride.months : (o.months ?? null);

    if (dviMap.has(serviceKey)) usedDviKeys.add(serviceKey);

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
      const daysUntilDue = Math.round(milesToGo / milesPerDay);
      dueAtDate = new Date(today.getTime() + daysUntilDue * 24 * 60 * 60 * 1000);
    }
    
    if (dueAtDate && dueAtDate < earliestDate) dueAtDate = null;

    const daysToGo = dueAtDate != null ? Math.ceil((dueAtDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null;

    const dviInfo = dviMap.get(serviceKey);
    const declinedInfo = declinedMap.get(serviceKey) || null;
    const displayTitle = SERVICE_KEY_DISPLAY_NAMES[serviceKey] || o.name || "Maintenance Item";
    
    triaged.push({
      key: uniqueKey,
      serviceKey,
      title: displayTitle,
      category: o.category,
      intervalMiles,
      intervalMonths,
      last: last || undefined,
      dueAtMiles,
      dueAtDate,
      milesToGo,
      daysToGo,
      bump: dviInfo?.status ?? null,
      source: "oem",
      dviSource: dviInfo?.dviSource,
      declined: declinedInfo,
      usingShopInterval,
      matchedDeferred,
    });
  }

  for (const [dviKey, dviInfo] of dviMap) {
    if (usedDviKeys.has(dviKey)) continue;
    triaged.push({
      key: `dvi_${dviKey}`,
      serviceKey: dviKey,
      title: dviInfo.name,
      category: "DVI Finding",
      intervalMiles: null,
      intervalMonths: null,
      last: undefined,
      dueAtMiles: null,
      dueAtDate: null,
      milesToGo: null,
      daysToGo: null,
      bump: dviInfo.status,
      source: "dvi",
      dviSource: dviInfo.dviSource,
    });
  }

  for (const dw of protractorDeferredWork || []) {
    const title = dw.Title || dw.ServicePackageHeader?.Title || dw.Code || dw.Description || dw.ServicePackageHeader?.Description || "Deferred Service";
    const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seenDeferredTitles.has(normalizedTitle)) continue;
    seenDeferredTitles.delete(normalizedTitle);
    
    const protractorServiceKey = toKeyFromName(title) || `protractor_${dw.ID}`;
    if (deferredServiceKeysUsedByOem.has(protractorServiceKey)) continue;
    
    triaged.push({
      key: `protractor_${dw.ID}`,
      serviceKey: protractorServiceKey,
      title,
      category: "Shop Recommendation",
      intervalMiles: null,
      intervalMonths: null,
      last: undefined,
      dueAtMiles: null,
      dueAtDate: null,
      milesToGo: null,
      daysToGo: null,
      bump: "red",
      source: "protractor",
      reason: dw.Reason || undefined,
      protractorDeferredId: dw.ID || dw.ServiceItemID,
    });
  }

  const overdue: TriagedItem[] = [];
  const dueSoon: TriagedItem[] = [];
  const upcoming: TriagedItem[] = [];

  for (const t of triaged) {
    const mOver = t.milesToGo != null && t.milesToGo <= 0;
    const dOver = t.daysToGo != null && t.daysToGo <= 0;
    const mSoon = t.milesToGo != null && t.milesToGo > 0 && t.milesToGo <= soonMiles;
    const dSoon = t.daysToGo != null && t.daysToGo > 0 && t.daysToGo <= soonDays;

    if (t.bump === "red") { overdue.push(t); continue; }
    if (t.bump === "yellow") {
      if (!(mOver || dOver)) dueSoon.push(t);
      else overdue.push(t);
      continue;
    }

    if (mOver || dOver) overdue.push(t);
    else if (mSoon || dSoon) dueSoon.push(t);
    else upcoming.push(t);
  }

  const isInspectItem = (item: TriagedItem) => {
    const title = item.title?.toLowerCase() || "";
    return title.includes("inspect") || title.startsWith("check ");
  };

  overdue.sort((a, b) => {
    const aInspect = isInspectItem(a) ? 1 : 0;
    const bInspect = isInspectItem(b) ? 1 : 0;
    if (aInspect !== bInspect) return aInspect - bInspect;
    const aBehind = (a.milesToGo ?? 0) < 0 ? -(a.milesToGo ?? 0) : 0;
    const bBehind = (b.milesToGo ?? 0) < 0 ? -(b.milesToGo ?? 0) : 0;
    return bBehind - aBehind;
  });
  
  dueSoon.sort((a, b) => {
    const aInspect = isInspectItem(a) ? 1 : 0;
    const bInspect = isInspectItem(b) ? 1 : 0;
    if (aInspect !== bInspect) return aInspect - bInspect;
    const aLeft = a.milesToGo ?? Infinity;
    const bLeft = b.milesToGo ?? Infinity;
    return aLeft - bLeft;
  });

  return { overdue, dueSoon, upcoming };
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
    declined: item.declined,
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
    const soonMiles = shopDoc?.maintenance?.dueSoonMiles ?? shopDoc?.settings?.planPage?.soonMiles ?? DEFAULT_SOON_MILES;
    const soonDays = shopDoc?.maintenance?.dueSoonDays ?? shopDoc?.settings?.planPage?.soonDays ?? DEFAULT_SOON_DAYS;
    const showInspectItems = shopDoc?.settings?.planPage?.showInspectItems ?? false;
    const distanceUnit = (shopDoc?.settings?.distanceUnit ?? "miles") as "miles" | "kilometers";
    const shopIntervals: Record<string, ShopIntervalOverride> = shopDoc?.maintenance?.intervals ?? {};

    const vinUpper = vin.toUpperCase();
    const vinRegex = new RegExp(`^${vinUpper}$`, 'i');

    const [autoCfg, carfaxCfg, protractorCfg, autoVitalsCfg, oemData] = await Promise.all([
      resolveAutoflowConfig(shopId),
      resolveCarfaxConfig(shopId),
      resolveProtractorConfig(shopId),
      resolveAutoVitalsConfig(shopId),
      getMaintenanceScheduleCached(vin),
    ]);

    const vehicleDoc = await db.collection("vehicles").findOne(
      { shopId, vin: vinUpper },
      { projection: { year: 1, make: 1, model: 1, declinedServices: 1 } }
    );
    const vehicleYear = vehicleDoc?.year ?? oemData.vehicle?.year ?? null;

    const [protractorWOs, tekmetricWOs] = await Promise.all([
      db.collection("protractor_work_orders").find({
        shopId,
        $or: [
          { vin: vinUpper },
          { "data.VIN": vinUpper },
          { "ServiceItem.VIN": vinUpper }
        ]
      }).sort({ "Header.LastModifiedTime": -1 }).limit(20).toArray(),
      db.collection("tekmetric_work_orders").find({
        shopId: { $in: [String(shopId), Number(shopId)] },
        vin: vinUpper
      }).sort({ completedDate: -1 }).limit(50).toArray(),
    ]);

    const shopServiceHistory: ShopServiceHistory[] = [];
    for (const wo of protractorWOs) {
      const wMileage = wo.Odometer ?? wo.OutUsage ?? wo.data?.Odometer ?? null;
      const dateStr = wo.Header?.LastModifiedTime ?? wo.Header?.CreationTime ?? wo.data?.Header?.LastModifiedTime ?? null;
      const date = dateStr ? new Date(dateStr) : null;
      const servicePackages = wo.ServicePackages ?? wo.data?.ServicePackages ?? [];
      for (const pkg of servicePackages) {
        const serviceName = pkg.Title ?? pkg.Description ?? "";
        if (serviceName) shopServiceHistory.push({ serviceName, mileage: wMileage, date });
        for (const line of pkg.ServicePackageLines ?? []) {
          const lineName = line.Description ?? "";
          if (lineName && lineName !== serviceName) shopServiceHistory.push({ serviceName: lineName, mileage: wMileage, date });
        }
      }
    }
    for (const wo of tekmetricWOs) {
      const wMileage = wo.odometer ?? wo.data?.milesOut ?? wo.data?.milesIn ?? null;
      const date = wo.completedDate ? new Date(wo.completedDate) : null;
      const jobs = wo.data?.jobs ?? wo.jobs ?? [];
      for (const job of jobs) {
        const serviceName = job.name ?? job.description ?? "";
        if (serviceName) shopServiceHistory.push({ serviceName, mileage: wMileage, date });
      }
    }

    let latestRoNumber: string | null = null;
    if (protractorWOs.length > 0) {
      const wo = protractorWOs[0];
      latestRoNumber = wo.workOrderNumber || wo.WorkOrderNumber || wo.data?.WorkOrderNumber || null;
    }

    const [carfaxResult, protractorVehicleResult, avInspectionResult] = await Promise.all([
      carfaxCfg.configured ? fetchCarfaxWithCache(shopId, vin, CACHE_TTL_MS) : Promise.resolve({ ok: false }),
      protractorCfg.configured ? fetchProtractorVehicle(shopId, vin, PROTRACTOR_CACHE_TTL) : Promise.resolve({ ok: false }),
      autoVitalsCfg.configured ? fetchAutoVitalsInspectionByVin(shopId, vin, PROTRACTOR_CACHE_TTL) : Promise.resolve({ ok: false }),
    ]);

    let dvi: any = { ok: false };
    if (latestRoNumber && autoCfg.configured) {
      dvi = await fetchDviWithCache(shopId, String(latestRoNumber), DVI_CACHE_TTL);
    }

    const autoflowDviFindings: Array<{ name?: string; status?: string | number; source?: string }> =
      (dvi as any).ok && Array.isArray((dvi as any).categories)
        ? (dvi as any).categories.flatMap((c: any) =>
            Array.isArray(c.items) ? c.items.map((it: any) => ({ name: it.name, status: it.status, source: "autoflow" })) : []
          )
        : [];

    let autoVitalsDviFindings: Array<{ name?: string; status?: string | number; source?: string }> = [];
    if ((avInspectionResult as any).ok && (avInspectionResult as any).items) {
      autoVitalsDviFindings = (avInspectionResult as any).items
        .filter((item: any) => item.status === "red" || item.status === "yellow")
        .map((item: any) => ({
          name: item.name,
          status: item.status === "red" ? "0" : "1",
          source: "autovitals"
        }));
    }

    const dviFindings = [...autoflowDviFindings, ...autoVitalsDviFindings];

    let protractorDeferredWork: ProtractorDeferredWork[] = [];
    if (protractorCfg.configured && (protractorVehicleResult as any).ok && (protractorVehicleResult as any).vehicle?.ID) {
      const deferredResult = await fetchProtractorDeferredWork(shopId, vin, (protractorVehicleResult as any).vehicle.ID, PROTRACTOR_CACHE_TTL);
      if (deferredResult.ok && deferredResult.deferredWork) {
        protractorDeferredWork = deferredResult.deferredWork;
      }
    }

    const carfaxRecords = (carfaxResult as any).ok ? ((carfaxResult as any).serviceRecords || []) : [];
    
    let mpdBlended: number | null = null;
    if ((carfaxResult as any).ok && Array.isArray((carfaxResult as any).serviceRecords)) {
      const recs = (carfaxResult as any).serviceRecords
        .map((r: any) => ({ date: parseCarfaxDate(r?.date ?? null), miles: typeof r?.odometer === "number" ? r.odometer : null }))
        .filter((r: any) => r.date && typeof r.miles === "number") as { date: Date; miles: number }[];
      recs.sort((a, b) => b.date.getTime() - a.date.getTime());

      const todayMiles = mileage;
      let fromToday: number | null = null, fromTwo: number | null = null;

      if (todayMiles != null && recs[0]) {
        const d = Math.max(1, Math.abs(new Date().getTime() - recs[0].date.getTime()) / (1000 * 60 * 60 * 24));
        const val = (todayMiles - recs[0].miles) / d;
        fromToday = Math.abs(val) < 0.01 ? null : val;
      }
      if (recs[0] && recs[1]) {
        const d = Math.max(1, Math.abs(recs[0].date.getTime() - recs[1].date.getTime()) / (1000 * 60 * 60 * 24));
        fromTwo = (recs[0].miles - recs[1].miles) / d;
      }
      mpdBlended = fromToday != null && fromTwo != null ? (fromToday + fromTwo) / 2 : fromTwo ?? fromToday ?? null;
    }

    const oemItems: OEMItem[] = (oemData.items || []).map((item: any) => ({
      maintenance_id: item.maintenance_id,
      name: item.maintenance_name || item.name,
      category: item.maintenance_category || item.category,
      miles: item.miles,
      months: item.months,
    }));

    const declinedServices: DeclinedServiceEntry[] = (vehicleDoc?.declinedServices || []).map((d: any) => ({
      serviceKey: d.serviceKey,
      serviceName: d.serviceName,
      mileage: d.mileage ?? null,
      reason: d.reason ?? null,
      declinedAt: d.declinedAt,
    }));

    let customerName: string | null = null;
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

    if (!customerName && protractorCfg.configured && (protractorVehicleResult as any).ok) {
      const v = (protractorVehicleResult as any).vehicle;
      customerName = v?.CustomerName || [v?.FirstName, v?.LastName].filter(Boolean).join(" ") || null;
    }

    const buckets = triage({
      oemItems,
      carfaxRecords,
      shopServiceHistory,
      currentMiles: mileage,
      dviFindings,
      protractorDeferredWork,
      declinedServices,
      soonMiles,
      soonDays,
      milesPerDay: mpdBlended,
      shopIntervals,
      vehicleYear,
    });

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
      deferredWork: protractorDeferredWork.length > 0 ? protractorDeferredWork.map(dw => ({
        ID: dw.ID,
        ServiceItemID: dw.ServiceItemID,
        Title: dw.Title,
        Description: dw.Description,
      })) : undefined,
    };

    await setCachedPlan(db, vin, shopId, mileage, planData);

    const duration = Date.now() - startTime;
    console.log(`[PlanBuild] Shop ${shopId}: Built and cached plan for ${vin} in ${duration}ms (OEM: ${oemItems.length}, Carfax: ${carfaxRecords.length}, ShopHistory: ${shopServiceHistory.length}, DVI: ${dviFindings.length}, Deferred: ${protractorDeferredWork.length})`);

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
