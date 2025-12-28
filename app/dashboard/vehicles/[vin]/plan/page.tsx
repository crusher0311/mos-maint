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
import { PlanTrialGate } from "@/components/ui/PlanTrialGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------------- small utils ---------------- */
function fmtMiles(m?: number | null) {
  if (m === 0) return "0";
  if (m == null) return "";
  return m.toLocaleString();
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

const SERVICE_KEYS: Record<string, string[]> = {
  oil: ["oil and filter", "engine oil", "oil change", "replace engine oil and filter"],
  tire_rotation: ["rotate tires", "tire rotation", "rotate tyre", "tires rotated"],
  brake_fluid: ["brake fluid", "brake flush"],
  coolant: ["engine coolant", "coolant flush", "replace coolant", "cooling system"],
  trans_fluid: ["automatic transmission fluid", "transmission fluid", "transmission flush", "transfer case fluid"],
  engine_air: ["engine air filter", "air filter"],
  cabin_air: ["cabin air filter", "pollen filter"],
  spark_plugs: ["spark plugs", "spark plug(s)", "spark plug "],
  inspect_brakes: ["inspect brake pads", "inspect brake", "inspect brake hoses", "parking brake", "brake pads replaced", "brake rotor"],
  multi_point: ["multi-point inspection", "multi point inspection"],
  battery: ["battery replaced", "battery/charging"],
  alignment: ["wheel alignment", "four wheel alignment"],
  steering: ["rack and pinion", "tie rod", "steering"],
  suspension: ["strut(s) replaced", "struts replaced", "suspension"],
};

function toKeyFromName(name: string): string | null {
  const n = name.toLowerCase();
  for (const [key, vals] of Object.entries(SERVICE_KEYS)) {
    if (vals.some((v) => n.includes(v))) return key;
  }
  if (n.includes("exhaust system")) return "exhaust";
  if (n.includes("steering") || n.includes("suspension")) return "steer_susp";
  if (n.includes("automatic transmission fluid")) return "trans_fluid";
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

function triage({
  oemItems,
  carfaxRecords,
  currentMiles,
  today = new Date(),
  dviFindings,
  protractorDeferredWork = [],
  declinedServices = [],
  soonMiles = DEFAULT_SOON_MILES,
  soonDays = DEFAULT_SOON_DAYS,
  milesPerDay = null,
  shopIntervals = {},
}: {
  oemItems: OEMItem[];
  carfaxRecords: Array<{ date?: string; odometer?: number; description?: string }>;
  currentMiles: number | null;
  today?: Date;
  dviFindings: Array<{ name?: string; status?: string | number; source?: string }>;
  protractorDeferredWork?: ProtractorDeferredWork[];
  declinedServices?: DeclinedServiceEntry[];
  soonMiles?: number;
  soonDays?: number;
  milesPerDay?: number | null;
  shopIntervals?: Record<string, ShopIntervalOverride>;
}): Buckets {
  // Enrich CARFAX records with interpolated mileage for gaps
  const enrichedRecords = fillCarfaxMileageGaps(carfaxRecords || [], {
    today,
    currentMiles,
    defaultRate: milesPerDay,
  });

  // last-done map from CARFAX (now with interpolated mileage)
  const lastMap = new Map<string, LastDone>();
  for (const r of enrichedRecords) {
    const date = r.date;
    const miles = r.miles;
    
    const desc = String(r.description || "").trim();
    const keys = toKeyFromFreeText(desc);
    for (const k of keys) {
      const prev = lastMap.get(k);
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

  for (const o of oemItems) {
    const serviceKey = toKeyFromName(o.name || "") || `misc_${o.maintenance_id}`;
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

  // sort within buckets
  overdue.sort((a, b) => {
    const aBehind = (a.milesToGo ?? 0) < 0 ? -(a.milesToGo ?? 0) : 0;
    const bBehind = (b.milesToGo ?? 0) < 0 ? -(b.milesToGo ?? 0) : 0;
    return bBehind - aBehind; // most overdue first
  });
  dueSoon.sort((a, b) => {
    const aLeft = a.milesToGo ?? Infinity;
    const bLeft = b.milesToGo ?? Infinity;
    return aLeft - bLeft; // closest first
  });
  upcoming.sort((a, b) => {
    const aNext = a.dueAtMiles ?? Number.POSITIVE_INFINITY;
    const bNext = b.dueAtMiles ?? Number.POSITIVE_INFINITY;
    return aNext - bNext;
  });

  return { overdue, dueSoon, upcoming };
}

/* ---------------- Page ---------------- */
type PageProps = { params: Promise<{ vin: string }> };

export default async function VehiclePlanPage({ params }: PageProps) {
  const session = await requireSession();
  const db = await getDb();
  const shopId = Number(session.shopId);

  const { vin: vinParam } = await params;
  const vin = String(vinParam || "").toUpperCase();

  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { maintenance: 1, protractor: 1 } }
  );
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

  // PARALLEL DATA FETCHING - fetch external data simultaneously
  const [dvi, carfax, protractorVehicleResult, avInspectionResult] = await Promise.all([
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
      : Promise.resolve({ ok: false } as { ok: false })
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

  const buckets = triage({
    oemItems,
    carfaxRecords,
    currentMiles,
    dviFindings,
    protractorDeferredWork,
    declinedServices,
    soonMiles,
    soonDays,
    milesPerDay: mpdBlended,
    shopIntervals,
  });

  console.log(`[Plan Debug] Thresholds: soonMiles=${soonMiles}, soonDays=${soonDays}`);
  console.log(`[Plan Debug] Buckets: overdue=${buckets.overdue.length}, dueSoon=${buckets.dueSoon.length}, upcoming=${buckets.upcoming.length}`);

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
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-neutral-600">
              <Link href={`/dashboard/vehicles/${vin}`} className="underline">
                ← Back
              </Link>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold truncate">
              {(vehicle ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") : "Vehicle")} — Plan
            </h1>
            <div className="text-sm text-neutral-600">
              VIN <code>{vin}</code>
              {currentMiles != null && currentMiles > 0 && <> • Current: {fmtMiles(currentMiles)} mi</>}
              {mpdBlended != null && <> • ~{mpdBlended.toFixed(1)} mi/day</>}
            </div>
          </div>

          <nav className="flex items-center gap-2 text-xs sm:text-sm">
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
                            OEM: {t.intervalMiles ? `${fmtMiles(t.intervalMiles)} mi` : ""}
                            {t.intervalMiles && t.intervalMonths ? " / " : ""}
                            {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                          </span>
                        )}
                        {t.bump === "red" && t.source !== "protractor" && (
                          <span className={`rounded-full text-white px-2 py-0.5 ${t.dviSource === "autovitals" ? "bg-teal-600" : "bg-red-600"}`}>
                            {t.dviSource === "autovitals" ? "AutoVitals 🔴" : "DVI 🔴"}
                          </span>
                        )}
                        {t.source === "protractor" && <span className="rounded-full bg-purple-600 text-white px-2 py-0.5">Protractor</span>}
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
                      return opts.length > 0 ? (
                        <AddToROButton
                          vin={vin}
                          serviceKey={t.serviceKey}
                          cannedJobOptions={opts}
                          workOrderId={latestRoNumber ?? undefined}
                        />
                      ) : null;
                    })()}
                  </div>

                  <div className="text-sm mt-2">
                    {t.dueAtMiles != null && (
                      <>
                        Due at <strong>{fmtMiles(t.dueAtMiles)}</strong> mi
                        {t.milesToGo != null && ` • ${fmtMiles(Math.abs(t.milesToGo))} mi overdue`}
                      </>
                    )}
                    {t.dueAtMiles != null && t.dueAtDate != null && <> • </>}
                    {t.dueAtDate != null && (
                      <>
                        By <strong>{t.dueAtDate.toLocaleDateString()}</strong>
                      </>
                    )}
                  </div>

                  {t.last?.miles != null && (
                    <div className="text-xs text-neutral-600 mt-1 flex items-center gap-1.5">
                      <span>Last done at {fmtMiles(t.last.miles)} mi{t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}</span>
                      {t.last?.source === "carfax" && (
                        <img src="/badges/carfax.png" alt="CARFAX" className="h-3.5" title="From CARFAX" />
                      )}
                      {t.last?.source === "protractor" && (
                        <img src="/badges/protractor.png" alt="Protractor" className="h-4" title="From Protractor" />
                      )}
                    </div>
                  )}

                  {t.declined && (
                    <div className="text-xs text-orange-700 mt-1 bg-orange-50 rounded px-2 py-1">
                      Declined on {new Date(t.declined.declinedAt).toLocaleDateString()}
                      {t.declined.mileage && ` at ${fmtMiles(t.declined.mileage)} mi`}
                      {t.declined.reason && ` - ${t.declined.reason}`}
                    </div>
                  )}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Why this is recommended</summary>
                    <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-700 space-y-1">
                      <div>
                        <span className="font-medium">{t.usingShopInterval ? "Shop" : "OEM"} Interval:</span>{" "}
                        {t.intervalMiles ? `${fmtMiles(t.intervalMiles)} mi` : "—"}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </div>
                      <div>
                        <span className="font-medium inline-flex items-center gap-1">
                          Last done
                          {t.last?.source === "carfax" && <img src="/badges/carfax.png" alt="CARFAX" className="h-3 inline" />}
                          {t.last?.source === "protractor" && <img src="/badges/protractor.png" alt="Protractor" className="h-3.5 inline" />}
                          :
                        </span>{" "}
                        {t.last?.miles != null ? `${fmtMiles(t.last.miles)} mi` : "—"}
                        {t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                      </div>
                      <div>
                        <span className="font-medium">Next due:</span>{" "}
                        {t.dueAtMiles != null ? `${fmtMiles(t.dueAtMiles)} mi` : "—"}
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
                        OEM: {t.intervalMiles ? `${fmtMiles(t.intervalMiles)} mi` : ""}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </span>
                    )}
                    {t.bump === "yellow" && t.source !== "protractor" && (
                      <span className={`rounded-full text-white px-2 py-0.5 ${t.dviSource === "autovitals" ? "bg-teal-600" : "bg-amber-600"}`}>
                        {t.dviSource === "autovitals" ? "AutoVitals 🟡" : "DVI 🟡"}
                      </span>
                    )}
                    {t.source === "protractor" && <span className="rounded-full bg-purple-600 text-white px-2 py-0.5">Protractor</span>}
                    {t.usingShopInterval && <span className="rounded-full bg-green-600 text-white px-2 py-0.5">Shop</span>}
                    {t.declined && (
                      <span className="rounded-full bg-orange-100 text-orange-700 border border-orange-300 px-2 py-0.5 font-medium">
                        Previously declined
                      </span>
                    )}
                    {(() => {
                      const opts = getCannedJobOptionsForService(t.serviceKey);
                      return opts.length > 0 ? (
                        <AddToROButton
                          vin={vin}
                          serviceKey={t.serviceKey}
                          cannedJobOptions={opts}
                          workOrderId={latestRoNumber ?? undefined}
                        />
                      ) : null;
                    })()}
                  </div>

                  <div className="text-sm mt-2">
                    {t.source === "protractor" && t.reason && (
                      <div className="text-neutral-600">{t.reason}</div>
                    )}
                    {t.milesToGo != null && t.milesToGo > 0 && (
                      <>
                        In ~<strong>{fmtMiles(t.milesToGo)}</strong> mi
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
                      <span>Last done at {fmtMiles(t.last.miles)} mi{t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}</span>
                      {t.last?.source === "carfax" && (
                        <img src="/badges/carfax.png" alt="CARFAX" className="h-3.5" title="From CARFAX" />
                      )}
                      {t.last?.source === "protractor" && (
                        <img src="/badges/protractor.png" alt="Protractor" className="h-4" title="From Protractor" />
                      )}
                    </div>
                  )}

                  {t.declined && (
                    <div className="text-xs text-orange-700 mt-1 bg-orange-50 rounded px-2 py-1">
                      Declined on {new Date(t.declined.declinedAt).toLocaleDateString()}
                      {t.declined.mileage && ` at ${fmtMiles(t.declined.mileage)} mi`}
                      {t.declined.reason && ` - ${t.declined.reason}`}
                    </div>
                  )}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Why this is recommended</summary>
                    <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-700 space-y-1">
                      <div>
                        <span className="font-medium">{t.usingShopInterval ? "Shop" : "OEM"} Interval:</span>{" "}
                        {t.intervalMiles ? `${fmtMiles(t.intervalMiles)} mi` : "—"}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </div>
                      <div>
                        <span className="font-medium inline-flex items-center gap-1">
                          Last done
                          {t.last?.source === "carfax" && <img src="/badges/carfax.png" alt="CARFAX" className="h-3 inline" />}
                          {t.last?.source === "protractor" && <img src="/badges/protractor.png" alt="Protractor" className="h-3.5 inline" />}
                          :
                        </span>{" "}
                        {t.last?.miles != null ? `${fmtMiles(t.last.miles)} mi` : "—"}
                        {t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                      </div>
                      <div>
                        <span className="font-medium">Next due:</span>{" "}
                        {t.dueAtMiles != null ? `${fmtMiles(t.dueAtMiles)} mi` : "—"}
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
                        OEM: {t.intervalMiles ? `${fmtMiles(t.intervalMiles)} mi` : ""}
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
                      return opts.length > 0 ? (
                        <AddToROButton
                          vin={vin}
                          serviceKey={t.serviceKey}
                          cannedJobOptions={opts}
                          workOrderId={latestRoNumber ?? undefined}
                        />
                      ) : null;
                    })()}
                  </div>

                  <div className="text-sm mt-2">
                    {t.dueAtMiles != null && (
                      <>
                        Next at ~<strong>{fmtMiles(t.dueAtMiles)}</strong> mi
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
                      {t.declined.mileage && ` at ${fmtMiles(t.declined.mileage)} mi`}
                      {t.declined.reason && ` - ${t.declined.reason}`}
                    </div>
                  )}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Show details</summary>
                    <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-700 space-y-1">
                      <div>
                        <span className="font-medium">{t.usingShopInterval ? "Shop" : "OEM"} Interval:</span>{" "}
                        {t.intervalMiles ? `${fmtMiles(t.intervalMiles)} mi` : "—"}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </div>
                      {t.last?.miles != null && (
                        <div>
                          <span className="font-medium">Last done (CARFAX):</span>{" "}
                          {fmtMiles(t.last.miles)} mi{t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
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
