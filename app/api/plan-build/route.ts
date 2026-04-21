import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getCachedPlan, setCachedPlan, type CachedPlanData, type TriagedItemCache } from "@/lib/plan-cache";
import { SERVICE_KEYS, SERVICE_KEY_DISPLAY_NAMES, toKeyFromName, toKeyFromFreeText } from "@/lib/service-keys";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours
const PROTRACTOR_CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours
const DVI_CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days
const DEFAULT_SOON_MILES = 1000;
const DEFAULT_SOON_DAYS = 30;

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
  excluded?: boolean;
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
  source?: "oem" | "dvi" | "protractor" | "common";
  dviSource?: "autoflow" | "autovitals" | "tekmetric";
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
  intervalApplyMode = "always",
  vehicleYear = null,
  vehicleTransType = null,
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
  intervalApplyMode?: string;
  vehicleYear?: number | null;
  vehicleTransType?: string | null;
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

  const dviMap = new Map<string, { status: "red" | "yellow"; name: string; dviSource?: "autoflow" | "autovitals" | "tekmetric" }>();
  const unmappedDviFindings: Array<{ status: "red" | "yellow"; name: string; dviSource: "autoflow" | "autovitals" | "tekmetric" }> = [];
  for (const it of dviFindings || []) {
    const rawName = String(it.name || "");
    if (!rawName) continue;
    const key = toKeyFromName(rawName);
    const s = String(it.status ?? "");
    const dviSource = (it.source === "autovitals" ? "autovitals" : it.source === "tekmetric" ? "tekmetric" : "autoflow") as "autoflow" | "autovitals" | "tekmetric";
    const mappedStatus = s === "0" ? "red" : s === "1" ? "yellow" : null;
    if (!mappedStatus) continue;
    if (key) {
      if (mappedStatus === "red") dviMap.set(key, { status: "red", name: rawName, dviSource });
      else if (dviMap.get(key)?.status !== "red") dviMap.set(key, { status: "yellow", name: rawName, dviSource });
    } else {
      unmappedDviFindings.push({ status: mappedStatus, name: rawName, dviSource });
    }
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

  const resolvedTransType = vehicleTransType?.toLowerCase().trim() || null;
  const isAutomatic = resolvedTransType ? (resolvedTransType.includes("auto") || resolvedTransType.includes("cvt")) : null;
  const isManual = resolvedTransType ? resolvedTransType.includes("manual") : null;

  for (const o of oemItems) {
    const serviceKey = toKeyFromName(o.name || "") || `misc_${o.maintenance_id}`;

    if (isAutomatic !== null) {
      if (serviceKey === "trans_manual" && isAutomatic) continue;
      if (serviceKey === "trans_auto" && isManual) continue;
    }

    const matchedDeferred = deferredByServiceKey.get(serviceKey);
    if (matchedDeferred) deferredServiceKeysUsedByOem.add(serviceKey);
    if (usedServiceKeys.has(serviceKey) && !serviceKey.startsWith("misc_")) continue;
    usedServiceKeys.add(serviceKey);
    
    const uniqueKey = `${serviceKey}_${o.maintenance_id}`;
    const last = lastMap.get(serviceKey) ?? null;
    
    const shopOverride = shopIntervals[serviceKey];
    if (shopOverride?.excluded) {
      continue;
    }
    const lastPerformedAtShop = last?.source === 'shop';
    const usingShopInterval = shopOverride?.useShop === true && (intervalApplyMode === 'always' || lastPerformedAtShop);
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

    if (milesToGo != null && milesPerDay != null && milesPerDay > 0) {
      const daysUntilDue = Math.round(milesToGo / milesPerDay);
      const mileageBasedDate = new Date(today.getTime() + daysUntilDue * 24 * 60 * 60 * 1000);
      if (dueAtDate == null || mileageBasedDate < dueAtDate) {
        dueAtDate = mileageBasedDate;
      }
    }
    
    if (dueAtDate && dueAtDate < earliestDate) dueAtDate = null;

    const daysToGo = dueAtDate != null ? Math.ceil((dueAtDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null;

    const dviInfo = dviMap.get(serviceKey);
    const declinedInfo = declinedMap.get(serviceKey) || null;
    const displayTitle = o.name || SERVICE_KEY_DISPLAY_NAMES[serviceKey] || "Maintenance Item";
    
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
      reason: neverDone ? "No record of this service being performed." : undefined,
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

  for (const unmapped of unmappedDviFindings) {
    const safeKey = `dvi_unmapped_${unmapped.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`;
    triaged.push({
      key: safeKey,
      serviceKey: safeKey,
      title: unmapped.name,
      category: "DVI Finding",
      intervalMiles: null,
      intervalMonths: null,
      last: undefined,
      dueAtMiles: null,
      dueAtDate: null,
      milesToGo: null,
      daysToGo: null,
      bump: unmapped.status,
      source: "dvi",
      dviSource: unmapped.dviSource,
    });
  }

  const COMMON_MAINTENANCE: Array<{
    serviceKey: string;
    title: string;
    category: string;
    miles: number | null;
    months: number | null;
  }> = [
    { serviceKey: "wheel_alignment", title: "Wheel Alignment", category: "Tires and Wheels", miles: 12000, months: 12 },
    { serviceKey: "power_steering", title: "Power Steering Fluid", category: "Drivetrain", miles: 50000, months: null },
    { serviceKey: "front_shocks", title: "Front Shocks / Struts", category: "Suspension", miles: 75000, months: null },
    { serviceKey: "rear_shocks", title: "Rear Shocks / Struts", category: "Suspension", miles: 75000, months: null },
    { serviceKey: "wiper_blades", title: "Wiper Blades", category: "General", miles: null, months: 12 },
    { serviceKey: "battery", title: "Battery", category: "Electrical", miles: null, months: 48 },
    { serviceKey: "fuel_system", title: "Fuel System Cleaning", category: "Engine", miles: 60000, months: null },
    { serviceKey: "coolant_hoses", title: "Coolant Hoses", category: "Coolant System", miles: 60000, months: null },
  ];

  for (const cm of COMMON_MAINTENANCE) {
    if (usedServiceKeys.has(cm.serviceKey)) continue;

    const shopOverride = shopIntervals[cm.serviceKey];
    if (shopOverride?.excluded) continue;

    usedServiceKeys.add(cm.serviceKey);
    const last = lastMap.get(cm.serviceKey) ?? null;
    const lastPerformedAtShop = last?.source === 'shop';
    const usingShopInterval = shopOverride?.useShop === true && (intervalApplyMode === 'always' || lastPerformedAtShop);
    const intervalMiles = usingShopInterval && shopOverride.miles != null ? shopOverride.miles : cm.miles;
    const intervalMonths = usingShopInterval && shopOverride.months != null ? shopOverride.months : cm.months;

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

    if (milesToGo != null && milesPerDay != null && milesPerDay > 0) {
      const daysUntilDue = Math.round(milesToGo / milesPerDay);
      const mileageBasedDate = new Date(today.getTime() + daysUntilDue * 24 * 60 * 60 * 1000);
      if (dueAtDate == null || mileageBasedDate < dueAtDate) {
        dueAtDate = mileageBasedDate;
      }
    }

    if (dueAtDate && dueAtDate < earliestDate) dueAtDate = null;

    if (dueAtMiles == null && dueAtDate == null) continue;

    const daysToGo = dueAtDate != null ? Math.ceil((dueAtDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null;

    const declinedInfo = declinedMap.get(cm.serviceKey) || null;
    const matchedDeferred = deferredByServiceKey.get(cm.serviceKey) || null;
    if (matchedDeferred) deferredServiceKeysUsedByOem.add(cm.serviceKey);

    triaged.push({
      key: `common_${cm.serviceKey}`,
      serviceKey: cm.serviceKey,
      title: cm.title,
      category: cm.category,
      intervalMiles,
      intervalMonths,
      last,
      dueAtMiles,
      dueAtDate,
      milesToGo,
      daysToGo,
      bump: null,
      source: "common",
      reason: neverDone ? "No record of this service being performed." : undefined,
      usingShopInterval,
      declined: declinedInfo,
      matchedDeferred: matchedDeferred || undefined,
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

  const hasDviBump = (item: TriagedItem) => item.bump === "red" || item.bump === "yellow";

  overdue.sort((a, b) => {
    const aDvi = hasDviBump(a) ? 0 : 1;
    const bDvi = hasDviBump(b) ? 0 : 1;
    if (aDvi !== bDvi) return aDvi - bDvi;
    const aInspect = isInspectItem(a) ? 1 : 0;
    const bInspect = isInspectItem(b) ? 1 : 0;
    if (aInspect !== bInspect) return aInspect - bInspect;
    const aBehind = (a.milesToGo ?? 0) < 0 ? -(a.milesToGo ?? 0) : 0;
    const bBehind = (b.milesToGo ?? 0) < 0 ? -(b.milesToGo ?? 0) : 0;
    return bBehind - aBehind;
  });
  
  dueSoon.sort((a, b) => {
    const aDvi = hasDviBump(a) ? 0 : 1;
    const bDvi = hasDviBump(b) ? 0 : 1;
    if (aDvi !== bDvi) return aDvi - bDvi;
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
    let shopId: number;
    
    const internalSecret = req.headers.get("x-internal-secret");
    const internalShopId = req.headers.get("x-internal-shop-id");
    if (
      internalSecret &&
      internalShopId &&
      process.env.DATABASE_URL &&
      internalSecret === Buffer.from(process.env.DATABASE_URL).toString("base64").slice(0, 32)
    ) {
      shopId = Number(internalShopId);
    } else {
      const session = await getSession();
      if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      shopId = Number(session.shopId);
    }

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
    const rawIntervals: Record<string, ShopIntervalOverride> = shopDoc?.maintenance?.intervals ?? {};
    const intervalApplyMode: string = shopDoc?.maintenance?.intervalApplyMode || "always";
    const LEGACY_KEY_MAP: Record<string, string[]> = {
      differential: ["front_differential", "rear_differential"],
      alignment: ["wheel_alignment"],
      brake_pads: ["front_brake_pads", "rear_brake_pads"],
    };
    const shopIntervals: Record<string, ShopIntervalOverride> = { ...rawIntervals };
    for (const [oldKey, newKeys] of Object.entries(LEGACY_KEY_MAP)) {
      if (shopIntervals[oldKey]) {
        for (const nk of newKeys) {
          if (!shopIntervals[nk]) shopIntervals[nk] = shopIntervals[oldKey];
        }
      }
    }

    const vinUpper = vin.toUpperCase();
    const vinRegex = new RegExp(`^${vinUpper}$`, 'i');

    const oemWithTimeout = Promise.race([
      getMaintenanceScheduleCached(vin),
      new Promise<Awaited<ReturnType<typeof getMaintenanceScheduleCached>>>((resolve) =>
        setTimeout(() => {
          console.warn(`[PlanBuild] DataOne timeout for ${vin}, continuing without OEM data`);
          resolve({ ok: false, vin, squish: '', count: 0, items: [], error: 'timeout', source: 'cache' as const });
        }, 15000)
      )
    ]);
    const [autoCfg, carfaxCfg, protractorCfg, autoVitalsCfg, oemData] = await Promise.all([
      resolveAutoflowConfig(shopId),
      resolveCarfaxConfig(shopId),
      resolveProtractorConfig(shopId),
      resolveAutoVitalsConfig(shopId),
      oemWithTimeout,
    ]);

    const vehicleDoc = await db.collection("vehicles").findOne(
      { shopId, vin: vinUpper },
      { projection: { year: 1, make: 1, model: 1, declinedServices: 1 } }
    );
    const vehicleYear = vehicleDoc?.year ?? oemData.vehicle?.year ?? null;
    const vehicleTransType: string | null = (oemData.vehicle as any)?.transType || null;

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
    // Track which (workOrderId, servicePackageId) combos came from full WO docs
    // so the job_index fallback below doesn't double-count them.
    const seenFromWoDocs = new Set<string>();

    for (const wo of tekmetricWOs) {
      // Treat status as "closed" if completedDate is present OR statusCode is terminal.
      // Older/backfilled WO docs may have completedDate=null/undefined even though
      // they're truly invoiced — so we also accept a terminal statusCode.
      const statusCode = String(wo.statusCode || wo.data?.repairOrderStatus?.code || "").toUpperCase();
      const terminalStatus = ["POSTED", "INVOICED", "INVOICE", "COMPLETED", "CLOSED"].includes(statusCode);
      const isCompleted = !!wo.completedDate || terminalStatus;
      const wMileage = wo.odometer ?? wo.data?.milesOut ?? wo.data?.milesIn ?? null;
      const date = wo.completedDate
        ? new Date(wo.completedDate)
        : (wo.updatedDate ? new Date(wo.updatedDate) : null);
      const jobs = wo.data?.jobs ?? wo.jobs ?? [];
      for (const job of jobs) {
        if (!isCompleted && !job.authorized) continue;
        const serviceName = job.name ?? job.description ?? "";
        if (serviceName) shopServiceHistory.push({ serviceName, mileage: wMileage, date });
        if (job.id != null) {
          seenFromWoDocs.add(`${wo.workOrderId}:${job.id}`);
        }
      }
    }

    // ---- job_index fallback ----
    // tekmetric_work_orders is often sparse (full WO docs missing or lacking
    // jobs[]) for shops with backfill but limited live sync. job_index is the
    // authoritative shop-history table written by every backfill / cron / webhook.
    // Pull it as a defensive secondary source so plan-build never misses real
    // service history just because the WO doc didn't get jobs persisted.
    try {
      // Sort newest-first so when limit truncates we keep the most recent
      // service history (oldest entries are far less useful for "last service"
      // signals). Without explicit sort, Mongo natural order is non-deterministic.
      const jobIndexEntries = await db.collection("job_index").find({
        shopId: { $in: [Number(shopId), String(shopId)] },
        $or: [
          { "vehicle.vin": vinUpper },
          { vin: vinUpper },
        ],
      })
        .sort({ closedAt: -1, performedAt: -1, completedAt: -1, indexedAt: -1 })
        .limit(500)
        .toArray();

      // Track ALL appended (workOrderId, servicePackageId) keys — including
      // those added by this fallback — to prevent duplicates from cross-source
      // collisions in job_index itself, not just WO-loop overlaps.
      const seenAppendedKeys = new Set<string>(seenFromWoDocs);

      for (const ji of jobIndexEntries) {
        const woId = String(ji.workOrderId ?? "");
        const svcId = String(ji.servicePackageId ?? "");
        const dedupKey = `${woId}:${svcId}`;
        if (woId && svcId && seenAppendedKeys.has(dedupKey)) continue;

        const serviceName = ji.jobName || ji.job?.title || ji.title || "";
        if (!serviceName) continue;

        const dateRaw = ji.closedAt || ji.performedAt || ji.completedAt || ji.indexedAt || null;
        const date = dateRaw ? new Date(dateRaw) : null;
        if (date && isNaN(date.getTime())) continue;

        const mileage =
          (typeof ji.mileage === "number" ? ji.mileage : null) ??
          (typeof ji.odometer === "number" ? ji.odometer : null) ??
          (typeof ji.vehicle?.mileage === "number" ? ji.vehicle.mileage : null) ??
          null;

        shopServiceHistory.push({ serviceName, mileage, date });
        if (woId && svcId) seenAppendedKeys.add(dedupKey);
      }

      if (jobIndexEntries.length > 0) {
        console.log(
          `[PlanBuild] Shop ${shopId} VIN ${vinUpper}: pulled ${jobIndexEntries.length} job_index entries as shop-history fallback`
        );
      }
    } catch (jiErr: any) {
      console.warn(`[PlanBuild] job_index fallback failed for ${vinUpper}: ${jiErr.message}`);
    }

    const unmatchedJobNames: string[] = [];
    for (const sh of shopServiceHistory) {
      const keys = toKeyFromFreeText(sh.serviceName || "");
      if (keys.length === 0 && sh.serviceName) {
        unmatchedJobNames.push(sh.serviceName);
      }
    }
    if (unmatchedJobNames.length > 0) {
      console.log(`[PlanBuild] Shop ${shopId} VIN ${vin}: ${unmatchedJobNames.length} unmatched job names: ${unmatchedJobNames.slice(0, 10).join(" | ")}`);
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

    let tekmetricDviFindings: Array<{ name?: string; status?: string | number; source?: string; finding?: string }> = [];
    if (tekmetricWOs.length > 0) {
      for (const tekRo of tekmetricWOs) {
        const woInspections = tekRo.inspections || [];
        if (!Array.isArray(woInspections) || woInspections.length === 0) continue;
        for (const inspection of woInspections) {
          for (const group of inspection.inspectionTasks || []) {
            for (const task of group.tasks || []) {
              const code = task.inspectionRating?.code;
              if (code === "RQRSATTN") {
                tekmetricDviFindings.push({ name: task.name, status: "0", source: "tekmetric", finding: task.finding });
              } else if (code === "MAYRQRATTN") {
                tekmetricDviFindings.push({ name: task.name, status: "1", source: "tekmetric", finding: task.finding });
              }
            }
          }
          if (tekmetricDviFindings.length === 0 && inspection.items) {
            for (const item of inspection.items) {
              if (item.status === "bad") {
                tekmetricDviFindings.push({ name: item.name, status: "0", source: "tekmetric" });
              } else if (item.status === "marginal") {
                tekmetricDviFindings.push({ name: item.name, status: "1", source: "tekmetric" });
              }
            }
          }
        }
        if (tekmetricDviFindings.length > 0) {
          console.log(`[PlanBuild] Tekmetric DVI: ${tekmetricDviFindings.length} findings from cached inspections on RO ${tekRo.workOrderId}`);
          break;
        }
      }
    }

    let unresolvedHistoricalFindings: Array<{ name?: string; status?: string | number; source?: string }> = [];
    if (tekmetricWOs.length > 0) {
      const historicalItems: Array<{
        name: string;
        status: "bad" | "marginal";
        inspectionDate: Date | null;
        workOrderId: string;
      }> = [];

      for (const wo of tekmetricWOs) {
        const woInspections = wo.inspections || [];
        if (!Array.isArray(woInspections) || woInspections.length === 0) continue;
        const woDate = wo.completedDate ? new Date(wo.completedDate) 
          : wo.updatedDate ? new Date(wo.updatedDate) 
          : wo.createdDate ? new Date(wo.createdDate) : null;

        for (const insp of woInspections) {
          let foundFromGroups = false;
          for (const group of insp.inspectionTasks || []) {
            for (const task of group.tasks || []) {
              const code = task.inspectionRating?.code;
              if (code === "RQRSATTN" || code === "MAYRQRATTN") {
                foundFromGroups = true;
                historicalItems.push({
                  name: task.name || "",
                  status: code === "RQRSATTN" ? "bad" : "marginal",
                  inspectionDate: woDate,
                  workOrderId: String(wo.workOrderId),
                });
              }
            }
          }
          if (!foundFromGroups) {
            for (const item of insp.items || []) {
              if (item.status === "bad" || item.status === "marginal") {
                historicalItems.push({
                  name: item.name || item.categoryName || "",
                  status: item.status,
                  inspectionDate: woDate,
                  workOrderId: String(wo.workOrderId),
                });
              }
            }
          }
        }
      }

      if (historicalItems.length > 0) {
        const allHistoryByKey = new Map<string, { date: Date | null }[]>();
        for (const sh of shopServiceHistory) {
          const keys = toKeyFromFreeText(sh.serviceName || "");
          for (const k of keys) {
            if (!allHistoryByKey.has(k)) allHistoryByKey.set(k, []);
            allHistoryByKey.get(k)!.push({ date: sh.date });
          }
        }

        for (const r of (carfaxResult as any).ok ? ((carfaxResult as any).serviceRecords || []) : []) {
          const desc = String(r.description || "").trim();
          const rDate = parseCarfaxDate(r?.date ?? null);
          const keys = toKeyFromFreeText(desc);
          for (const k of keys) {
            if (!allHistoryByKey.has(k)) allHistoryByKey.set(k, []);
            allHistoryByKey.get(k)!.push({ date: rDate });
          }
        }

        const seenUnresolved = new Set<string>();
        const currentDviNames = new Set(
          [...autoflowDviFindings, ...autoVitalsDviFindings, ...tekmetricDviFindings]
            .map(f => (f.name || "").toLowerCase().trim())
            .filter(Boolean)
        );

        for (const hi of historicalItems) {
          if (!hi.name) continue;
          const nameLower = hi.name.toLowerCase().trim();
          if (currentDviNames.has(nameLower)) continue;

          const serviceKey = toKeyFromName(hi.name);
          const dedupKey = serviceKey || nameLower;
          if (seenUnresolved.has(dedupKey)) continue;

          let remedied = false;
          if (hi.inspectionDate) {
            if (serviceKey) {
              const serviceRecords = allHistoryByKey.get(serviceKey) || [];
              remedied = serviceRecords.some(sr => 
                sr.date && sr.date.getTime() > hi.inspectionDate!.getTime()
              );
            }
            if (!remedied) {
              remedied = shopServiceHistory.some(sh => {
                if (!sh.date || sh.date.getTime() <= hi.inspectionDate!.getTime()) return false;
                const shName = (sh.serviceName || "").toLowerCase();
                return shName.includes(nameLower) || nameLower.includes(shName);
              });
            }
          }

          if (!remedied) {
            seenUnresolved.add(dedupKey);
            unresolvedHistoricalFindings.push({
              name: hi.name,
              status: hi.status === "bad" ? "0" : "1",
              source: "tekmetric",
            });
          }
        }

        if (unresolvedHistoricalFindings.length > 0) {
          console.log(`[PlanBuild] Unresolved historical inspections for ${vin}: ${unresolvedHistoricalFindings.length} items`);
        }
      }
    }

    const dviFindings = [...autoflowDviFindings, ...autoVitalsDviFindings, ...tekmetricDviFindings, ...unresolvedHistoricalFindings];

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
    const tekmetricShopId = shopDoc?.tekmetric?.shopId || shopDoc?.tekmetricShopId;
    if (tekmetricShopId) {
      try {
        const cachedWO = await db.collection("tekmetric_work_orders").findOne(
          {
            vin: { $regex: new RegExp(`^${vin}$`, "i") },
            $or: [
              { tekmetricShopId: Number(tekmetricShopId) },
              { tekmetricShopId: String(tekmetricShopId) },
              { shopId: String(shopId) },
              { shopId: Number(shopId) },
            ],
          },
          { sort: { updatedAt: -1, createdAt: -1 }, projection: { workOrderNumber: 1, customerName: 1 } }
        );
        if (cachedWO) {
          if (cachedWO.workOrderNumber) latestRoNumber = String(cachedWO.workOrderNumber);
          if (cachedWO.customerName && cachedWO.customerName !== "Unknown Customer") {
            customerName = cachedWO.customerName;
          }
        }
      } catch (err) {
        console.log(`[PlanBuild] MongoDB WO lookup error for ${vin}:`, err);
      }
    }

    if (!customerName && protractorCfg.configured && (protractorVehicleResult as any).ok) {
      const v = (protractorVehicleResult as any).vehicle;
      customerName = v?.CustomerName || [v?.FirstName, v?.LastName].filter(Boolean).join(" ") || null;
    }

    if (!customerName) {
      try {
        const swRo = await db.collection("cached_work_orders").findOne(
          {
            vin: vin.toUpperCase(),
            shopId: { $in: [String(shopId), Number(shopId)] },
            customerName: { $exists: true, $nin: [null, ""] },
          },
          { sort: { createdAt: -1 }, projection: { customerName: 1 } }
        );
        if (swRo?.customerName) customerName = swRo.customerName;
      } catch (err) {
        console.log(`[PlanBuild] cached_work_orders customer lookup error for ${vin}:`, err);
      }
    }

    if (!customerName) {
      try {
        const vDoc = await db.collection("vehicles").findOne(
          {
            vin: vin.toUpperCase(),
            shopId: { $in: [String(shopId), Number(shopId)] },
            customerName: { $exists: true, $nin: [null, ""] },
          },
          { projection: { customerName: 1 } }
        );
        if (vDoc?.customerName) customerName = vDoc.customerName;
      } catch (err) {
        console.log(`[PlanBuild] vehicles customer lookup error for ${vin}:`, err);
      }
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
      intervalApplyMode,
      vehicleYear,
      vehicleTransType,
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
    console.log(`[PlanBuild] Shop ${shopId}: Built and cached plan for ${vin} in ${duration}ms (OEM: ${oemItems.length}, Carfax: ${carfaxRecords.length}, ShopHistory: ${shopServiceHistory.length}, DVI: ${dviFindings.length}, UnresolvedHistory: ${unresolvedHistoricalFindings.length}, Deferred: ${protractorDeferredWork.length})`);

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
