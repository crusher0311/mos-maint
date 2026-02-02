import { Suspense } from "react";
import Link from "next/link";
import sql from "@/lib/db/postgres";
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
import { getVehicleRecallsLocal, getEnhancedVehicleDataLocal, type VehicleRecall } from "@/lib/integrations/dataone-local";
import {
  resolveProtractorConfig,
  fetchVehicleWithCache as fetchProtractorVehicle,
  fetchDeferredWorkWithCache as fetchProtractorDeferredWork,
  fetchCannedJobsWithCache,
  type ProtractorDeferredWork,
} from "@/lib/integrations/protractor";
import {
  resolveAutoVitalsConfig,
  fetchAutoVitalsInspectionByVin,
} from "@/lib/integrations/autovitals";
import { AddToROButton } from "@/components/ui/AddToROButton";
import { AddToROWithHistory } from "@/components/ui/AddToROWithHistory";
import { AddAllDeferredButton } from "@/components/ui/AddAllDeferredButton";
import { PlanTrialGate } from "@/components/ui/PlanTrialGate";
import { PrintButton } from "@/components/ui/PrintButton";
import { getCachedPlan, setCachedPlan, type CachedPlanData, type TriagedItemCache } from "@/lib/plan-cache";
import { isFeatureEnabled } from "@/lib/features";
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

const OE_LOGO_MAP: Record<string, string> = {
  "AUDI": "/logos/makes/audi.png",
  "CADILLAC": "/logos/makes/cadillac.png",
  "CHEVROLET": "/logos/makes/chevrolet.png",
  "CHRYSLER": "/logos/makes/chrysler.png",
  "FORD": "/logos/makes/ford.png",
  "HONDA": "/logos/makes/honda.png",
  "JAGUAR": "/logos/makes/jaguar.png",
  "LEXUS": "/logos/makes/lexus.png",
  "LINCOLN": "/logos/makes/lincoln.png",
  "MAZDA": "/logos/makes/mazda.png",
  "MERCEDES-BENZ": "/logos/makes/mercedes-benz.png",
  "SUBARU": "/logos/makes/subaru.png",
  "TOYOTA": "/logos/makes/toyota.png",
};

function getOELogoUrl(make: string | null | undefined): string | null {
  if (!make) return null;
  const normalized = make.toUpperCase().trim();
  return OE_LOGO_MAP[normalized] || null;
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
async function getLatestMilesForVin(vinRaw: string): Promise<number | null> {
  const vin = String(vinRaw || "").toUpperCase();
  const toPos = (v: unknown) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // Latest RO mileage (join with vehicles to get by VIN)
  const roResult = await sql`
    SELECT w.odometer_in as mileage 
    FROM work_orders w
    JOIN vehicles v ON w.vehicle_id = v.id
    WHERE v.vin = ${vin}
    ORDER BY w.updated_at DESC NULLS LAST, w.created_at DESC NULLS LAST
    LIMIT 1
  `;
  const mRO = toPos(roResult[0]?.mileage);

  // Latest event with mileage
  const afResult = await sql`
    SELECT 
      COALESCE(
        (payload->>'mileage')::numeric,
        (payload->'ticket'->>'mileage')::numeric,
        (payload->'vehicle'->>'mileage')::numeric,
        (payload->'vehicle'->>'miles')::numeric,
        (payload->'vehicle'->>'odometer')::numeric
      ) as mileage
    FROM events
    WHERE UPPER(COALESCE(vin, payload->'vehicle'->>'vin')) = ${vin}
    ORDER BY created_at DESC NULLS LAST
    LIMIT 10
  `;
  const mAF = afResult.map((x: any) => toPos(x?.mileage)).find((x: any) => x != null) ?? null;

  // Vehicle-level odometer/lastMileage/mileage
  const vehResult = await sql`
    SELECT mileage, odometer, last_mileage FROM vehicles 
    WHERE vin = ${vin}
    LIMIT 1
  `;
  const veh = vehResult[0];
  const mVeh = toPos(veh?.mileage) ?? toPos(veh?.odometer) ?? toPos(veh?.last_mileage);

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

// Display names for normalized service keys
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

type MatchedDeferred = {
  id: string;
  title: string;
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
  protractorDeferredId?: string;
  matchedDeferred?: MatchedDeferred; // OEM item has matching deferred work
};

type ShopIntervalOverride = {
  useShop: boolean;
  miles: number | null;
  months: number | null;
};

type Buckets = { overdue: TriagedItem[]; dueSoon: TriagedItem[]; upcoming: TriagedItem[] };

const DEFAULT_SOON_MILES = 1000;
const DEFAULT_SOON_DAYS = 30;

type ShopServiceHistory = {
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

  // Build shop service history map (from Protractor and/or Tekmetric work orders)
  const shopHistoryByKey = new Map<string, { miles: number | null; date: Date | null }[]>();
  for (const sh of shopServiceHistory || []) {
    const keys = toKeyFromFreeText(sh.serviceName || "");
    for (const k of keys) {
      if (!shopHistoryByKey.has(k)) shopHistoryByKey.set(k, []);
      shopHistoryByKey.get(k)!.push({ miles: sh.mileage, date: sh.date });
    }
  }

  // last-done map: merge CARFAX with shop history (shop wins if matching)
  const lastMap = new Map<string, LastDone>();
  
  // First, add all shop service history as shop source
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
  
  // Pre-compute deferred work info to match with OEM items
  // Maps serviceKey → first matching deferred item (for attaching "+ deferred" button to OEM items)
  const deferredByServiceKey = new Map<string, MatchedDeferred>();
  const seenDeferredTitles = new Set<string>();
  const deferredServiceKeysUsedByOem = new Set<string>(); // Track which deferred items matched OEM
  for (const dw of protractorDeferredWork || []) {
    const title = dw.Title 
      || dw.ServicePackageHeader?.Title 
      || dw.Code 
      || dw.Description 
      || dw.ServicePackageHeader?.Description
      || "Deferred Service";
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
    
    // Check if there's matching deferred work for this OEM item
    const matchedDeferred = deferredByServiceKey.get(serviceKey);
    if (matchedDeferred) {
      deferredServiceKeysUsedByOem.add(serviceKey); // Mark as used so we hide it from deferred section
    }
    
    // Skip duplicate service keys - only keep first occurrence
    // This prevents "Change engine oil" and "Replace oil filter" from both showing
    if (usedServiceKeys.has(serviceKey) && !serviceKey.startsWith("misc_")) {
      continue;
    }
    usedServiceKeys.add(serviceKey);
    
    const uniqueKey = `${serviceKey}_${o.maintenance_id}`;
    const last = lastMap.get(serviceKey) ?? null;
    
    // Check for shop interval override - only use shop intervals if:
    // 1. Shop has configured custom intervals for this service (useShop === true)
    // 2. Service was last performed at shop (last?.source === 'shop')
    const shopOverride = shopIntervals[serviceKey];
    const lastPerformedAtShop = last?.source === 'shop';
    const usingShopInterval = shopOverride?.useShop === true && lastPerformedAtShop;
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
    // Use normalized display name if available, otherwise keep original OEM name
    const displayTitle = SERVICE_KEY_DISPLAY_NAMES[serviceKey] || o.name;
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
      matchedDeferred, // Attach matching deferred work for "+ deferred" button
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
  // seenDeferredTitles was already built above for OEM matching - reuse it here
  for (const dw of protractorDeferredWork || []) {
    const title = dw.Title 
      || dw.ServicePackageHeader?.Title 
      || dw.Code 
      || dw.Description 
      || dw.ServicePackageHeader?.Description
      || "Deferred Service";
    
    // Normalize title for deduplication (already computed above, check if seen)
    const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!seenDeferredTitles.has(normalizedTitle)) {
      continue; // Only process items that were seen in pre-computation (handles dedup)
    }
    // Mark as processed by removing from set (first occurrence wins)
    seenDeferredTitles.delete(normalizedTitle);
    
    const protractorServiceKey = toKeyFromName(title) || `protractor_${dw.ID}`;
    
    // Skip deferred items that matched an OEM item - they'll show the "+ deferred" button on the OEM row
    if (deferredServiceKeysUsedByOem.has(protractorServiceKey)) {
      continue;
    }
    
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
type PageProps = { params: Promise<{ vin: string }>; searchParams?: Promise<{ refresh?: string }> };

export default function VehiclePlanPage({ params, searchParams }: PageProps) {
  return (
    <Suspense fallback={<PlanLoading />}>
      <PlanContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function PlanContent({ params, searchParams }: PageProps) {
  const session = await requireSession();
  const resolvedSearchParams = await searchParams;
  const forceRefresh = resolvedSearchParams?.refresh === "1";
  const shopId = String(session.shopId);

  const { vin: vinParam } = await params;
  const vin = String(vinParam || "").toUpperCase();

  const shopResult = await sql`
    SELECT id, maintenance, protractor, preferences FROM shops
    WHERE shop_id = ${shopId}
    LIMIT 1
  `;
  const shop = shopResult[0] as any;
  const shopUuid = shop?.id as string | undefined; // UUID for foreign key lookups
  const distanceUnit: DistanceUnit = shop?.preferences?.distanceUnit || "miles";
  const distLabel = getDistanceLabel(distanceUnit);
  const hasJobLookupFeature = await isFeatureEnabled(Number(shopId), "job_lookup");
  const showInspectItems = shop?.preferences?.showInspectItems !== false; // default true
  const showRecalls = shop?.preferences?.showRecalls !== false; // default true
  const recallsExpanded = shop?.preferences?.recallsExpanded !== false; // default true
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
  
  const cannedJobsCache = await fetchCannedJobsWithCache(shopId);
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
    const result = ids
      .map(id => cannedJobsById[id])
      .filter(Boolean);
    // Debug: log mapping lookup
    if (ids.length > 0 || Object.keys(cannedJobMappings).length > 0) {
      console.log(`[CannedJobs] serviceKey="${serviceKey}" -> mappedIds=[${ids.join(",")}] -> found=${result.length} jobs`);
    }
    return result;
  }
  
  // Debug: log available mappings and canned jobs
  console.log(`[CannedJobs] Shop ${shopId} mappings:`, Object.keys(cannedJobMappings));
  console.log(`[CannedJobs] Shop ${shopId} cannedJobsById count:`, Object.keys(cannedJobsById).length);
  
  const vehicleResult = shopUuid ? await sql`
    SELECT year, make, model, vin, last_mileage, customer_id, updated_at, declined_services
    FROM vehicles
    WHERE shop_id = ${shopUuid}::uuid AND vin = ${vin}
    LIMIT 1
  ` : [];
  const vehicle = vehicleResult[0] ? {
    ...vehicleResult[0],
    lastMileage: vehicleResult[0].last_mileage,
    customerId: vehicleResult[0].customer_id,
    updatedAt: vehicleResult[0].updated_at,
    declinedServices: vehicleResult[0].declined_services,
  } : null;

  // Early mileage check and cache lookup (skip cache if force refresh)
  const earlyMiles = await getLatestMilesForVin(vin);
  const cachedPlan = forceRefresh ? null : await getCachedPlan(vin, Number(shopId), earlyMiles);
  const useCachedData = cachedPlan !== null;
  
  if (useCachedData) {
    console.log(`[Plan] Cache HIT for ${vin} - will use cached buckets`);
  } else {
    console.log(`[Plan] Cache MISS for ${vin}${forceRefresh ? " (force refresh)" : ""} - building from sources`);
  }

  // Get repair orders from events collection (AutoFlow webhooks store RO data here)
  // This matches the detail page logic exactly
  const eventRos = await sql`
    WITH event_ros AS (
      SELECT 
        COALESCE(
          payload->'ticket'->>'invoice',
          payload->'ticket'->>'id',
          ro_number
        ) as ro_number,
        COALESCE(payload->'ticket'->>'status', status) as status,
        COALESCE(
          (payload->'ticket'->>'mileage')::numeric,
          (payload->'vehicle'->>'mileage')::numeric
        ) as mileage,
        created_at
      FROM events
      WHERE shop_id = ${shopUuid}::uuid
        AND provider = 'autoflow'
        AND UPPER(COALESCE(vin, payload->'vehicle'->>'vin')) = ${vin}
    ),
    grouped_ros AS (
      SELECT DISTINCT ON (ro_number)
        ro_number,
        status,
        mileage,
        created_at as updated_at,
        created_at
      FROM event_ros
      WHERE ro_number IS NOT NULL
      ORDER BY ro_number, created_at DESC
    )
    SELECT * FROM grouped_ros
    ORDER BY updated_at DESC
    LIMIT 20
  `;

  const ros = eventRos as any[];
  
  let latestRoNumber = ros[0]?.ro_number ?? null;
  let latestWorkOrderId: string | null = null;
  let latestRepairOrderId: string | number | null = null;
  let activeIntegration: "protractor" | "tekmetric" | null = null;
  let customerName: string | null = null;
  
  // Helper to extract customer name from work order (works for all integrations)
  const extractCustomerName = (wo: any): string | null => {
    // Tekmetric format
    if (wo?.customerName) return wo.customerName;
    if (wo?.contactName) return wo.contactName;
    // Protractor format - flat fields
    if (wo?.data?.contactName) return wo.data.contactName;
    // Protractor format - nested Contact structure
    const contact = wo?.Contact || wo?.data?.Contact;
    if (contact?.Name) {
      const firstName = contact.Name.FirstName || '';
      const lastName = contact.Name.LastName || '';
      const name = [firstName, lastName].filter(Boolean).join(' ').trim();
      if (name) return name;
    }
    return wo?.data?.customerName || null;
  };
  
  // Query all connected work order sources in parallel
  const [protractorWOResult, tekmetricWOResult, autoflowWOResult] = await Promise.all([
    // Protractor work orders
    shopUuid ? sql`
      SELECT * FROM protractor_work_orders
      WHERE shop_id = ${shopUuid}::uuid AND UPPER(vin) = ${vin}
      ORDER BY fetched_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    ` : sql`SELECT NULL WHERE FALSE`,
    // Tekmetric work orders
    shopUuid ? sql`
      SELECT * FROM tekmetric_work_orders
      WHERE shop_id = ${shopUuid}::uuid AND UPPER(vin) = ${vin}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    ` : sql`SELECT NULL WHERE FALSE`,
    // AutoFlow work orders (via webhook events)
    shopUuid ? sql`
      SELECT * FROM events
      WHERE shop_id = ${shopUuid}::uuid
        AND UPPER(COALESCE(vin, payload->'vehicle'->>'vin')) = ${vin}
      ORDER BY created_at DESC
      LIMIT 1
    ` : sql`SELECT NULL WHERE FALSE`
  ]);
  
  const protractorWO = protractorWOResult[0] as any;
  const tekmetricWO = tekmetricWOResult[0] as any;
  const autoflowWO = autoflowWOResult[0] as any;
  
  // Pick the most recent work order from any connected source
  type WOCandidate = { source: string; roNumber: string; workOrderId: string | null; customerName: string | null; updatedAt: Date };
  const candidates: WOCandidate[] = [];
  
  if (protractorWO) {
    const woNumber = protractorWO.workOrderNumber || protractorWO.WorkOrderNumber || protractorWO.data?.WorkOrderNumber;
    if (woNumber) {
      candidates.push({
        source: 'Protractor',
        roNumber: String(woNumber),
        workOrderId: protractorWO.workOrderId || protractorWO.ID || protractorWO.data?.ID || null,
        customerName: extractCustomerName(protractorWO),
        updatedAt: protractorWO.fetchedAt || protractorWO.createdAt || new Date(0)
      });
    }
  }
  
  if (tekmetricWO) {
    // Tekmetric snapshot uses: workOrderNumber for display, workOrderId for the actual repair order ID
    const woNumber = tekmetricWO.workOrderNumber || tekmetricWO.data?.repairOrderNumber;
    if (woNumber) {
      candidates.push({
        source: 'Tekmetric',
        roNumber: String(woNumber),
        workOrderId: tekmetricWO.workOrderId || (tekmetricWO.data?.id ? String(tekmetricWO.data.id) : null),
        customerName: extractCustomerName(tekmetricWO),
        updatedAt: tekmetricWO.updatedDate ? new Date(tekmetricWO.updatedDate) : (tekmetricWO.fetchedAt || new Date(0))
      });
    }
  }
  
  if (autoflowWO) {
    const woNumber = autoflowWO.payload?.ticket?.invoice || autoflowWO.payload?.ticket?.id || autoflowWO.roNumber;
    if (woNumber) {
      candidates.push({
        source: 'AutoFlow',
        roNumber: String(woNumber),
        workOrderId: null,
        customerName: autoflowWO.payload?.customer?.name || autoflowWO.customerName || null,
        updatedAt: autoflowWO.createdAt || new Date(0)
      });
    }
  }
  
  // Sort by most recent and pick the best candidate
  if (candidates.length > 0) {
    candidates.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const best = candidates[0];
    latestRoNumber = best.roNumber;
    latestWorkOrderId = best.workOrderId ? String(best.workOrderId) : null;
    customerName = best.customerName;
    
    // Set active integration based on which source won
    if (best.source === 'Tekmetric') {
      activeIntegration = 'tekmetric';
      latestRepairOrderId = best.workOrderId;
    } else if (best.source === 'Protractor') {
      activeIntegration = 'protractor';
    }
    
    console.log(`[Plan Debug] Found ${best.source} RO: ${latestRoNumber}, Customer: ${customerName}, Integration: ${activeIntegration}`);
  }
  
  console.log(`[Plan Debug] Latest RO number: ${latestRoNumber}, total ROs: ${ros.length}, sources checked: Protractor/Tekmetric/AutoFlow`);

  // PARALLEL CONFIG RESOLUTION AND LOCAL DATA - always needed for rendering
  const DVI_CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days
  const CARFAX_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days  
  const PROTRACTOR_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
  const vinUpper = vin.toUpperCase();

  // Declare variables for API results - will be populated conditionally
  let dvi: any = { ok: false };
  let carfax: any = { ok: false };
  let protractorVehicleResult: any = { ok: false };
  let avInspectionResult: any = { ok: false };
  let protractorCompletedWOs: any[] = [];
  let tekmetricCompletedWOs: any[] = [];
  let shopBranding: any = null;
  let autoCfg: any = { configured: false };
  let carfaxCfg: any = { configured: false };
  let protractorCfg: any = { configured: false };
  let autoVitalsCfg: any = { configured: false };
  
  // Fetch NHTSA recalls from local PostgreSQL (always fast, no caching needed)
  const recallsResult = await getVehicleRecallsLocal(vin);
  const recalls: VehicleRecall[] = recallsResult.ok ? recallsResult.recalls : [];
  const recallCount = recallsResult.ok ? recallsResult.count : 0;
  const safetyCriticalCount = recallsResult.ok ? recallsResult.safetyCriticalCount : 0;

  // CACHE HIT: Only fetch cheap local data needed for UI (shop branding, config status)
  // Also fetch Protractor vehicle info for deferred work (deferred work is dynamic, not cached)
  if (useCachedData) {
    console.log(`[Plan] Cache HIT - skipping expensive external API calls`);
    const [localAutoCfg, localCarfaxCfg, localProtractorCfg, localAutoVitalsCfg, localShopBrandingResult] = await Promise.all([
      resolveAutoflowConfig(Number(shopId)),
      resolveCarfaxConfig(Number(shopId)),
      resolveProtractorConfig(Number(shopId)),
      resolveAutoVitalsConfig(Number(shopId)),
      sql`SELECT branding FROM shops WHERE shop_id = ${shopId} LIMIT 1`
    ]);
    autoCfg = localAutoCfg;
    carfaxCfg = localCarfaxCfg;
    protractorCfg = localProtractorCfg;
    autoVitalsCfg = localAutoVitalsCfg;
    shopBranding = localShopBrandingResult[0];
    
    // Fetch Protractor vehicle info for deferred work (needed even on cache hit)
    if (protractorCfg.configured) {
      protractorVehicleResult = await fetchProtractorVehicle(Number(shopId), vin, PROTRACTOR_CACHE_TTL);
    }
  } else {
    // CACHE MISS: Full parallel data fetching - external APIs + local queries
    console.log(`[Plan] Cache MISS - fetching all external data`);
    const [localAutoCfg, localCarfaxCfg, localProtractorCfg, localAutoVitalsCfg] = await Promise.all([
      resolveAutoflowConfig(Number(shopId)),
      resolveCarfaxConfig(Number(shopId)),
      resolveProtractorConfig(Number(shopId)),
      resolveAutoVitalsConfig(Number(shopId))
    ]);
    autoCfg = localAutoCfg;
    carfaxCfg = localCarfaxCfg;
    protractorCfg = localProtractorCfg;
    autoVitalsCfg = localAutoVitalsCfg;

    const [localDvi, localCarfax, localProtractorVehicleResult, localAvInspectionResult, localProtractorCompletedWOs, localTekmetricCompletedWOs, localShopBrandingResult] = await Promise.all([
      latestRoNumber && autoCfg.configured
        ? fetchDviWithCache(Number(shopId), String(latestRoNumber), DVI_CACHE_TTL)
        : Promise.resolve({ ok: false, error: latestRoNumber ? "AutoFlow not connected." : "No RO found." }),
      carfaxCfg.configured
        ? fetchCarfaxWithCache(Number(shopId), vin, CARFAX_CACHE_TTL)
        : Promise.resolve({ ok: false, error: "CARFAX not configured." as const }),
      protractorCfg.configured
        ? fetchProtractorVehicle(Number(shopId), vin, PROTRACTOR_CACHE_TTL)
        : Promise.resolve({ ok: false } as { ok: false }),
      autoVitalsCfg.configured
        ? fetchAutoVitalsInspectionByVin(Number(shopId), vin, PROTRACTOR_CACHE_TTL)
        : Promise.resolve({ ok: false } as { ok: false }),
      shopUuid ? sql`
        SELECT * FROM protractor_work_orders
        WHERE shop_id = ${shopUuid}::uuid AND UPPER(vin) = ${vinUpper}
        ORDER BY fetched_at DESC NULLS LAST
        LIMIT 20
      ` : sql`SELECT NULL WHERE FALSE`,
      shopUuid ? sql`
        SELECT * FROM tekmetric_work_orders
        WHERE shop_id = ${shopUuid}::uuid AND UPPER(vin) = ${vinUpper}
        ORDER BY closed_date DESC NULLS LAST
        LIMIT 50
      ` : sql`SELECT NULL WHERE FALSE`,
      sql`SELECT branding FROM shops WHERE shop_id = ${shopId} LIMIT 1`
    ]);
    dvi = localDvi;
    carfax = localCarfax;
    protractorVehicleResult = localProtractorVehicleResult;
    avInspectionResult = localAvInspectionResult;
    protractorCompletedWOs = localProtractorCompletedWOs as any[];
    tekmetricCompletedWOs = localTekmetricCompletedWOs as any[];
    shopBranding = localShopBrandingResult[0];
  }

  // Protractor Deferred Work - always fetch fresh for Protractor shops (it's dynamic)
  let protractorDeferredWork: ProtractorDeferredWork[] = [];
  if (protractorCfg.configured && (protractorVehicleResult as any).ok && (protractorVehicleResult as any).vehicle?.ID) {
    const deferredResult = await fetchProtractorDeferredWork(
      Number(shopId),
      vin,
      (protractorVehicleResult as any).vehicle.ID,
      PROTRACTOR_CACHE_TTL
    );
    if (deferredResult.ok && deferredResult.deferredWork) {
      protractorDeferredWork = deferredResult.deferredWork;
    }
  } else if (useCachedData && cachedPlan?.plan?.deferredWork) {
    // Fallback to cached deferred work if Protractor fetch not available
    protractorDeferredWork = cachedPlan.plan.deferredWork as ProtractorDeferredWork[];
  }

  // Extract service history from completed work orders - only on cache miss
  const shopServiceHistory: ShopServiceHistory[] = [];
  if (!useCachedData) {
  for (const wo of protractorCompletedWOs) {
    const mileage = wo.Odometer ?? wo.OutUsage ?? wo.data?.Odometer ?? null;
    const dateStr = wo.Header?.LastModifiedTime ?? wo.Header?.CreationTime ?? wo.data?.Header?.LastModifiedTime ?? null;
    const date = dateStr ? new Date(dateStr) : null;
    
    const servicePackages = wo.ServicePackages ?? wo.data?.ServicePackages ?? [];
    for (const pkg of servicePackages) {
      const serviceName = pkg.Title ?? pkg.Description ?? "";
      if (serviceName) {
        shopServiceHistory.push({ serviceName, mileage, date });
      }
      for (const line of pkg.ServicePackageLines ?? []) {
        const lineName = line.Description ?? "";
        if (lineName && lineName !== serviceName) {
          shopServiceHistory.push({ serviceName: lineName, mileage, date });
        }
      }
    }
  }
  console.log(`[Plan Debug] Protractor service history entries: ${shopServiceHistory.length}`);
  
  // Extract service history from Tekmetric completed work orders
  for (const wo of tekmetricCompletedWOs) {
    const mileage = wo.odometer ?? wo.data?.milesOut ?? wo.data?.milesIn ?? null;
    const date = wo.completedDate ? new Date(wo.completedDate) : null;
    
    // Jobs are stored in wo.data.jobs (canonical) or wo.jobs (fallback for legacy documents)
    const jobs = wo.data?.jobs ?? wo.jobs ?? [];
    for (const job of jobs) {
      const serviceName = job.name ?? job.description ?? "";
      if (serviceName) {
        shopServiceHistory.push({ serviceName, mileage, date });
      }
    }
  }
  console.log(`[Plan Debug] Total shop service history entries (Protractor + Tekmetric): ${shopServiceHistory.length}`);
  }

  const shopLogo: string | null = shopBranding?.branding?.logo || null;

  // Miles/day - use cached value on cache hit, calculate on cache miss
  let mpdBlended: number | null = useCachedData ? (cachedPlan?.plan?.mpdBlended ?? null) : null;
  if (!useCachedData && (carfax as any).ok && Array.isArray((carfax as any).serviceRecords)) {
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

  // Get current miles and OEM schedule - skip OEM fetch on cache hit
  let currentMiles: number | null;
  let oemData: any = { source: 'cache', count: 0, items: [], vehicle: null };
  
  if (useCachedData) {
    // On cache hit, use cached current miles (already validated in cache lookup)
    currentMiles = cachedPlan?.plan?.currentMiles ?? null;
    console.log(`[Plan] Using cached currentMiles: ${currentMiles}`);
  } else {
    // On cache miss, fetch both current miles and OEM schedule
    const [fetchedMiles, fetchedOemData] = await Promise.all([
      getLatestMilesForVin(vin),
      getMaintenanceScheduleCached(vin)
    ]);
    currentMiles = fetchedMiles;
    oemData = fetchedOemData;
    console.log(`[Plan] OEM data source: ${oemData.source}, count: ${oemData.count}`);
  }

  // Always fetch vehicle info from DataOne local for accurate make/model (fast local query)
  const dataoneVehicle = await getEnhancedVehicleDataLocal(vin);
  
  // Vehicle info fallback: try all sources - DataOne local, cache, vehicles collection, and OEM data
  const vehicleYear = dataoneVehicle.vehicle?.year ?? cachedPlan?.plan?.vehicle?.year ?? vehicle?.year ?? oemData.vehicle?.year;
  const vehicleMake = dataoneVehicle.vehicle?.make ?? cachedPlan?.plan?.vehicle?.make ?? vehicle?.make ?? oemData.vehicle?.make;
  const vehicleModel = dataoneVehicle.vehicle?.model ?? cachedPlan?.plan?.vehicle?.model ?? vehicle?.model ?? oemData.vehicle?.model;
  const vehicleEngine = dataoneVehicle.vehicle?.engine ?? cachedPlan?.plan?.vehicle?.engine ?? oemData.vehicle?.engine;

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

  // Filter out "Inspect" or "Check" items if preference is off
  const isInspectItemFilter = (item: TriagedItem) => {
    const title = item.title?.toLowerCase() || "";
    return title.includes("inspect") || title.startsWith("check ");
  };

  // Use cached buckets if available, otherwise build from triage
  let buckets: Buckets;
  
  // Check if cached buckets are missing deferred work that should be included
  const cachedDeferredCount = cachedPlan?.plan?.buckets 
    ? [...(cachedPlan.plan.buckets.overdue || []), ...(cachedPlan.plan.buckets.dueSoon || [])].filter((i: any) => i.source === "protractor").length 
    : 0;
  const hasDeferredMismatch = protractorDeferredWork.length > 0 && cachedDeferredCount === 0;
  
  if (useCachedData && cachedPlan) {
    console.log(`[Plan] Using cached buckets for ${vin}`);
    const cached = cachedPlan.plan;
    
    // Convert cached items back to TriagedItem format (dates stored as ISO strings)
    const convertCacheItem = (item: TriagedItemCache): TriagedItem => ({
      ...item,
      last: item.last ? {
        miles: item.last.miles,
        date: item.last.date ? new Date(item.last.date) : null,
        source: item.last.source as "carfax" | "protractor" | "shop" | undefined,
      } : undefined,
      dueAtDate: item.dueAtDate ? new Date(item.dueAtDate) : null,
    });
    
    buckets = {
      overdue: cached.buckets.overdue.map(convertCacheItem),
      dueSoon: cached.buckets.dueSoon.map(convertCacheItem),
      upcoming: cached.buckets.upcoming.map(convertCacheItem),
    };
    
    // If we have fresh deferred work that's not in cached buckets, add it now
    if (hasDeferredMismatch) {
      console.log(`[Plan] Adding ${protractorDeferredWork.length} deferred items to cached buckets`);
      const existingKeys = new Set([
        ...buckets.overdue.map(i => i.serviceKey),
        ...buckets.dueSoon.map(i => i.serviceKey),
        ...buckets.upcoming.map(i => i.serviceKey),
      ]);
      
      for (const dw of protractorDeferredWork) {
        const title = dw.Title || dw.ServicePackageHeader?.Title || dw.Code || dw.Description || "Deferred Service";
        const serviceKey = toKeyFromName(title);
        
        // Skip if already in buckets (as OEM or other item)
        if (existingKeys.has(serviceKey)) continue;
        
        const deferredItem: TriagedItem = {
          key: `protractor_deferred_${dw.ID}`,
          serviceKey,
          title,
          category: dw.Chapter || "Maintenance",
          intervalMiles: null,
          intervalMonths: null,
          last: undefined,
          dueAtMiles: null,
          dueAtDate: null,
          milesToGo: null,
          daysToGo: null,
          bump: "overdue",
          source: "protractor",
          reason: "Previously recommended but not performed",
          protractorDeferredId: dw.ID,
        };
        buckets.overdue.push(deferredItem);
        existingKeys.add(serviceKey);
      }
    }
  } else {
    const rawBuckets = triage({
      oemItems,
      carfaxRecords,
      shopServiceHistory,
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

    buckets = showInspectItems ? rawBuckets : {
      overdue: rawBuckets.overdue.filter(i => !isInspectItemFilter(i)),
      dueSoon: rawBuckets.dueSoon.filter(i => !isInspectItemFilter(i)),
      upcoming: rawBuckets.upcoming.filter(i => !isInspectItemFilter(i)),
    };

    console.log(`[Plan Debug] Thresholds: soonMiles=${soonMiles}, soonDays=${soonDays}`);
    console.log(`[Plan Debug] Buckets: overdue=${rawBuckets.overdue.length}, dueSoon=${rawBuckets.dueSoon.length}, upcoming=${rawBuckets.upcoming.length}${!showInspectItems ? ` (filtered: overdue=${buckets.overdue.length}, dueSoon=${buckets.dueSoon.length}, upcoming=${buckets.upcoming.length})` : ''}`);
  }

  // Separate overdue items into non-deferred and deferred
  const overdueNonDeferred = buckets.overdue.filter(t => t.source !== "protractor");
  const overdueDeferred = buckets.overdue.filter(t => t.source === "protractor");
  
  const counts = {
    overdue: overdueNonDeferred.length,
    deferred: overdueDeferred.length,
    soon: buckets.dueSoon.length,
    upcoming: buckets.upcoming.length,
  };

  // Cache the assembled plan for future requests (non-blocking)
  // Also re-cache if we rebuilt due to stale deferred work
  if ((!useCachedData || hasDeferredMismatch) && currentMiles != null) {
    const cacheItem = (item: TriagedItem): TriagedItemCache => ({
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
    });
    
    const planData: CachedPlanData = {
      buckets: {
        overdue: buckets.overdue.map(cacheItem),
        dueSoon: buckets.dueSoon.map(cacheItem),
        upcoming: buckets.upcoming.map(cacheItem),
      },
      vehicle: {
        year: vehicleYear ?? null,
        make: vehicleMake ?? null,
        model: vehicleModel ?? null,
        engine: vehicleEngine ?? null,
      },
      currentMiles,
      mpdBlended,
      customerName,
      latestRoNumber,
      distanceUnit,
      soonMiles,
      soonDays,
      showInspectItems,
    };
    
    setCachedPlan(vin, Number(shopId), currentMiles, planData).catch(err => {
      console.error(`[Plan] Failed to cache plan for ${vin}:`, err);
    });
  }

  return (
    <PlanTrialGate vin={vin}>
      <>
      {/* Sticky summary header - no nested overflow wrapper, uses dashboard layout's scroll */}
      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b shadow-sm">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-3">
          {/* Top navigation menu */}
          <nav className="flex items-center gap-4 text-sm text-blue-600 mb-2">
            <Link href="/dashboard" className="hover:underline">← Back</Link>
            <Link href={`/dashboard/vehicles/${vin}?tab=oe`} className="hover:underline">OE</Link>
            <Link href={`/dashboard/vehicles/${vin}?tab=dvi`} className="hover:underline">DVI</Link>
            <Link href={`/dashboard/vehicles/${vin}?tab=carfax`} className="hover:underline">CARFAX</Link>
          </nav>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-3">
              {getOELogoUrl(vehicleMake) && (
                <img 
                  src={getOELogoUrl(vehicleMake)!} 
                  alt={vehicleMake || ""} 
                  className="h-10 sm:h-12 object-contain flex-shrink-0" 
                />
              )}
              <div>
                <h1 className="text-xl sm:text-2xl font-bold truncate">
                  {[vehicleYear, vehicleMake, vehicleModel].filter(Boolean).join(" ") || "Vehicle"}
                </h1>
                <div className="text-sm text-neutral-600">
                  {customerName && <><span className="font-medium text-neutral-800">{customerName}</span> • </>}
                  {latestRoNumber && <>RO# <code className="font-medium">{latestRoNumber}</code> • </>}
                  VIN <code>{vin}</code>
                  {currentMiles != null && currentMiles > 0 && <> • Current: {fmtDistance(currentMiles, distanceUnit)} {distLabel}</>}
                  {mpdBlended != null && <> • ~{(distanceUnit === "kilometers" ? mpdBlended * MILES_TO_KM : mpdBlended).toFixed(1)} {distLabel}/day</>}
                </div>
              </div>
            </div>
            
            {/* Health Intelligence branding - moved to right */}
            <div className="hidden sm:flex items-center gap-3">
              <img src="/icons/vehicle-health-intelligence.png?v=4" alt="" className="w-14 h-14" />
              <div className="text-lg font-semibold text-blue-800">Vehicle Health Intelligence<sup className="text-xs">™</sup></div>
            </div>

            <div className="flex items-center gap-3">
              <PrintButton />
              <nav className="flex items-center gap-2 text-xs sm:text-sm print:hidden">
                {showRecalls && (
                  <a href="#recalls" className={`rounded-full px-3 py-1 ${recallCount > 0 ? 'bg-red-700' : 'bg-green-600'} text-white`}>
                    {recallCount > 0 ? `Recalls ${recallCount}` : '✓ No Recalls'}
                  </a>
                )}
                <a href="#overdue" className="rounded-full px-3 py-1 bg-red-600 text-white">
                  Overdue {counts.overdue}
                </a>
                {counts.deferred > 0 && (
                  <a href="#deferred" className="inline-flex items-center gap-1 rounded-full px-3 py-1 bg-blue-600 text-white">
                    <img src="/protractor-icon.png" alt="" className="w-3.5 h-3.5 rounded-full" />
                    Deferred {counts.deferred}
                  </a>
                )}
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
      <div className="hidden print:block mb-6 border-b pb-4 mx-auto max-w-5xl px-4 sm:px-6">
        <div className="flex items-center justify-between">
          {shopLogo ? (
            <img src={shopLogo} alt="Shop Logo" className="h-12" />
          ) : (
            <div className="flex items-center gap-2">
              {getOELogoUrl(vehicleMake) && (
                <img src={getOELogoUrl(vehicleMake)!} alt={vehicleMake || ""} className="h-10" />
              )}
              <span className="text-lg font-bold text-neutral-800">
                {[vehicleYear, vehicleMake, vehicleModel].filter(Boolean).join(" ") || "Vehicle"}
              </span>
            </div>
          )}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1 bg-blue-50 rounded-lg border border-blue-100">
              <img src="/icons/vehicle-health-intelligence.png?v=3" alt="" className="w-6 h-6" />
              <span className="text-sm font-semibold text-blue-800">Vehicle Health Intelligence</span>
            </div>
            <div className="text-right text-sm text-neutral-600">
              <div>Report Date: {new Date().toLocaleDateString()}</div>
            </div>
          </div>
        </div>
        <div className="mt-4">
          <h1 className="text-2xl font-bold flex items-center gap-3">
            {getOELogoUrl(vehicleMake) && (
              <img src={getOELogoUrl(vehicleMake)!} alt={vehicleMake || ""} className="h-10" />
            )}
            {[vehicleYear, vehicleMake, vehicleModel].filter(Boolean).join(" ") || "Vehicle"}
          </h1>
          <div className="text-sm text-neutral-600 mt-1">
            VIN: {vin}
            {currentMiles != null && currentMiles > 0 && <> • Current: {fmtDistance(currentMiles, distanceUnit)} {distLabel}</>}
          </div>
        </div>
      </div>

      {/* Buckets (single column for easy scanning) */}
      <div className="mx-auto max-w-5xl px-4 sm:px-6 space-y-8">
        {/* NHTSA Recalls Section - Conditionally shown based on shop preferences */}
        {showRecalls && (
          <section id="recalls" className="space-y-3">
            <details open={recallsExpanded} className="group">
              <summary className="text-lg font-semibold text-neutral-700 flex items-center gap-2 cursor-pointer list-none">
                <span className="text-xl">🚨</span> NHTSA Recalls ({recallCount})
                <svg className="w-4 h-4 ml-auto transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </summary>
              <div className="mt-3">
                {recallCount === 0 ? (
                  <div className="rounded-xl border border-green-200 bg-green-50 p-4">
                    <div className="flex items-center gap-2 text-green-700">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="font-medium">No open recalls for this vehicle</span>
                    </div>
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {recalls.map((recall) => (
                      <li 
                        key={recall.nhtsa_recall_id} 
                        className={`rounded-xl border-2 p-4 ${
                          recall.isSafetyCritical 
                            ? 'border-red-500 bg-red-50' 
                            : 'border-amber-400 bg-amber-50'
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`text-sm font-bold px-2 py-0.5 rounded ${
                                recall.isSafetyCritical 
                                  ? 'bg-red-600 text-white' 
                                  : 'bg-amber-500 text-white'
                              }`}>
                                {recall.isSafetyCritical ? '⚠️ SAFETY' : 'RECALL'}
                              </span>
                              <code className="text-sm font-mono bg-white/50 px-2 py-0.5 rounded">
                                {recall.nhtsa_campaign_number}
                              </code>
                              <span className="text-sm text-neutral-600">{recall.component_description}</span>
                            </div>
                            
                            {recall.consequence_summary && (
                              <div className="mt-2">
                                <span className="text-xs font-semibold text-red-700 uppercase">Risk: </span>
                                <span className="text-sm text-neutral-700">{recall.consequence_summary}</span>
                              </div>
                            )}
                            
                            {recall.corrective_action_summary && (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-sm text-blue-600 hover:underline">
                                  View fix details
                                </summary>
                                <div className="mt-1 text-sm text-neutral-600 bg-white/50 p-2 rounded">
                                  <span className="font-semibold">Fix: </span>
                                  {recall.corrective_action_summary}
                                </div>
                              </details>
                            )}
                            
                            {recall.potential_units_affected && recall.potential_units_affected > 0 && (
                              <div className="mt-2 text-xs text-neutral-500">
                                {recall.potential_units_affected.toLocaleString()} vehicles affected
                                {recall.record_creation_date && ` • Issued ${new Date(recall.record_creation_date).toLocaleDateString()}`}
                              </div>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          </section>
        )}

        {/* Overdue (non-deferred) */}
        <section id="overdue" className="space-y-3">
          <h2 className="text-lg font-semibold text-red-700 flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-600" /> Overdue ({counts.overdue})
          </h2>
          {overdueNonDeferred.length === 0 ? (
            <div className="text-sm text-neutral-500">Nothing overdue 🎉</div>
          ) : (
            <ul className="space-y-3">
              {overdueNonDeferred.map((t) => (
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
                          repairOrderId={latestRepairOrderId ?? undefined}
                          cannedJobOptions={opts}
                          integration={activeIntegration ?? "protractor"}
                          showHistoryButton={hasJobLookupFeature}
                          protractorDeferredId={t.protractorDeferredId}
                          matchedDeferred={t.matchedDeferred}
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

        {/* Deferred (from Protractor) */}
        {overdueDeferred.length > 0 && (
          <section id="deferred" className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-blue-700 flex items-center gap-2">
                <img src={shopLogo || "/protractor-icon.png"} alt="" className="w-5 h-5 rounded-full object-cover" />
                Deferred ({counts.deferred})
              </h2>
              {latestWorkOrderId && activeIntegration === "protractor" && (
                <AddAllDeferredButton 
                  items={overdueDeferred}
                  workOrderGuid={latestWorkOrderId}
                  vin={vin}
                />
              )}
            </div>
            <ul className="space-y-3">
              {overdueDeferred.map((t) => (
                <li key={t.key} className="rounded-xl border border-blue-200 bg-blue-50/30 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium">{t.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
                        {t.category && <span className="rounded-full bg-neutral-100 px-2 py-0.5">{t.category}</span>}
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 border border-blue-300 px-2 py-0.5">
                          <img src={shopLogo || "/protractor-icon.png"} alt="" className="w-3.5 h-3.5 rounded-full object-cover" />
                          <span className="text-blue-700">Deferred</span>
                        </span>
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
                          repairOrderId={latestRepairOrderId ?? undefined}
                          cannedJobOptions={opts}
                          integration={activeIntegration ?? "protractor"}
                          showHistoryButton={hasJobLookupFeature}
                          protractorDeferredId={t.protractorDeferredId}
                          matchedDeferred={t.matchedDeferred}
                        />
                      );
                    })()}
                  </div>
                  {t.reason && (
                    <div className="text-xs text-blue-700 mt-2 bg-blue-50 rounded px-2 py-1">
                      {t.reason}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

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
                          repairOrderId={latestRepairOrderId ?? undefined}
                          cannedJobOptions={opts}
                          integration={activeIntegration ?? "protractor"}
                          showHistoryButton={hasJobLookupFeature}
                          protractorDeferredId={t.protractorDeferredId}
                          matchedDeferred={t.matchedDeferred}
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
                          repairOrderId={latestRepairOrderId ?? undefined}
                          cannedJobOptions={opts}
                          integration={activeIntegration ?? "protractor"}
                          showHistoryButton={hasJobLookupFeature}
                          protractorDeferredId={t.protractorDeferredId}
                          matchedDeferred={t.matchedDeferred}
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
      </>
    </PlanTrialGate>
  );
}
