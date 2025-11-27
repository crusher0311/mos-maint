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
import { getMaintenanceSchedule } from "@/lib/integrations/dataone-api";

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

  // Vehicle-level odometer/lastMileage
  const veh = await db.collection("vehicles").findOne({ vin }, { projection: { odometer: 1, lastMileage: 1 } });
  const mVeh = toPos(veh?.odometer) ?? toPos(veh?.lastMileage);

  // Return the highest valid mileage
  const candidates = [mRO, mAF, mVeh].filter((x): x is number => x != null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/* ---------------- Local OEM schedule (Mongo) ---------------- */
async function getLocalOeFromMongo(vin: string) {
  const db = await getDb();
  const SQUISH = toSquish(vin);

  const pipeline = [
    { $match: { squish: SQUISH } },
    { $project: { _id: 0, squish: 1, vin_maintenance_id: 1, maintenance_id: 1 } },
    { $limit: 200 },
    {
      $lookup: {
        from: "dataone_lkp_maintenance_interval",
        localField: "maintenance_id",
        foreignField: "maintenance_id",
        as: "intervals",
      },
    },
    { $unwind: "$intervals" },
    {
      $lookup: {
        from: "dataone_lkp_maintenance",
        localField: "maintenance_id", 
        foreignField: "maintenance_id",
        as: "maintenance",
      },
    },
    { $unwind: "$maintenance" },
    {
      $group: {
        _id: { maintenance_id: "$maintenance_id" },
        maintenance_name: { $first: "$maintenance.maintenance_name" },
        maintenance_category: { $first: "$maintenance.maintenance_category" },
        maintenance_notes: { $first: "$maintenance.maintenance_notes" },
        intervals: {
          $push: {
            interval_id: "$intervals.interval_id",
            type: "$intervals.interval_type",
            value: "$intervals.value",
            units: "$intervals.units",
            initial_value: "$intervals.initial_value",
          },
        },
      },
    },
    {
      $addFields: {
        miles: {
          $let: {
            vars: { m: { $filter: { input: "$intervals", as: "i", cond: { $eq: ["$$i.units", "Miles"] } } } },
            in: {
              $cond: [
                { $gt: [{ $size: "$$m" }, 0] },
                { $arrayElemAt: [{ $map: { input: "$$m", as: "x", in: "$$x.value" } }, 0] },
                null,
              ],
            },
          },
        },
        months: {
          $let: {
            vars: { m: { $filter: { input: "$intervals", as: "i", cond: { $eq: ["$$i.units", "Months"] } } } },
            in: {
              $cond: [
                { $gt: [{ $size: "$$m" }, 0] },
                { $arrayElemAt: [{ $map: { input: "$$m", as: "x", in: "$$x.value" } }, 0] },
                null,
              ],
            },
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        maintenance_id: "$_id.maintenance_id",
        name: "$maintenance_name",
        category: "$maintenance_category",
        notes: "$maintenance_notes",
        miles: 1,
        months: 1,
        intervals: 1,
      },
    },
    { $sort: { category: 1, name: 1 } },
    { $limit: 200 },
  ];

  const items = await db
    .collection("dataone_lkp_vin_maintenance")
    .aggregate(pipeline, { allowDiskUse: true, hint: "squish_1" })
    .toArray();

  return { ok: true as const, vin, squish: SQUISH, count: items.length, items };
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
type LastDone = { miles?: number | null; date?: Date | null };

const SERVICE_KEYS: Record<string, string[]> = {
  oil: ["oil and filter", "engine oil", "oil change", "replace engine oil and filter"],
  tire_rotation: ["rotate tires", "tire rotation", "rotate tyre"],
  brake_fluid: ["brake fluid", "brake flush"],
  coolant: ["engine coolant", "coolant flush", "replace coolant"],
  trans_fluid: ["automatic transmission fluid", "transmission fluid", "transmission flush"],
  engine_air: ["engine air filter", "air filter"],
  cabin_air: ["cabin air filter", "pollen filter"],
  spark_plugs: ["spark plugs"],
  inspect_brakes: ["inspect brake pads", "inspect brake", "inspect brake hoses", "parking brake"],
  multi_point: ["multi-point inspection", "multi point inspection"],
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

type TriagedItem = {
  key: string;
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
};

type Buckets = { overdue: TriagedItem[]; dueSoon: TriagedItem[]; upcoming: TriagedItem[] };

function triage({
  oemItems,
  carfaxRecords,
  currentMiles,
  today = new Date(),
  dviFindings,
}: {
  oemItems: OEMItem[];
  carfaxRecords: Array<{ date?: string; odometer?: number; description?: string }>;
  currentMiles: number | null;
  today?: Date;
  dviFindings: Array<{ name?: string; status?: string | number }>;
}): Buckets {
  // last-done map from CARFAX
  const lastMap = new Map<string, LastDone>();
  for (const r of carfaxRecords || []) {
    const date = parseCarfaxDate(r.date ?? null);
    const miles = typeof r.odometer === "number" ? r.odometer : null;
    const desc = String(r.description || "").trim();
    const keys = toKeyFromFreeText(desc);
    for (const k of keys) {
      const prev = lastMap.get(k);
      const cand: LastDone = { miles, date };
      const prevScore = prev?.date ? prev.date.getTime() : -Infinity;
      const candScore = date ? date.getTime() : -Infinity;
      if (!prev || candScore > prevScore) lastMap.set(k, cand);
    }
  }

  // DVI bumps
  const dviMap = new Map<string, "red" | "yellow">();
  for (const it of dviFindings || []) {
    const key = it?.name ? toKeyFromName(String(it.name)) : null;
    if (!key) continue;
    const s = String(it.status ?? "");
    if (s === "0") dviMap.set(key, "red");
    else if (s === "1" && dviMap.get(key) !== "red") dviMap.set(key, "yellow");
  }

  const triaged: TriagedItem[] = [];

  for (const o of oemItems) {
    const key = toKeyFromName(o.name || "") || `misc_${o.maintenance_id}`;
    const last = lastMap.get(key) ?? null;
    const intervalMiles = o.miles ?? null;
    const intervalMonths = o.months ?? null;

    let dueAtMiles: number | null = null;
    let dueAtDate: Date | null = null;

    // Miles-based next due
    if (intervalMiles && intervalMiles > 0) {
      if (last?.miles != null) {
        dueAtMiles = last.miles + intervalMiles;
      } else if (currentMiles != null) {
        // align to next interval bucket if no history
        dueAtMiles = Math.ceil(currentMiles / intervalMiles) * intervalMiles;
      }
    }

    // Time-based next due
    if (intervalMonths && intervalMonths > 0) {
      if (last?.date) dueAtDate = addMonths(last.date, intervalMonths);
      else dueAtDate = addMonths(today, 0 + intervalMonths);
    }

    const milesToGo = currentMiles != null && dueAtMiles != null ? dueAtMiles - currentMiles : null;

    const daysToGo =
      dueAtDate != null ? Math.ceil((dueAtDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null;

    triaged.push({
      key,
      title: o.name,
      category: o.category,
      intervalMiles,
      intervalMonths,
      last: last || undefined,
      dueAtMiles,
      dueAtDate,
      milesToGo,
      daysToGo,
      bump: dviMap.get(key) ?? null,
    });
  }

  // thresholds
  const SOON_MILES = 1000;
  const SOON_DAYS = 30;

  const overdue: TriagedItem[] = [];
  const dueSoon: TriagedItem[] = [];
  const upcoming: TriagedItem[] = [];

  for (const t of triaged) {
    const mOver = t.milesToGo != null && t.milesToGo <= 0;
    const dOver = t.daysToGo != null && t.daysToGo <= 0;
    const mSoon = t.milesToGo != null && t.milesToGo > 0 && t.milesToGo <= SOON_MILES;
    const dSoon = t.daysToGo != null && t.daysToGo > 0 && t.daysToGo <= SOON_DAYS;

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

  const vehicle = await db.collection("vehicles").findOne(
    { shopId, vin },
    { projection: { year: 1, make: 1, model: 1, vin: 1, lastMileage: 1, customerId: 1, updatedAt: 1 } }
  );

  // RO & DVI - also check events collection for RO data
  let ros = await db
    .collection("repair_orders")
    .find({ shopId, $or: [{ vin }, { vehicleId: vehicle?._id }] })
    .project({ roNumber: 1, status: 1, mileage: 1, updatedAt: 1, createdAt: 1 })
    .sort({ updatedAt: -1, createdAt: -1 })
    .toArray();
  
  // If no ROs in repair_orders, check events collection (AutoFlow webhook data)
  if (ros.length === 0) {
    const eventRos = await db.collection("events").aggregate([
      { $match: { 
        $expr: { 
          $eq: [{ $toUpper: { $ifNull: ["$vehicleVin", { $ifNull: ["$vin", "$payload.vehicle.vin"] }] } }, vin] 
        }
      }},
      { $sort: { createdAt: -1 } },
      { $limit: 10 },
      { $project: { 
        roNumber: { $ifNull: ["$payload.ticket.invoice", "$payload.invoice"] },
        mileage: { $ifNull: ["$payload.ticket.mileage", "$payload.vehicle.mileage"] },
        updatedAt: "$createdAt"
      }}
    ]).toArray();
    ros = eventRos.filter((r: any) => r.roNumber);
  }
  
  console.log(`[Plan Debug] ROs found: ${ros.length}, first few:`, ros.slice(0, 5).map((r: any) => r.roNumber));

  const autoCfg = await resolveAutoflowConfig(shopId);
  
  // Try to find the RO with DVI data - check recent ROs until we find one with categories
  let dvi: any = { ok: false, error: "No DVI found" };
  let usedRoNumber: string | null = null;
  
  if (autoCfg.configured && ros.length > 0) {
    // Helper to check if DVI has actionable items (red/yellow status)
    const hasActionableItems = (testDvi: any) => {
      if (!testDvi?.ok || !Array.isArray(testDvi?.categories)) return false;
      for (const cat of testDvi.categories) {
        if (!Array.isArray(cat?.items)) continue;
        for (const item of cat.items) {
          const status = String(item?.status ?? "");
          if (status === "0" || status === "1") return true; // red or yellow
        }
      }
      return false;
    };
    
    // Check up to 10 most recent ROs to find one with actionable DVI items
    let bestDvi: any = null;
    let bestRoNumber: string | null = null;
    
    for (const ro of ros.slice(0, 10)) {
      const roNum = String(ro.roNumber);
      const testDvi = await fetchDviWithCache(shopId, roNum, 1 * 60 * 1000);
      const catCount = (testDvi as any).categories?.length || 0;
      const hasActions = hasActionableItems(testDvi);
      console.log(`[Plan Debug] Checking RO ${roNum}: ok=${(testDvi as any).ok}, categories=${catCount}, hasActionableItems=${hasActions}`);
      
      // Prefer DVI with actionable items (red/yellow)
      if (hasActions) {
        dvi = testDvi;
        usedRoNumber = roNum;
        console.log(`[Plan Debug] Found DVI with actionable items on RO ${roNum}`);
        break;
      }
      
      // Keep first valid DVI as fallback
      if (!bestDvi && (testDvi as any).ok && catCount > 0) {
        bestDvi = testDvi;
        bestRoNumber = roNum;
      }
    }
    
    // Use fallback if no actionable items found
    if (!usedRoNumber && bestDvi) {
      dvi = bestDvi;
      usedRoNumber = bestRoNumber;
      console.log(`[Plan Debug] Using fallback DVI from RO ${usedRoNumber} (no actionable items found)`);
    }
  }
  
  console.log(`[Plan Debug] Using RO ${usedRoNumber} for DVI data`);

  // CARFAX
  const carfaxCfg = await resolveCarfaxConfig(shopId);
  const carfax = carfaxCfg.configured
    ? await fetchCarfaxWithCache(shopId, vin, 7 * 24 * 60 * 60 * 1000)
    : { ok: false, error: "CARFAX not configured." as const };

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

  // Get current miles from all sources (same as detail page)
  const currentMiles = await getLatestMilesForVin(db, vin);

  // OEM schedule - try DataOne API first, fall back to local MongoDB
  let localOe: any = { ok: false, count: 0, items: [], error: "Loading..." };
  try {
    const oemPromise = getMaintenanceSchedule(vin);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Timeout")), 8000)
    );
    
    const oemSchedule = await Promise.race([oemPromise, timeoutPromise]) as any;
    
    if (oemSchedule.ok && oemSchedule.count > 0) {
      // Map DataOne API response to local format
      localOe = {
        ok: oemSchedule.ok,
        count: oemSchedule.count,
        items: (oemSchedule.items || []).map((item: any) => ({
          maintenance_id: item.maintenance_id || 0,
          category: item.maintenance_category || "General",
          name: item.maintenance_name || "Unknown",
          notes: item.maintenance_notes,
          miles: item.miles,
          months: item.months,
        })),
        error: oemSchedule.error,
      };
    } else {
      // Fall back to local MongoDB data
      localOe = await getLocalOeFromMongo(vin);
    }
  } catch (e) {
    console.log("[Plan] DataOne API timeout or error, trying local MongoDB fallback");
    localOe = await getLocalOeFromMongo(vin);
  }

  // Build normalized inputs

  const carfaxRecords: Array<{ date?: string; odometer?: number; description?: string }> =
    (carfax as any).ok && Array.isArray((carfax as any).serviceRecords)
      ? (carfax as any).serviceRecords.map((r: any) => ({
          date: r.date,
          odometer: r.odometer,
          description: String(r.description || ""),
        }))
      : [];

  const dviFindings: Array<{ name?: string; status?: string | number }> =
    (dvi as any).ok && Array.isArray((dvi as any).categories)
      ? (dvi as any).categories.flatMap((c: any) =>
          Array.isArray(c.items) ? c.items.map((it: any) => ({ name: it.name, status: it.status })) : []
        )
      : [];

  const oemItems: OEMItem[] = (localOe.items as any[]).map((x) => ({
    maintenance_id: x.maintenance_id,
    name: x.name,
    category: x.category,
    notes: x.notes,
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

  const buckets = triage({
    oemItems,
    carfaxRecords,
    currentMiles,
    dviFindings,
  });

  console.log(`[Plan Debug] Buckets: overdue=${buckets.overdue.length}, dueSoon=${buckets.dueSoon.length}, upcoming=${buckets.upcoming.length}`);

  const counts = {
    overdue: buckets.overdue.length,
    soon: buckets.dueSoon.length,
    upcoming: buckets.upcoming.length,
  };

  return (
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
                        {t.bump === "red" && <span className="rounded-full bg-red-600 text-white px-2 py-0.5">DVI 🔴</span>}
                      </div>
                    </div>
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
                    <div className="text-xs text-neutral-600 mt-1">
                      Last done at {fmtMiles(t.last.miles)} mi
                      {t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                    </div>
                  )}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Why this is recommended</summary>
                    <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-700 space-y-1">
                      <div>
                        <span className="font-medium">OEM Interval:</span>{" "}
                        {t.intervalMiles ? `${fmtMiles(t.intervalMiles)} mi` : "—"}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </div>
                      <div>
                        <span className="font-medium">Last done (CARFAX):</span>{" "}
                        {t.last?.miles != null ? `${fmtMiles(t.last.miles)} mi` : "—"}
                        {t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                      </div>
                      <div>
                        <span className="font-medium">Next due:</span>{" "}
                        {t.dueAtMiles != null ? `${fmtMiles(t.dueAtMiles)} mi` : "—"}
                        {t.dueAtDate ? ` or ${t.dueAtDate.toLocaleDateString()}` : ""}
                      </div>
                      {t.bump && (
                        <div>
                          <span className="font-medium">DVI:</span> {t.bump === "red" ? "🔴 flagged" : "🟡 caution"}
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
                    {t.bump === "yellow" && (
                      <span className="rounded-full bg-amber-600 text-white px-2 py-0.5">DVI 🟡</span>
                    )}
                  </div>

                  <div className="text-sm mt-2">
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
                    <div className="text-xs text-neutral-600 mt-1">
                      Last done at {fmtMiles(t.last.miles)} mi
                      {t.last?.date ? ` on ${t.last.date.toLocaleDateString()}` : ""}
                    </div>
                  )}

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Why this is recommended</summary>
                    <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-700 space-y-1">
                      <div>
                        <span className="font-medium">OEM Interval:</span>{" "}
                        {t.intervalMiles ? `${fmtMiles(t.intervalMiles)} mi` : "—"}
                        {t.intervalMiles && t.intervalMonths ? " / " : ""}
                        {t.intervalMonths ? `${t.intervalMonths} mo` : ""}
                      </div>
                      <div>
                        <span className="font-medium">Last done (CARFAX):</span>{" "}
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
                        or ~<strong>{t.dueAtDate.toLocaleDateString()}</strong>
                      </>
                    )}
                  </div>

                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs underline">Show details</summary>
                    <div className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-700 space-y-1">
                      <div>
                        <span className="font-medium">OEM Interval:</span>{" "}
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
  );
}
