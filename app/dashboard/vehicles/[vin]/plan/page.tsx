import { Suspense } from "react";
import Link from "next/link";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";
import { 
  resolveAutoflowConfig, 
  fetchDviWithCache 
} from "@/lib/integrations/autoflow";
import { 
  resolveCarfaxConfig, 
  fetchCarfaxWithCache 
} from "@/lib/integrations/carfax";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import {
  resolveProtractorConfig,
  fetchVehicleWithCache as fetchProtractorVehicle,
  fetchDeferredWorkWithCache as fetchProtractorDeferredWork,
  getCannedJobsFromCache,
  type ProtractorDeferredWork,
} from "@/lib/integrations/protractor";
import {
  resolveAutoVitalsConfig,
  fetchAutoVitalsInspectionByVin,
} from "@/lib/integrations/autovitals";
import { AddToROButton } from "@/components/ui/AddToROButton";
import { AddToROWithHistory } from "@/components/ui/AddToROWithHistory";
import { PlanTrialGate } from "@/components/ui/PlanTrialGate";
import { PrintButton } from "@/components/ui/PrintButton";
import PlanLoading from "./loading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------------- small utils ---------------- */
type DistanceUnit = "miles" | "kilometers";
const MILES_TO_KM = 1.60934;

function fmtDistance(m?: number | null, unit: DistanceUnit = "miles") {
  if (m === 0) return "0";
  if (m == null) return "";
  const value = unit === "kilometers" ? Math.round(m * MILES_TO_KM) : m;
  return value.toLocaleString();
}

function fmtMiles(m?: number | null) {
  if (m === 0) return "0";
  if (m == null) return "";
  return m.toLocaleString();
}

function getDistanceLabel(unit: DistanceUnit): string {
  return unit === "kilometers" ? "km" : "mi";
}
function daysBetween(a: Date, b: Date) {
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms / (1000 * 60 * 60 * 24);
}
function addMonths(d: Date, months: number) {
  const dt = new Date(d);
  dt.setMonth(dt.getMonth() + months);
  return dt;
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
function toSquish(vin: string) {
  const v = String(vin).toUpperCase().trim();
  return v.slice(0, 8) + v.slice(9, 11);
}

function formatOverdueDate(date: Date | null | undefined): { text: string; isVeryOverdue: boolean; yearsOverdue: number } {
  if (!date) return { text: "", isVeryOverdue: false, yearsOverdue: 0 };
  const now = new Date();
  const daysPast = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  const yearsOverdue = Math.floor(daysPast / 365);
  const monthsOverdue = Math.floor(daysPast / 30);
  
  let text = date.toLocaleDateString();
  if (yearsOverdue >= 1) {
    text = `${date.toLocaleDateString()} (${yearsOverdue}+ years overdue!)`;
  } else if (monthsOverdue >= 6) {
    text = `${date.toLocaleDateString()} (${monthsOverdue} months overdue)`;
  }
  
  return { 
    text, 
    isVeryOverdue: yearsOverdue >= 1 || monthsOverdue >= 6,
    yearsOverdue 
  };
}

/* ---------------- Smart mileage interpolation for CARFAX gaps ---------------- */
type CarfaxRecordWithParsed = {
  date: Date | null;
  miles: number | null;
  description?: string;
};

function fillCarfaxMileageGaps(
  records: Array<{ date?: string; odometer?: number; description?: string }>,
  opts: { today: Date; currentMiles: number | null; defaultRate: number | null }
): CarfaxRecordWithParsed[] {
  // Parse and sort by date ascending
  const parsed: CarfaxRecordWithParsed[] = records.map(r => ({
    date: parseCarfaxDate(r.date ?? null),
    miles: typeof r.odometer === "number" && r.odometer > 0 ? r.odometer : null,
    description: r.description,
  }));

  // Sort by date (nulls at end)
  parsed.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.getTime() - b.date.getTime();
  });

  // Build list of records with known mileage for interpolation reference
  const knownPoints: Array<{ date: Date; miles: number; index: number }> = [];
  for (let i = 0; i < parsed.length; i++) {
    const rec = parsed[i];
    if (rec.date && rec.miles != null) {
      knownPoints.push({ date: rec.date, miles: rec.miles, index: i });
    }
  }

  // Add current mileage as a reference point if available
  if (opts.currentMiles != null) {
    knownPoints.push({ date: opts.today, miles: opts.currentMiles, index: -1 });
    knownPoints.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  // Fill gaps using interpolation or extrapolation
  for (let i = 0; i < parsed.length; i++) {
    const rec = parsed[i];
    if (rec.miles != null || !rec.date) continue; // Already has miles or no date

    const recTime = rec.date.getTime();

    // Find closest known points before and after
    let before: { date: Date; miles: number } | null = null;
    let after: { date: Date; miles: number } | null = null;

    for (const kp of knownPoints) {
      if (kp.date.getTime() <= recTime) {
        before = kp;
      } else if (!after) {
        after = kp;
        break;
      }
    }

    if (before && after) {
      // Interpolate between two known points
      const totalDays = (after.date.getTime() - before.date.getTime()) / (1000 * 60 * 60 * 24);
      const daysSinceBefore = (recTime - before.date.getTime()) / (1000 * 60 * 60 * 24);
      
      if (totalDays > 0) {
        const ratio = daysSinceBefore / totalDays;
        const estimated = Math.round(before.miles + ratio * (after.miles - before.miles));
        // Clamp to ensure monotonic (between before and after)
        rec.miles = Math.max(before.miles, Math.min(after.miles, estimated));
      } else {
        rec.miles = before.miles;
      }
    } else if (before) {
      // Extrapolate forward from the last known point
      // Find rate from before's surrounding points
      const beforeIdx = knownPoints.indexOf(before);
      if (beforeIdx > 0) {
        const prevPoint = knownPoints[beforeIdx - 1];
        const days = (before.date.getTime() - prevPoint.date.getTime()) / (1000 * 60 * 60 * 24);
        if (days > 0) {
          const rate = (before.miles - prevPoint.miles) / days;
          const daysSince = (recTime - before.date.getTime()) / (1000 * 60 * 60 * 24);
          rec.miles = Math.round(before.miles + rate * daysSince);
        }
      } else if (opts.defaultRate != null) {
        // Use default rate
        const daysSince = (recTime - before.date.getTime()) / (1000 * 60 * 60 * 24);
        rec.miles = Math.round(before.miles + opts.defaultRate * daysSince);
      }
    } else if (after) {
      // Extrapolate backward from the first known point
      // Find rate from after's surrounding points
      const afterIdx = knownPoints.indexOf(after);
      if (afterIdx < knownPoints.length - 1) {
        const nextPoint = knownPoints[afterIdx + 1];
        const days = (nextPoint.date.getTime() - after.date.getTime()) / (1000 * 60 * 60 * 24);
        if (days > 0) {
          const rate = (nextPoint.miles - after.miles) / days;
          const daysBefore = (after.date.getTime() - recTime) / (1000 * 60 * 60 * 24);
          rec.miles = Math.round(after.miles - rate * daysBefore);
        }
      } else if (opts.defaultRate != null) {
        // Use default rate going backward
        const daysBefore = (after.date.getTime() - recTime) / (1000 * 60 * 60 * 24);
        rec.miles = Math.round(after.miles - opts.defaultRate * daysBefore);
      }
    }

    // Ensure non-negative
    if (rec.miles != null && rec.miles < 0) rec.miles = null;
  }

  return parsed;
}

/* ---------------- Get latest miles from multiple sources ---------------- */
async function getLatestMilesForVin(db: any, vinRaw: string): Promise<number | null> {
  const vin = String(vinRaw || "").toUpperCase();
  const toPos = (v: unknown) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // Latest RO mileage
  const ro = await db.collection("repair_orders").findOne(
    { vin },
    { sort: { updatedAt: -1, createdAt: -1 }, projection: { mileage: 1 } }
  );
  const mRO = toPos(ro?.mileage);

  // Latest event with mileage
  const af = await db.collection("events").aggregate([
    {
      $match: {
        $expr: {
          $eq: [
            { $toUpper: { $ifNull: ["$vehicleVin", { $ifNull: ["$vin", "$payload.vehicle.vin"] }] } },
            vin,
          ],
        },
      },
    },
    { $sort: { createdAt: -1 } },
    { $limit: 10 },
    {
      $project: {
        mileage: {
          $ifNull: [
            "$payload.ticket.mileage",
            {
              $ifNull: [
                "$payload.mileage",
                { $ifNull: ["$payload.vehicle.mileage", { $ifNull: ["$payload.vehicle.miles", "$payload.vehicle.odometer"] }] },
              ],
            },
          ],
        },
      },
    },
  ]).toArray();
  const mAF = af.map((x: any) => toPos(x?.mileage)).find((x: any) => x != null) ?? null;

  // Vehicle-level odometer/lastMileage/mileage (Tekmetric stores as mileage)
  const veh = await db.collection("vehicles").findOne({ vin }, { projection: { odometer: 1, lastMileage: 1, mileage: 1 } });
  const mVeh = toPos(veh?.mileage) ?? toPos(veh?.odometer) ?? toPos(veh?.lastMileage);

  // Return the highest valid mileage
  const candidates = [mRO, mAF, mVeh].filter((x): x is number => x != null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/* ---------------- Normalization / rules engine ---------------- */
type OEMItem = {
  maintenance_id: number;
  name: string;
  category: string;
  notes?: string | null;
  miles?: number | null;
  months?: number | null;
};
type LastDone = { miles?: number | null; date?: Date | null; source?: "carfax" | "protractor" | "shop" };

// Service key mappings aligned with CARFAX categories
// Note: Order matters - more specific patterns should come first to avoid false matches
const SERVICE_KEYS: Record<string, string[]> = {
  // Oil change - normalize oil filter, engine oil, etc. to oil change
  oil: [
    "oil and filter", "engine oil", "oil change", "replace engine oil", 
    "oil filter", "replace oil filter", "change oil", "motor oil",
    "crankcase oil", "oil & filter"
  ],
  tire_rotation: ["rotate tires", "tire rotation", "rotate tyre", "tires rotated", "rotate wheels"],
  // Cabin air must come before engine air to avoid false matches
  cabin_air: ["cabin air filter", "cabin filter", "pollen filter", "hvac filter", "interior air filter"],
  engine_air: ["engine air filter", "air cleaner element", "air filter element"],
  coolant: [
    "engine coolant", "coolant flush", "replace coolant", "cooling system", 
    "antifreeze", "radiator flush", "drain and fill coolant"
  ],
  trans_auto: ["automatic transmission fluid", "atf fluid", "atf flush", "auto trans fluid"],
  trans_manual: ["manual transmission fluid", "manual trans fluid", "mtf fluid"],
  transfer_case: ["transfer case fluid", "transfer case flush", "transfer case oil"],
  differential: [
    "differential fluid", "differential flush", "rear differential", 
    "front differential", "rear axle fluid", "front axle fluid"
  ],
  serpentine_belt: ["serpentine belt", "drive belt", "accessory belt", "v-belt", "fan belt"],
  fuel_system: ["fuel system cleaning", "fuel injector cleaning", "fuel system service", "fuel induction"],
  fuel_filter: ["fuel filter"],
  brake_pads: [
    "brake pads", "brake linings", "brake rotor", "brake pads replaced", 
    "brake lining", "disc brake", "front brakes", "rear brakes", "brake shoes"
  ],
  emissions: ["emissions test", "emissions inspection", "smog test", "smog check", "emission test"],
  power_steering: ["power steering fluid", "power steering flush", "power steering service"],
  battery: ["battery replaced", "battery replacement", "battery/charging", "replace battery", "new battery"],
  ac_refrigerant: [
    "a/c refrigerant", "ac refrigerant", "air conditioning refill", 
    "a/c recharge", "ac recharge", "refrigerant", "r-134a", "r134a"
  ],
};

function toKeyFromName(name: string): string | null {
  const n = name.toLowerCase();
  
  // Special handling for "air filter" without "cabin" - this is engine air filter
  // Must check cabin_air first to avoid false positives
  if (n.includes("cabin") && n.includes("air") && n.includes("filter")) return "cabin_air";
  
  for (const [key, vals] of Object.entries(SERVICE_KEYS)) {
    if (vals.some((v) => n.includes(v))) return key;
  }
  
  // Catch-all for generic "air filter" (without cabin) - treat as engine air
  if (n.includes("air filter") && !n.includes("cabin")) return "engine_air";
  
  if (n.includes("exhaust system")) return "exhaust";
  // Legacy mappings for backward compatibility
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

type DeclinedServiceEntry = {
  serviceKey: string;
  serviceName: string;
  mileage?: number | null;
  reason?: string | null;
  declinedAt: string;
};

type TriagedItem = {
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
};

type ShopIntervalOverride = {
  useShop: boolean;
  miles: number | null;
  months: number | null;
};

type Buckets = { overdue: TriagedItem[]; dueSoon: TriagedItem[]; upcoming: TriagedItem[] };

const DEFAULT_SOON_MILES = 1000;
const DEFAULT_SOON_DAYS = 30;

type ProtractorServiceHistory = {
  serviceName: string;
  mileage: number | null;
  date: Date | null;
};

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

function triage({
  oemItems,
  carfaxRecords,
  protractorHistory = [],
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
  protractorHistory?: ProtractorServiceHistory[];
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
  // Earliest possible date: January 1st of the vehicle's model year (or 20 years ago as fallback)
  const earliestDate = vehicleYear 
    ? new Date(vehicleYear, 0, 1) // Jan 1 of model year
    : new Date(today.getTime() - 20 * 365 * 24 * 60 * 60 * 1000); // 20 years ago fallback
  // Enrich CARFAX records with interpolated mileage for gaps
  const enrichedRecords = fillCarfaxMileageGaps(carfaxRecords || [], {
    today,
    currentMiles,
    defaultRate: milesPerDay,
  });

  // Build Protractor service history map first (shop data is primary)
  const shopHistoryByKey = new Map<string, { miles: number | null; date: Date | null }[]>();
  for (const ph of protractorHistory || []) {
    const keys = toKeyFromFreeText(ph.serviceName || "");
    for (const k of keys) {
      if (!shopHistoryByKey.has(k)) shopHistoryByKey.set(k, []);
      shopHistoryByKey.get(k)!.push({ miles: ph.mileage, date: ph.date });
    }
  }

  // last-done map: merge CARFAX with Protractor (shop wins if matching)
  const lastMap = new Map<string, LastDone>();
  
  // First, add all Protractor history as shop source
  for (const ph of protractorHistory || []) {
    const keys = toKeyFromFreeText(ph.serviceName || "");
    for (const k of keys) {
      const prev = lastMap.get(k);
      const cand: LastDone = { miles: ph.mileage, date: ph.date, source: "shop" };
      const prevScore = prev?.date ? prev.date.getTime() : -Infinity;
      const candScore = ph.date ? ph.date.getTime() : -Infinity;
      if (!prev || candScore > prevScore) lastMap.set(k, cand);
    }
  }

  // Then process CARFAX records
  for (const r of enrichedRecords) {
    const date = r.date;
    const miles = r.miles;
    
    const desc = String(r.description || "").trim();
    const keys = toKeyFromFreeText(desc);
    for (const k of keys) {
      const prev = lastMap.get(k);
      
      // Check if this CARFAX record matches any shop record (±10mi, ±3 days)
      const shopRecords = shopHistoryByKey.get(k) || [];
      const matchesShop = shopRecords.some(sr => isMatchingHistory(sr, { miles, date }));
      
      if (matchesShop) {
        // CARFAX matches shop record - keep shop source (already in lastMap)
        continue;
      }
      
      // No matching shop record - use CARFAX source
      const cand: LastDone = { miles, date, source: "carfax" };
      const prevScore = prev?.date ? prev.date.getTime() : -Infinity;
      const candScore = date ? date.getTime() : -Infinity;
      if (!prev || candScore > prevScore) lastMap.set(k, cand);
    }
  }

  // DVI bumps - track which items we've seen (from AutoFlow or AutoVitals)
  const dviMap = new Map<string, { status: "red" | "yellow"; name: string; dviSource?: "autoflow" | "autovitals" }>();
  for (const it of dviFindings || []) {
    const key = it?.name ? toKeyFromName(String(it.name)) : null;
    if (!key) continue;
    const s = String(it.status ?? "");
    const dviSource = (it.source === "autovitals" ? "autovitals" : "autoflow") as "autoflow" | "autovitals";
    if (s === "0") dviMap.set(key, { status: "red", name: String(it.name), dviSource });
    else if (s === "1" && dviMap.get(key)?.status !== "red") dviMap.set(key, { status: "yellow", name: String(it.name), dviSource });
  }

  // Declined services map - key is the serviceKey
  const declinedMap = new Map<string, DeclinedServiceEntry>();
  for (const d of declinedServices || []) {
    if (d.serviceKey) {
      declinedMap.set(d.serviceKey, d);
    }
  }

  const triaged: TriagedItem[] = [];
  const usedDviKeys = new Set<string>();
  const usedServiceKeys = new Set<string>(); // Dedupe items with same serviceKey

  for (const o of oemItems) {
    const serviceKey = toKeyFromName(o.name || "") || `misc_${o.maintenance_id}`;
    
    // Skip duplicate service keys - only keep first occurrence
    // This prevents "Change engine oil" and "Replace oil filter" from both showing
    if (usedServiceKeys.has(serviceKey) && !serviceKey.startsWith("misc_")) {
      continue;
    }
    usedServiceKeys.add(serviceKey);
    
    const uniqueKey = `${serviceKey}_${o.maintenance_id}`;
    const last = lastMap.get(serviceKey) ?? null;
    
    // Check for shop interval override
    const shopOverride = shopIntervals[serviceKey];
    const usingShopInterval = shopOverride?.useShop === true;
    const intervalMiles = usingShopInterval && shopOverride.miles != null 
      ? shopOverride.miles 
      : (o.miles ?? null);
    const intervalMonths = usingShopInterval && shopOverride.months != null 
      ? shopOverride.months 
      : (o.months ?? null);

    // Track that we've used this DVI key
    if (dviMap.has(serviceKey)) usedDviKeys.add(serviceKey);

    let dueAtMiles: number | null = null;
    let dueAtDate: Date | null = null;

    // Miles-based next due
    // Track if this item has never been done (for overdue calculation)
    let neverDone = false;
    if (intervalMiles && intervalMiles > 0) {
      if (last?.miles != null) {
        dueAtMiles = last.miles + intervalMiles;
      } else if (currentMiles != null) {
        // No history: was due at the first interval
        dueAtMiles = intervalMiles;
        neverDone = true;
      }
    }

    // Time-based next due
    if (intervalMonths && intervalMonths > 0) {
      if (last?.date) dueAtDate = addMonths(last.date, intervalMonths);
      else if (!neverDone) dueAtDate = addMonths(today, 0 + intervalMonths);
      // If neverDone, don't set a future date - we'll estimate from mileage below
    }

    const milesToGo = currentMiles != null && dueAtMiles != null ? dueAtMiles - currentMiles : null;

    // If no time-based interval but we have miles and miles/day, estimate date
    // Also applies when service was never done (neverDone=true) to avoid showing future dates for overdue items
    if (dueAtDate == null && milesToGo != null && milesPerDay != null && milesPerDay > 0) {
      const daysUntilDue = Math.round(milesToGo / milesPerDay);
      dueAtDate = new Date(today.getTime() + daysUntilDue * 24 * 60 * 60 * 1000);
    }
    
    // If calculated date is before the vehicle was built, don't show a date at all
    // Just show miles overdue instead of a confusing/impossible date
    if (dueAtDate && dueAtDate < earliestDate) {
      dueAtDate = null;
    }

    const daysToGo =
      dueAtDate != null ? Math.ceil((dueAtDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null;

    const dviInfo = dviMap.get(serviceKey);
    const declinedInfo = declinedMap.get(serviceKey) || null;
    triaged.push({
      key: uniqueKey,
      serviceKey,
      title: o.name,
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
    });
  }

  // Add standalone DVI findings (red/yellow items not matched to OEM)
  for (const [dviKey, dviInfo] of dviMap) {
    if (usedDviKeys.has(dviKey)) continue; // already matched to OEM item
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

  // Add Protractor deferred work (shop recommendations)
  // These are services that were recommended but not performed - they're already overdue
  for (const dw of protractorDeferredWork || []) {
    // Title can be at root level or nested in ServicePackageHeader
    const title = dw.Title 
      || dw.ServicePackageHeader?.Title 
      || dw.Code 
      || dw.Description 
      || dw.ServicePackageHeader?.Description
      || "Deferred Service";
    
    const protractorServiceKey = toKeyFromName(title) || `protractor_${dw.ID}`;
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
      bump: "red", // Deferred = already recommended = already overdue
      source: "protractor",
      reason: dw.Reason || undefined,
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

    // DVI bump forces severity
    if (t.bump === "red") {
      overdue.push(t);
      continue;
    }
    if (t.bump === "yellow") {
      if (!(mOver || dOver)) dueSoon.push(t);
      else overdue.push(t);
      continue;
    }

    if (mOver || dOver) overdue.push(t);
    else if (mSoon || dSoon) dueSoon.push(t);
    else upcoming.push(t);
  }

  // Helper to check if item title contains "Inspect" or starts with "Check" (lower priority)
  const isInspectItem = (item: TriagedItem) => {
    const title = item.title?.toLowerCase() || "";
    return title.includes("inspect") || title.startsWith("check ");
  };

  // sort within buckets - put "Inspect" items after actionable items
  overdue.sort((a, b) => {
    const aInspect = isInspectItem(a) ? 1 : 0;
    const bInspect = isInspectItem(b) ? 1 : 0;
    if (aInspect !== bInspect) return aInspect - bInspect; // Non-inspect first
    const aBehind = (a.milesToGo ?? 0) < 0 ? -(a.milesToGo ?? 0) : 0;
    const bBehind = (b.milesToGo ?? 0) < 0 ? -(b.milesToGo ?? 0) : 0;
    return bBehind - aBehind; // most overdue first
  });
  dueSoon.sort((a, b) => {
    const aInspect = isInspectItem(a) ? 1 : 0;
    const bInspect = isInspectItem(b) ? 1 : 0;
    if (aInspect !== bInspect) return aInspect - bInspect; // Non-inspect first
    const aLeft = a.milesToGo ?? Infinity;
    const bLeft = b.milesToGo ?? Infinity;
    return aLeft - bLeft; // closest first
  });
  upcoming.sort((a, b) => {
    const aInspect = isInspectItem(a) ? 1 : 0;
    const bInspect = isInspectItem(b) ? 1 : 0;
    if (aInspect !== bInspect) return aInspect - bInspect; // Non-inspect first
    const aNext = a.dueAtMiles ?? Number.POSITIVE_INFINITY;
    const bNext = b.dueAtMiles ?? Number.POSITIVE_INFINITY;
    return aNext - bNext;
  });

  return { overdue, dueSoon, upcoming };
}

/* ---------------- Page ---------------- */
type PageProps = { params: Promise<{ vin: string }> };

export default function VehiclePlanPage({ params }: PageProps) {
  return (
    <Suspense fallback={<PlanLoading />}>
      <PlanContent params={params} />
    </Suspense>
  );
}

async function PlanContent({ params }: PageProps) {
  const session = await requireSession();
  const db = await getDb();
  const shopId = Number(session.shopId);

  const { vin: vinParam } = await params;
  const vin = String(vinParam || "").toUpperCase();

  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { maintenance: 1, protractor: 1, preferences: 1 } }
  );
  const distanceUnit: DistanceUnit = shop?.preferences?.distanceUnit || "miles";
  const distLabel = getDistanceLabel(distanceUnit);
  const showInspectItems = shop?.preferences?.showInspectItems !== false; // default true
  const soonMiles = shop?.maintenance?.dueSoonMiles ?? DEFAULT_SOON_MILES;
  const soonDays = shop?.maintenance?.dueSoonDays ?? DEFAULT_SOON_DAYS;
  const shopIntervals: Record<string, ShopIntervalOverride> = shop?.maintenance?.intervals ?? {};
  const rawMappings = shop?.protractor?.cannedJobMappings ?? {};
  const cannedJobMappings: Record<string, string[]> = {};
  for (const key in rawMappings) {
    const val = rawMappings[key];
    if (Array.isArray(val)) {
      cannedJobMappings[key] = val;
    } else if (typeof val === "string" && val) {
      cannedJobMappings[key] = [val];
    }
  }
  
  const cannedJobsCache = await getCannedJobsFromCache(shopId);
  const cannedJobsById: Record<string, { id: string; title: string }> = {};
  if (cannedJobsCache.ok && cannedJobsCache.cannedJobs) {
    for (const job of cannedJobsCache.cannedJobs) {
      cannedJobsById[job.id] = { id: job.id, title: job.title };
    }
  }
  
  const manualJobs = shop?.protractor?.manualCannedJobs || [];
  for (const job of manualJobs) {
    if (job.id && !cannedJobsById[job.id]) {
      cannedJobsById[job.id] = { id: job.id, title: job.title || `Job ${job.id}` };
    }
  }
  
  function getCannedJobOptionsForService(serviceKey: string) {
    const ids = cannedJobMappings[serviceKey] || [];
    return ids
      .map(id => cannedJobsById[id])
      .filter(Boolean);
  }
  
  // All available canned jobs for fallback when no mapped jobs exist
  const allCannedJobsList = Object.values(cannedJobsById);

  const vehicle = await db.collection("vehicles").findOne(
    { shopId, vin },
    { projection: { year: 1, make: 1, model: 1, vin: 1, lastMileage: 1, customerId: 1, updatedAt: 1, declinedServices: 1 } }
  );

  // Get repair orders from events collection (AutoFlow webhooks store RO data here)
  // This matches the detail page logic exactly
  const eventRos = await db.collection("events").aggregate([
    {
      $match: {
        $and: [
          { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
          { provider: "autoflow" },
          {
            $expr: {
              $eq: [
                { $toUpper: { $ifNull: ["$vehicleVin", { $ifNull: ["$vin", "$payload.vehicle.vin"] }] } },
                vin.toUpperCase()
              ]
            }
          }
        ]
      }
    },
    {
      $addFields: {
        roNumber: { $ifNull: ["$payload.ticket.invoice", { $ifNull: ["$payload.ticket.id", "$roNumber"] }] },
        status: { $ifNull: ["$payload.ticket.status", "$status"] },
        mileage: { $ifNull: ["$payload.ticket.mileage", { $ifNull: ["$payload.vehicle.mileage", null] }] }
      }
    },
    { $match: { roNumber: { $ne: null } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$roNumber",
        roNumber: { $first: "$roNumber" },
        status: { $first: "$status" },
        mileage: { $first: "$mileage" },
        updatedAt: { $first: "$createdAt" },
        createdAt: { $first: "$createdAt" }
      }
    },
    { $sort: { updatedAt: -1 } },
    { $limit: 20 }
  ]).toArray();

  const ros = eventRos;
  
  let latestRoNumber = ros[0]?.roNumber ?? null;
  let latestWorkOrderId: string | null = null;
  
  // Also check Protractor for active work orders
  // First get the vehicle's Protractor ServiceItemID
  const protractorVehicleCache = await db.collection("protractor_vehicles").findOne({
    shopId,
    vin: { $regex: new RegExp(`^${vin}$`, 'i') }
  });
  
  // protractor_vehicles stores the Protractor ID in 'protractorId' field
  const serviceItemId = protractorVehicleCache?.protractorId;
  console.log(`[Plan Debug] Protractor ServiceItemID for VIN ${vin}: ${serviceItemId || 'not found'}`);
  
  if (serviceItemId) {
    // Look up work orders by ServiceItemID - check all possible field variations
    const protractorWO = await db.collection("protractor_work_orders").findOne(
      { 
        shopId, 
        $and: [
          { $or: [
            { serviceItemId: serviceItemId },
            { "data.ServiceItemID": serviceItemId },
            { ServiceItemID: serviceItemId }
          ]},
          { $or: [
            { completed: { $ne: true } },
            { "data.Completed": { $ne: true } },
            { Completed: { $ne: true } }
          ]}
        ]
      },
      { sort: { fetchedAt: -1, createdAt: -1 } }
    );
    
    console.log(`[Plan Debug] Protractor WO query result:`, protractorWO ? 
      `found WO#${protractorWO.workOrderNumber || protractorWO.WorkOrderNumber || protractorWO.data?.WorkOrderNumber}` : 
      'not found');
    
    const woNumber = protractorWO?.workOrderNumber || protractorWO?.WorkOrderNumber || protractorWO?.data?.WorkOrderNumber;
    const woId = protractorWO?.workOrderId || protractorWO?.ID || protractorWO?.data?.ID;
    
    if (woNumber) {
      latestRoNumber = String(woNumber);
      latestWorkOrderId = woId ? String(woId) : null;
      console.log(`[Plan Debug] Found Protractor RO: ${latestRoNumber}, ID: ${latestWorkOrderId}`);
    }
  }
  
  // If still no RO, check if there are any work orders for this VIN directly
  if (!latestRoNumber) {
    const protractorWOByVin = await db.collection("protractor_work_orders").findOne(
      { 
        shopId,
        $or: [
          { vin: { $regex: new RegExp(`^${vin}$`, 'i') } },
          { "data.VIN": { $regex: new RegExp(`^${vin}$`, 'i') } }
        ]
      },
      { sort: { fetchedAt: -1, createdAt: -1 } }
    );
    
    if (protractorWOByVin) {
      const woNumber = protractorWOByVin.workOrderNumber || protractorWOByVin.WorkOrderNumber || protractorWOByVin.data?.WorkOrderNumber;
      const woId = protractorWOByVin.workOrderId || protractorWOByVin.ID || protractorWOByVin.data?.ID;
      if (woNumber) {
        latestRoNumber = String(woNumber);
        latestWorkOrderId = woId ? String(woId) : null;
        console.log(`[Plan Debug] Found Protractor RO by VIN: ${latestRoNumber}`);
      }
    }
  }
  
  console.log(`[Plan Debug] Latest RO number: ${latestRoNumber}, total ROs: ${ros.length}`);

  // PARALLEL CONFIG RESOLUTION - fetch all configs at once
  const DVI_CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days
  const CARFAX_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days  
  const PROTRACTOR_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

  const [autoCfg, carfaxCfg, protractorCfg, autoVitalsCfg] = await Promise.all([
    resolveAutoflowConfig(shopId),
    resolveCarfaxConfig(shopId),
    resolveProtractorConfig(shopId),
    resolveAutoVitalsConfig(shopId)
  ]);

  // PARALLEL DATA FETCHING - fetch external data and local queries simultaneously
  const vinUpper = vin.toUpperCase();
  const [dvi, carfax, protractorVehicleResult, avInspectionResult, protractorCompletedWOs, shopBranding] = await Promise.all([
    latestRoNumber && autoCfg.configured
      ? fetchDviWithCache(shopId, String(latestRoNumber), DVI_CACHE_TTL)
      : Promise.resolve({ ok: false, error: latestRoNumber ? "AutoFlow not connected." : "No RO found." }),
    carfaxCfg.configured
      ? fetchCarfaxWithCache(shopId, vin, CARFAX_CACHE_TTL)
      : Promise.resolve({ ok: false, error: "CARFAX not configured." as const }),
    protractorCfg.configured
      ? fetchProtractorVehicle(shopId, vin, PROTRACTOR_CACHE_TTL)
      : Promise.resolve({ ok: false } as { ok: false }),
    autoVitalsCfg.configured
      ? fetchAutoVitalsInspectionByVin(shopId, vin, PROTRACTOR_CACHE_TTL)
      : Promise.resolve({ ok: false } as { ok: false }),
    db.collection("protractor_work_orders").find({
      shopId,
      $or: [
        { vin: vinUpper },
        { "data.VIN": vinUpper },
        { "ServiceItem.VIN": vinUpper }
      ]
    }).sort({ "Header.LastModifiedTime": -1 }).limit(20).toArray(),
    db.collection("shops").findOne({ shopId }, { projection: { "branding.logo": 1 } })
  ]);

  // Protractor Deferred Work (depends on vehicle ID from previous call)
  let protractorDeferredWork: ProtractorDeferredWork[] = [];
  if (protractorCfg.configured && (protractorVehicleResult as any).ok && (protractorVehicleResult as any).vehicle?.ID) {
    const deferredResult = await fetchProtractorDeferredWork(
      shopId,
      vin,
      (protractorVehicleResult as any).vehicle.ID,
      PROTRACTOR_CACHE_TTL
    );
    if (deferredResult.ok && deferredResult.deferredWork) {
      protractorDeferredWork = deferredResult.deferredWork;
    }
  }

  // Extract service history from Protractor completed work orders
  const protractorHistory: ProtractorServiceHistory[] = [];
  for (const wo of protractorCompletedWOs) {
    const mileage = wo.Odometer ?? wo.OutUsage ?? wo.data?.Odometer ?? null;
    const dateStr = wo.Header?.LastModifiedTime ?? wo.Header?.CreationTime ?? wo.data?.Header?.LastModifiedTime ?? null;
    const date = dateStr ? new Date(dateStr) : null;
    
    const servicePackages = wo.ServicePackages ?? wo.data?.ServicePackages ?? [];
    for (const pkg of servicePackages) {
      const serviceName = pkg.Title ?? pkg.Description ?? "";
      if (serviceName) {
        protractorHistory.push({ serviceName, mileage, date });
      }
      for (const line of pkg.ServicePackageLines ?? []) {
        const lineName = line.Description ?? "";
        if (lineName && lineName !== serviceName) {
          protractorHistory.push({ serviceName: lineName, mileage, date });
        }
      }
    }
  }
  console.log(`[Plan Debug] Protractor service history entries: ${protractorHistory.length}`);

  const shopLogo: string | null = shopBranding?.branding?.logo || null;

  // Miles/day (same “today miles” guard as detail page)
  let mpdBlended: number | null = null;
  if ((carfax as any).ok && Array.isArray((carfax as any).serviceRecords)) {
    const recs = (carfax as any).serviceRecords
      .map((r: any) => ({ date: parseCarfaxDate(r?.date ?? null), miles: typeof r?.odometer === "number" ? r.odometer : null }))
      .filter((r: any) => r.date && typeof r.miles === "number") as { date: Date; miles: number }[];
    recs.sort((a, b) => b.date.getTime() - a.date.getTime());

    const todayMiles =
      typeof vehicle?.lastMileage === "number" && vehicle.lastMileage > 0 && (!recs[0] || vehicle.lastMileage >= recs[0].miles)
        ? vehicle.lastMileage
        : null;

    let fromToday: number | null = null,
      fromTwo: number | null = null;

    if (todayMiles != null && recs[0]) {
      const d = Math.max(1, daysBetween(new Date(), recs[0].date));
      const val = (todayMiles - recs[0].miles) / d;
      fromToday = Math.abs(val) < 0.01 ? null : val; // ignore ~0.0 rates
    }
    if (recs[0] && recs[1]) {
      const d = Math.max(1, daysBetween(recs[0].date, recs[1].date));
      fromTwo = (recs[0].miles - recs[1].miles) / d;
    }
    mpdBlended = fromToday != null && fromTwo != null ? (fromToday + fromTwo) / 2 : fromTwo ?? fromToday ?? null;
  }

  // PARALLEL: Get current miles and OEM schedule at the same time
  const [currentMiles, oemData] = await Promise.all([
    getLatestMilesForVin(db, vin),
    getMaintenanceScheduleCached(vin)
  ]);
  console.log(`[Plan] OEM data source: ${oemData.source}, count: ${oemData.count}`);

  // Vehicle info fallback: prefer vehicles collection, fall back to VIN decode from OEM
  const vehicleYear = vehicle?.year ?? oemData.vehicle?.year;
  const vehicleMake = vehicle?.make ?? oemData.vehicle?.make;
  const vehicleModel = vehicle?.model ?? oemData.vehicle?.model;
  const vehicleEngine = oemData.vehicle?.engine; // Only from VIN decode

  // Build normalized inputs

  const carfaxRecords: Array<{ date?: string; odometer?: number; description?: string }> =
    (carfax as any).ok && Array.isArray((carfax as any).serviceRecords)
      ? (carfax as any).serviceRecords.map((r: any) => ({
          date: r.date,
          odometer: r.odometer,
          description: String(r.description || ""),
        }))
      : [];

  // AutoFlow DVI findings
  const autoflowDviFindings: Array<{ name?: string; status?: string | number; source?: string }> =
    (dvi as any).ok && Array.isArray((dvi as any).categories)
      ? (dvi as any).categories.flatMap((c: any) =>
          Array.isArray(c.items) ? c.items.map((it: any) => ({ name: it.name, status: it.status, source: "autoflow" })) : []
        )
      : [];

  // AutoVitals DVI findings (already fetched in parallel above)
  let autoVitalsDviFindings: Array<{ name?: string; status?: string | number; source?: string }> = [];
  if ((avInspectionResult as any).ok && (avInspectionResult as any).items) {
    autoVitalsDviFindings = (avInspectionResult as any).items
      .filter((item: any) => item.status === "red" || item.status === "yellow")
      .map((item: any) => ({
        name: item.name,
        status: item.status === "red" ? "0" : "1",
        source: "autovitals"
      }));
    console.log(`[Plan Debug] AutoVitals DVI items: ${autoVitalsDviFindings.length}`);
  }

  // Merge DVI findings from both sources (AutoFlow and AutoVitals)
  const dviFindings: Array<{ name?: string; status?: string | number; source?: string }> = [
    ...autoflowDviFindings,
    ...autoVitalsDviFindings
  ];

  const oemItems: OEMItem[] = (oemData.items as any[]).map((x) => ({
    maintenance_id: x.maintenance_id,
    name: x.maintenance_name || x.name,
    category: x.maintenance_category || x.category,
    notes: x.maintenance_notes || x.notes,
    miles: x.miles ?? null,
    months: x.months ?? null,
  }));

  // Debug: Log what data we have
  console.log(`[Plan Debug] VIN: ${vin}`);
  console.log(`[Plan Debug] Current Miles: ${currentMiles}`);
  console.log(`[Plan Debug] OEM Items count: ${oemItems.length}`);
  console.log(`[Plan Debug] CARFAX Records count: ${carfaxRecords.length}`);
  console.log(`[Plan Debug] DVI Findings count: ${dviFindings.length}`);
  if (oemItems.length > 0) {
    console.log(`[Plan Debug] Sample OEM items:`, oemItems.slice(0, 3).map(o => o.name));
  }
  if (carfaxRecords.length > 0) {
    console.log(`[Plan Debug] Sample CARFAX records:`, carfaxRecords.slice(0, 3).map(r => r.description?.substring(0, 50)));
  }
  if (dviFindings.length > 0) {
    console.log(`[Plan Debug] Sample DVI findings:`, dviFindings.slice(0, 5).map(d => ({ name: d.name, status: d.status })));
  }
  console.log(`[Plan Debug] Protractor deferred work count: ${protractorDeferredWork.length}`);

  const declinedServices: DeclinedServiceEntry[] = (vehicle?.declinedServices || []).map((d: any) => ({
    serviceKey: d.serviceKey,
    serviceName: d.serviceName,
    mileage: d.mileage ?? null,
    reason: d.reason ?? null,
    declinedAt: d.declinedAt,
  }));

  const rawBuckets = triage({
    oemItems,
    carfaxRecords,
    protractorHistory,
    currentMiles,
    dviFindings,
    protractorDeferredWork,
    declinedServices,
    soonMiles,
    soonDays,
    milesPerDay: mpdBlended,
    shopIntervals,
    vehicleYear: vehicle?.year ?? null,
  });

  // Filter out "Inspect" or "Check" items if preference is off
  const isInspectItemFilter = (item: TriagedItem) => {
    const title = item.title?.toLowerCase() || "";
    return title.includes("inspect") || title.startsWith("check ");
  };
  
  const buckets = showInspectItems ? rawBuckets : {
    overdue: rawBuckets.overdue.filter(i => !isInspectItemFilter(i)),
    dueSoon: rawBuckets.dueSoon.filter(i => !isInspectItemFilter(i)),
    upcoming: rawBuckets.upcoming.filter(i => !isInspectItemFilter(i)),
  };

  console.log(`[Plan Debug] Thresholds: soonMiles=${soonMiles}, soonDays=${soonDays}`);
  console.log(`[Plan Debug] Buckets: overdue=${rawBuckets.overdue.length}, dueSoon=${rawBuckets.dueSoon.length}, upcoming=${rawBuckets.upcoming.length}${!showInspectItems ? ` (filtered: overdue=${buckets.overdue.length}, dueSoon=${buckets.dueSoon.length}, upcoming=${buckets.upcoming.length})` : ''}`);

  const counts = {
    overdue: buckets.overdue.length,
    soon: buckets.dueSoon.length,
    upcoming: buckets.upcoming.length,
  };

  return (
    <PlanTrialGate vin={vin}>
      <main className="mx-auto max-w-5xl p-0 sm:p-6 space-y-8">
      {/* Sticky summary header */}
      <div className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-3">
          {/* Top navigation menu */}
          <nav className="flex items-center gap-4 text-sm text-blue-600 mb-2">
            <Link href="/dashboard" className="hover:underline">← Back</Link>
            <Link href={`/dashboard/vehicles/${vin}?tab=oe`} className="hover:underline">OE</Link>
            <Link href={`/dashboard/vehicles/${vin}?tab=dvi`} className="hover:underline">DVI</Link>
            <Link href={`/dashboard/vehicles/${vin}?tab=carfax`} className="hover:opacity-80">
              <img src="/badges/carfax.png" alt="CARFAX" className="h-4" />
            </Link>
          </nav>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold truncate">
                {(vehicle ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") : "Vehicle")} — Plan
              </h1>
              <div className="text-sm text-neutral-600">
                VIN <code>{vin}</code>
                {currentMiles != null && currentMiles > 0 && <> • Current: {fmtDistance(currentMiles, distanceUnit)} {distLabel}</>}
                {mpdBlended != null && <> • ~{(distanceUnit === "kilometers" ? mpdBlended * MILES_TO_KM : mpdBlended).toFixed(1)} {distLabel}/day</>}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <PrintButton />
              <nav className="flex items-center gap-2 text-xs sm:text-sm print:hidden">
                <a href="#overdue" className="rounded-full px-3 py-1 bg-red-600 text-white">
                  Overdue {counts.overdue}
                </a>
                <a href="#soon" className="rounded-full px-3 py-1 bg-amber-600 text-white">
                  Due Soon {counts.soon}
                </a>
                <a href="#upcoming" className="rounded-full px-3 py-1 bg-emerald-600 text-white">
                  Upcoming {counts.upcoming}
                </a>
              </nav>
            </div>
          </div>
        </div>
      </div>

      {/* Print-only header with shop logo */}
      <div className="hidden print:block mb-6 border-b pb-4">
        <div className="flex items-center justify-between">
          {shopLogo ? (
            <img src={shopLogo} alt="Shop Logo" className="h-12" />
          ) : (
            <div className="text-lg font-bold text-neutral-800">Maintenance Report</div>
          )}
          <div className="text-right text-sm text-neutral-600">
            <div>Report Date: {new Date().toLocaleDateString()}</div>
          </div>
        </div>
        <div className="mt-4">
          <h1 className="text-2xl font-bold">
            {(vehicle ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") : "Vehicle")} — Maintenance Plan
          </h1>
          <div className="text-sm text-neutral-600 mt-1">
            VIN: {vin}
            {currentMiles != null && currentMiles > 0 && <> • Current: {fmtDistance(currentMiles, distanceUnit)} {distLabel}</>}
          </div>
        </div>
      </div>

      {/* Buckets (single column for easy scanning) */}
      <div className="mx-auto max-w-5xl px-4 sm:px-6 space-y-8">
        {/* Overdue */}
        <section id="overdue" className="space-y-3">
          <h2 className="text-lg font-semibold text-red-700 flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-600" /> Overdue ({counts.overdue})
          </h2>
          {buckets.overdue.length === 0 ? (
            <div className="text-sm text-neutral-500">Nothing overdue 🎉</div>
          ) : (
            <ul className="space-y-3">
              {buckets.overdue.map((t) => (
                <li key={t.key} className="rounded-xl border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium">{t.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
                        {t.category && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{t.category}</span>}
                        <span className="rounded-full bg-red-600 text-white px-2 py-0.5">OVERDUE</span>
                        {(t.intervalMiles || t.intervalMonths) && (
                          <span className="rounded-full border px-2 py-0.5">
                            OEM: {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : ""}
                            {t.intervalMiles && t.intervalMonths ? " / " : ""}
                            {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                          </span>
                        )}
                        {t.bump === "red" && t.source !== "protractor" && (
                          <span className={`rounded-full text-white px-2 py-0.5 ${t.dviSource === "autovitals" ? "bg-teal-600" : "bg-red-600"}`}>
                            {t.dviSource === "autovitals" ? "AutoVitals 🔴" : "DVI 🔴"}
                          </span>
                        )}
                        {t.source === "protractor" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 border border-blue-200 px-2 py-0.5">
                            <img 
                              src={shopLogo || "/protractor-icon.png"} 
                              alt="Shop" 
                              className="w-4 h-4 rounded-full object-cover"
                            />
                            <span className="text-blue-700 text-xs">Deferred</span>
                          </span>
                        )}
                        {t.usingShopInterval && <span className="rounded-full bg-green-600 text-white px-2 py-0.5">Shop</span>}
                        {t.declined && (
                          <span className="rounded-full bg-orange-100 text-orange-700 border border-orange-300 px-2 py-0.5 font-medium">
                            Previously declined
                          </span>
                        )}
                      </div>
                    </div>
                    {(() => {
                      const opts = getCannedJobOptionsForService(t.serviceKey);
                      return (
                        <AddToROWithHistory
                          vin={vin}
                          serviceTitle={t.title}
                          serviceKey={t.serviceKey}
                          vehicleYear={vehicleYear}
                          vehicleMake={vehicleMake}
                          vehicleModel={vehicleModel}
                          vehicleEngine={vehicleEngine}
                          workOrderGuid={latestWorkOrderId ?? undefined}
                          workOrderId={latestRoNumber ?? undefined}
                          cannedJobOptions={opts}
                          allCannedJobs={allCannedJobsList}
                        />
                      );
                    })()}
                  </div>

                  <div className="text-sm mt-2 flex flex-wrap items-center gap-1.5">
                    {t.dueAtMiles != null && (
                      <>
                        Due at <strong>{fmtDistance(t.dueAtMiles, distanceUnit)}</strong> {distLabel}
                        {t.milesToGo != null && (
                          <>
                            {" • "}
                            <span className="inline-flex items-center px-2 py-0.5 bg-red-100 border border-red-300 rounded text-red-700 font-semibold">
                              {fmtDistance(Math.abs(t.milesToGo), distanceUnit)} {distLabel} overdue
                            </span>
                          </>
                        )}
                      </>
                    )}
                    {t.dueAtMiles != null && t.dueAtDate != null && <> • </>}
                    {(() => {
                      if (t.dueAtDate == null) return null;
                      const { text, isVeryOverdue, yearsOverdue } = formatOverdueDate(t.dueAtDate);
                      return (
                        <span className={isVeryOverdue ? "inline-flex items-center gap-1" : ""}>
                          By{" "}
                          <strong className={isVeryOverdue ? "bg-red-100 text-red-700 px-1.5 py-0.5 rounded border border-red-300" : ""}>
                            {text}
                          </strong>
                          {yearsOverdue >= 2 && (
                            <span className="text-red-600 font-bold">⚠️</span>
                          )}
                        </span>
                      );
                    })()}
                  </div>

                  {t.last?.miles != null && (
                    <div className="text-xs text-neutral-600 mt-1 flex items-center gap-1.5">
                      <span>Last done at {fmtDistance(t.last.miles, distanceUnit)} {distLabel}{t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}</span>
                      {t.last?.source === "carfax" && (
                        <img src="/badges/carfax.png" alt="CARFAX" className="h-3.5" title="From CARFAX" />
                      )}
                      {(t.last?.source === "protractor" || t.last?.source === "shop") && (
                        shopLogo ? (
                          <img src={shopLogo} alt="Shop" className="h-4" title="From Shop History" />
                        ) : (
                          <img src="/badges/protractor.png" alt="Protractor" className="h-4" title="From Protractor" />
                        )
                      )}
                    </div>
                  )}

                  {t.declined && (
                    <div className="text-xs text-orange-700 mt-1 bg-orange-50 rounded px-2 py-1">
                      Declined on {new Date(t.declined.declinedAt).toLocaleDateString()}
                      {t.declined.mileage && ` at ${fmtDistance(t.declined.mileage, distanceUnit)} ${distLabel}`}
                      {t.declined.reason && ` - ${t.declined.reason}`}
                    </div>
                  )}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Why this is recommended</summary>
                    <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-700 space-y-1">
                      <div>
                        <span className="font-medium">{t.usingShopInterval ? "Shop" : "OEM"} Interval:</span>{" "}
                        {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : "—"}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </div>
                      <div>
                        <span className="font-medium inline-flex items-center gap-1">
                          Last done
                          {t.last?.source === "carfax" && <img src="/badges/carfax.png" alt="CARFAX" className="h-3 inline" />}
                          {(t.last?.source === "protractor" || t.last?.source === "shop") && (
                            shopLogo ? (
                              <img src={shopLogo} alt="Shop" className="h-3.5 inline" />
                            ) : (
                              <img src="/badges/protractor.png" alt="Protractor" className="h-3.5 inline" />
                            )
                          )}
                          :
                        </span>{" "}
                        {t.last?.miles != null ? `${fmtDistance(t.last.miles, distanceUnit)} ${distLabel}` : "—"}
                        {t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                      </div>
                      <div>
                        <span className="font-medium">Next due:</span>{" "}
                        {t.dueAtMiles != null ? `${fmtDistance(t.dueAtMiles, distanceUnit)} ${distLabel}` : "—"}
                        {t.dueAtDate ? ` or ${t.dueAtDate.toLocaleDateString()}` : ""}
                      </div>
                      {t.bump && t.source !== "protractor" && (
                        <div>
                          <span className="font-medium">DVI:</span> {t.bump === "red" ? "🔴 flagged" : "🟡 caution"}
                        </div>
                      )}
                      {t.source === "protractor" && (
                        <div>
                          <span className="font-medium">Source:</span> Protractor deferred work
                          {t.reason && <> - {t.reason}</>}
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Due Soon */}
        <section id="soon" className="space-y-3">
          <h2 className="text-lg font-semibold text-amber-700 flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" /> Due Soon ({counts.soon})
          </h2>
          {buckets.dueSoon.length === 0 ? (
            <div className="text-sm text-neutral-500">Nothing due soon.</div>
          ) : (
            <ul className="space-y-3">
              {buckets.dueSoon.map((t) => (
                <li key={t.key} className="rounded-xl border p-3">
                  <div className="font-medium">{t.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
                    {t.category && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{t.category}</span>}
                    <span className="rounded-full bg-amber-600 text-white px-2 py-0.5">DUE SOON</span>
                    {(t.intervalMiles || t.intervalMonths) && (
                      <span className="rounded-full border px-2 py-0.5">
                        OEM: {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : ""}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </span>
                    )}
                    {t.bump === "yellow" && t.source !== "protractor" && (
                      <span className={`rounded-full text-white px-2 py-0.5 ${t.dviSource === "autovitals" ? "bg-teal-600" : "bg-amber-600"}`}>
                        {t.dviSource === "autovitals" ? "AutoVitals 🟡" : "DVI 🟡"}
                      </span>
                    )}
                    {t.source === "protractor" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 border border-blue-200 px-2 py-0.5">
                            <img 
                              src={shopLogo || "/protractor-icon.png"} 
                              alt="Shop" 
                              className="w-4 h-4 rounded-full object-cover"
                            />
                            <span className="text-blue-700 text-xs">Deferred</span>
                          </span>
                        )}
                    {t.usingShopInterval && <span className="rounded-full bg-green-600 text-white px-2 py-0.5">Shop</span>}
                    {t.declined && (
                      <span className="rounded-full bg-orange-100 text-orange-700 border border-orange-300 px-2 py-0.5 font-medium">
                        Previously declined
                      </span>
                    )}
                    {(() => {
                      const opts = getCannedJobOptionsForService(t.serviceKey);
                      return (
                        <AddToROWithHistory
                          vin={vin}
                          serviceTitle={t.title}
                          serviceKey={t.serviceKey}
                          vehicleYear={vehicleYear}
                          vehicleMake={vehicleMake}
                          vehicleModel={vehicleModel}
                          vehicleEngine={vehicleEngine}
                          workOrderGuid={latestWorkOrderId ?? undefined}
                          workOrderId={latestRoNumber ?? undefined}
                          cannedJobOptions={opts}
                          allCannedJobs={allCannedJobsList}
                        />
                      );
                    })()}
                  </div>

                  <div className="text-sm mt-2">
                    {t.source === "protractor" && t.reason && (
                      <div className="text-neutral-600">{t.reason}</div>
                    )}
                    {t.milesToGo != null && t.milesToGo > 0 && (
                      <>
                        In ~<strong>{fmtDistance(t.milesToGo, distanceUnit)}</strong> {distLabel}
                      </>
                    )}
                    {t.milesToGo != null && t.daysToGo != null && <> • </>}
                    {t.daysToGo != null && t.daysToGo > 0 && (
                      <>
                        In ~<strong>{t.daysToGo}</strong> days
                      </>
                    )}
                  </div>

                  {t.last?.miles != null && (
                    <div className="text-xs text-neutral-600 mt-1 flex items-center gap-1.5">
                      <span>Last done at {fmtDistance(t.last.miles, distanceUnit)} {distLabel}{t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}</span>
                      {t.last?.source === "carfax" && (
                        <img src="/badges/carfax.png" alt="CARFAX" className="h-3.5" title="From CARFAX" />
                      )}
                      {(t.last?.source === "protractor" || t.last?.source === "shop") && (
                        shopLogo ? (
                          <img src={shopLogo} alt="Shop" className="h-4" title="From Shop History" />
                        ) : (
                          <img src="/badges/protractor.png" alt="Protractor" className="h-4" title="From Protractor" />
                        )
                      )}
                    </div>
                  )}

                  {t.declined && (
                    <div className="text-xs text-orange-700 mt-1 bg-orange-50 rounded px-2 py-1">
                      Declined on {new Date(t.declined.declinedAt).toLocaleDateString()}
                      {t.declined.mileage && ` at ${fmtDistance(t.declined.mileage, distanceUnit)} ${distLabel}`}
                      {t.declined.reason && ` - ${t.declined.reason}`}
                    </div>
                  )}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Why this is recommended</summary>
                    <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-700 space-y-1">
                      <div>
                        <span className="font-medium">{t.usingShopInterval ? "Shop" : "OEM"} Interval:</span>{" "}
                        {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : "—"}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </div>
                      <div>
                        <span className="font-medium inline-flex items-center gap-1">
                          Last done
                          {t.last?.source === "carfax" && <img src="/badges/carfax.png" alt="CARFAX" className="h-3 inline" />}
                          {(t.last?.source === "protractor" || t.last?.source === "shop") && (
                            shopLogo ? (
                              <img src={shopLogo} alt="Shop" className="h-3.5 inline" />
                            ) : (
                              <img src="/badges/protractor.png" alt="Protractor" className="h-3.5 inline" />
                            )
                          )}
                          :
                        </span>{" "}
                        {t.last?.miles != null ? `${fmtDistance(t.last.miles, distanceUnit)} ${distLabel}` : "—"}
                        {t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                      </div>
                      <div>
                        <span className="font-medium">Next due:</span>{" "}
                        {t.dueAtMiles != null ? `${fmtDistance(t.dueAtMiles, distanceUnit)} ${distLabel}` : "—"}
                        {t.dueAtDate ? ` or ${t.dueAtDate.toLocaleDateString()}` : ""}
                      </div>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Upcoming */}
        <section id="upcoming" className="space-y-3">
          <h2 className="text-lg font-semibold text-emerald-700 flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-600" /> Upcoming ({counts.upcoming})
          </h2>
          {buckets.upcoming.length === 0 ? (
            <div className="text-sm text-neutral-500">No upcoming items.</div>
          ) : (
            <ul className="space-y-3">
              {buckets.upcoming.map((t) => (
                <li key={t.key} className="rounded-xl border p-3">
                  <div className="font-medium">{t.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
                    {t.category && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{t.category}</span>}
                    <span className="rounded-full bg-emerald-600 text-white px-2 py-0.5">UPCOMING</span>
                    {(t.intervalMiles || t.intervalMonths) && (
                      <span className="rounded-full border px-2 py-0.5">
                        OEM: {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : ""}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </span>
                    )}
                    {t.usingShopInterval && <span className="rounded-full bg-green-600 text-white px-2 py-0.5">Shop</span>}
                    {t.declined && (
                      <span className="rounded-full bg-orange-100 text-orange-700 border border-orange-300 px-2 py-0.5 font-medium">
                        Previously declined
                      </span>
                    )}
                    {(() => {
                      const opts = getCannedJobOptionsForService(t.serviceKey);
                      return (
                        <AddToROWithHistory
                          vin={vin}
                          serviceTitle={t.title}
                          serviceKey={t.serviceKey}
                          vehicleYear={vehicleYear}
                          vehicleMake={vehicleMake}
                          vehicleModel={vehicleModel}
                          vehicleEngine={vehicleEngine}
                          workOrderGuid={latestWorkOrderId ?? undefined}
                          workOrderId={latestRoNumber ?? undefined}
                          cannedJobOptions={opts}
                          allCannedJobs={allCannedJobsList}
                        />
                      );
                    })()}
                  </div>

                  <div className="text-sm mt-2">
                    {t.dueAtMiles != null && (
                      <>
                        Next at ~<strong>{fmtDistance(t.dueAtMiles, distanceUnit)}</strong> {distLabel}
                      </>
                    )}
                    {t.dueAtMiles != null && t.dueAtDate != null && <> • </>}
                    {t.dueAtDate != null && (
                      <>
                        By ~<strong>{t.dueAtDate.toLocaleDateString()}</strong>
                      </>
                    )}
                  </div>

                  {t.declined && (
                    <div className="text-xs text-orange-700 mt-1 bg-orange-50 rounded px-2 py-1">
                      Declined on {new Date(t.declined.declinedAt).toLocaleDateString()}
                      {t.declined.mileage && ` at ${fmtDistance(t.declined.mileage, distanceUnit)} ${distLabel}`}
                      {t.declined.reason && ` - ${t.declined.reason}`}
                    </div>
                  )}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Show details</summary>
                    <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-700 space-y-1">
                      <div>
                        <span className="font-medium">{t.usingShopInterval ? "Shop" : "OEM"} Interval:</span>{" "}
                        {t.intervalMiles ? `${fmtDistance(t.intervalMiles, distanceUnit)} ${distLabel}` : "—"}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </div>
                      {t.last?.miles != null && (
                        <div>
                          <span className="font-medium">Last done (CARFAX):</span>{" "}
                          {fmtDistance(t.last.miles, distanceUnit)} {distLabel}{t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Debug */}
        <details className="mt-6">
          <summary className="cursor-pointer">Debug (inputs)</summary>
          <pre className="mt-2 text-xs bg-gray-50 p-3 rounded overflow-auto max-h-72">
            {JSON.stringify(
              {
                currentMiles,
                mpdBlended,
                carfaxOk: (carfax as any).ok ?? false,
                dviOk: (dvi as any).ok ?? false,
                oemCount: oemItems.length,
              },
              null,
              2
            )}
          </pre>
        </details>
      </div>
    </main>
    </PlanTrialGate>
  );
}
