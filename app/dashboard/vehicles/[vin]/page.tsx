// app/dashboard/vehicles/[vin]/page.tsx
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import Link from "next/link";
import { fetchDviWithCache, resolveAutoflowConfig } from "@/lib/integrations/autoflow";
import { fetchCarfaxWithCache, resolveCarfaxConfig } from "@/lib/integrations/carfax";
import VehicleDetailClient from "./VehicleDetailClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ---------- small utils ---------- */
function fmtMiles(m?: number | null) {
  if (m === 0) return "0";
  if (m == null) return "";
  return m.toLocaleString();
}
function daysBetween(a: Date, b: Date) {
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms / (1000 * 60 * 60 * 24);
}
function parseCarfaxDate(d?: string | null): Date | null {
  if (!d) return null;
  const trimmed = String(d).trim();
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    const yy = Number(m[3]);
    const dt = new Date(yy, mm - 1, dd);
    return isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(trimmed);
  return isNaN(dt.getTime()) ? null : dt;
}
function toSquish(vin: string) {
  const v = String(vin).toUpperCase().trim();
  // DataOne “squish” = 8 VIN chars + 2 after the check digit (skip position 9)
  return v.slice(0, 8) + v.slice(9, 11);
}
function StatusChip({ value }: { value: unknown }) {
  const s = String(value ?? "");
  if (s === "0") return <span className="inline-block">❌</span>;
  if (s === "1") return <span className="inline-block">⚠️</span>;
  if (s === "2") return <span className="inline-block">✅</span>;
  return <>{s || ""}</>;
}

/* ---------- resolve current miles: RO → AutoFlow → vehicle ---------- */
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

  // Latest AF or manual close event with mileage
  const af = await db.collection("events").aggregate([
    {
      $match: {
        $expr: {
          $eq: [
            {
              $toUpper: {
                $ifNull: ["$vehicleVin", { $ifNull: ["$vin", "$payload.vehicle.vin"] }],
              },
            },
            vin,
          ],
        },
        $or: [{ provider: "autoflow" }, { provider: "ui", type: "manual_closed" }],
      },
    },
    {
      $addFields: {
        createdAtDate: {
          $cond: [
            { $eq: [{ $type: "$createdAt" }, "date"] },
            "$createdAt",
            { $dateFromString: { dateString: { $toString: "$createdAt" }, onError: null, onNull: null } },
          ],
        },
      },
    },
    { $sort: { createdAtDate: -1 } },
    { $limit: 1 },
    {
      $project: {
        _id: 0,
        miles: {
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
  ]).next();
  const mAF = toPos(af?.miles);

  // Vehicle-level odometer/lastMileage
  const veh = await db.collection("vehicles").findOne({ vin }, { projection: { odometer: 1, lastMileage: 1 } });
  const mVeh = toPos(veh?.odometer) ?? toPos(veh?.lastMileage);

  return mRO ?? mAF ?? mVeh ?? null;
}

/* ---------- local OEM schedule directly from Mongo (unchanged) ---------- */
async function getLocalOeFromMongo(vin: string) {
  const db = await getDb();
  const SQUISH = toSquish(vin);

  const pipeline = [
    { $match: { squish: SQUISH } },
    { $project: { _id: 0, squish: 1, vin_maintenance_id: 1, maintenance_id: 1 } },

    // join intervals via vin_maintenance_id
    {
      $lookup: {
        from: "dataone_lkp_vin_maintenance_interval",
        let: { vmi: "$vin_maintenance_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$vin_maintenance_id", "$$vmi"] } } },
          { $project: { _id: 0, maintenance_interval_id: 1 } },
        ],
        as: "intervals",
      },
    },
    { $unwind: "$intervals" },

    // interval definitions
    {
      $lookup: {
        from: "dataone_def_maintenance_interval",
        localField: "intervals.maintenance_interval_id",
        foreignField: "maintenance_interval_id",
        as: "intDef",
      },
    },
    { $unwind: "$intDef" },

    // maintenance definitions
    {
      $lookup: {
        from: "dataone_def_maintenance",
        localField: "maintenance_id",
        foreignField: "maintenance_id",
        as: "def",
      },
    },
    { $unwind: "$def" },

    // dedupe per (maintenance_id, interval_id)
    {
      $group: {
        _id: {
          maintenance_id: "$maintenance_id",
          interval_id: "$intervals.maintenance_interval_id",
        },
        squish: { $first: "$squish" },
        maintenance_name: { $first: "$def.maintenance_name" },
        maintenance_category: { $first: "$def.maintenance_category" },
        maintenance_notes: { $first: "$def.maintenance_notes" },
        interval_type: { $first: "$intDef.interval_type" },
        value: { $first: "$intDef.value" },
        units: { $first: "$intDef.units" },
        initial_value: { $first: "$intDef.initial_value" },
      },
    },

    // roll up one doc per maintenance_id
    {
      $group: {
        _id: "$_id.maintenance_id",
        squish: { $first: "$squish" },
        maintenance_name: { $first: "$maintenance_name" },
        maintenance_category: { $first: "$maintenance_category" },
        maintenance_notes: { $first: "$maintenance_notes" },
        intervals: {
          $push: {
            interval_id: "$_id.interval_id",
            type: "$interval_type",
            value: "$value",
            units: "$units",
            initial_value: "$initial_value",
          },
        },
      },
    },

    // extract first Miles/Months into columns
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
        maintenance_id: "$_id",
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

/* ---------- page ---------- */
type PageProps = { params: Promise<{ vin: string }> };

export default async function VehicleDetailPage({ params }: PageProps) {
  const session = await requireSession();
  const db = await getDb();
  const shopId = Number(session.shopId);

  const { vin: vinParam } = await params;
  const vin = String(vinParam || "").toUpperCase();

  const vehicle = await db.collection("vehicles").findOne(
    { shopId, vin },
    {
      projection: {
        year: 1,
        make: 1,
        model: 1,
        vin: 1,
        license: 1,
        lastMileage: 1,
        odometer: 1,
        updatedAt: 1,
        customerId: 1,
      },
    }
  );

  if (!vehicle) {
    return (
      <main className="mx-auto max-w-5xl p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Vehicle</h1>
          <Link href="/dashboard/customers" className="text-sm underline">
            ← Back to Customers
          </Link>
        </div>
        <p className="text-sm">
          No vehicle found for VIN <code>{vin}</code>.
        </p>
      </main>
    );
  }

  // ✅ Resolve current miles (used in header and to patch the latest RO row if it's 0)
  const resolvedMiles = await getLatestMilesForVin(db, vin);

  const customer = vehicle.customerId
    ? await db.collection("customers").findOne(
        { _id: vehicle.customerId },
        { projection: { firstName: 1, lastName: 1, name: 1, email: 1, phone: 1 } }
      )
    : null;

  const ownerName =
    [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim() || (customer?.name || "");

  const ros = await db
    .collection("repair_orders")
    .find({ shopId, $or: [{ vehicleId: vehicle._id }, { vin }] })
    .project({ roNumber: 1, status: 1, mileage: 1, updatedAt: 1, createdAt: 1 })
    .sort({ updatedAt: -1, createdAt: -1 })
    .toArray();

  const latestRoNumber = ros[0]?.roNumber ?? null;

  // Autoflow
  const cfg = await resolveAutoflowConfig(shopId);
  const dvi =
    latestRoNumber && cfg.configured
      ? await fetchDviWithCache(shopId, String(latestRoNumber), 10 * 60 * 1000)
      : latestRoNumber
      ? { ok: false, error: "AutoFlow not connected." as const }
      : { ok: false, error: "No RO found for this vehicle." as const };

  // CARFAX
  const carfaxCfg = await resolveCarfaxConfig(shopId);
  const carfax = carfaxCfg.configured
    ? await fetchCarfaxWithCache(shopId, vin, 7 * 24 * 60 * 60 * 1000)
    : { ok: false, error: "CARFAX not configured." as const };

  // Miles/day from CARFAX (ignore invalid/zero/older 'today' readings)
  type MpDCalc = {
    mpdFromToday?: number | null;
    mpdFromTwo?: number | null;
    mpdBlended?: number | null;
    latestDate?: Date | null;
    latestMiles?: number | null;
    prevDate?: Date | null;
    prevMiles?: number | null;
  };
  const mpd: MpDCalc = {};
  if ((carfax as any).ok && Array.isArray((carfax as any).serviceRecords)) {
    const recs = (carfax as any).serviceRecords
      .map((r: any) => ({ date: parseCarfaxDate(r?.date ?? null), miles: typeof r?.odometer === "number" ? r.odometer : null }))
      .filter((r: any) => r.date && typeof r.miles === "number") as { date: Date; miles: number }[];

    recs.sort((a, b) => b.date.getTime() - a.date.getTime());

    const now = new Date();
    const todayMilesRaw =
      typeof resolvedMiles === "number"
        ? resolvedMiles
        : typeof vehicle.lastMileage === "number"
        ? vehicle.lastMileage
        : null;

    // valid only if positive and not behind latest CARFAX miles
    const todayIsValid = typeof todayMilesRaw === "number" && todayMilesRaw > 0 && (!recs[0] || todayMilesRaw >= recs[0].miles);

    if (todayIsValid && recs[0]) {
      const days = Math.max(1, daysBetween(now, recs[0].date));
      const delta = (todayMilesRaw as number) - recs[0].miles;
      const val = delta / days;
      mpd.mpdFromToday = Math.abs(val) < 0.01 ? null : val; // treat near-zero as no signal
      mpd.latestDate = recs[0].date;
      mpd.latestMiles = recs[0].miles;
    }

    if (recs[0] && recs[1]) {
      const days = Math.max(1, daysBetween(recs[0].date, recs[1].date));
      const delta = recs[0].miles - recs[1].miles;
      mpd.mpdFromTwo = delta / days;
      mpd.prevDate = recs[1].date;
      mpd.prevMiles = recs[1].miles;
    }

    if (mpd.mpdFromToday != null && mpd.mpdFromTwo != null) {
      mpd.mpdBlended = (mpd.mpdFromToday + mpd.mpdFromTwo) / 2;
    } else {
      mpd.mpdBlended = mpd.mpdFromTwo ?? mpd.mpdFromToday ?? null;
    }
  }

  // Local OEM schedule (from Mongo)
  const localOe = await getLocalOeFromMongo(vin);

  return (
    <VehicleDetailClient
      vehicle={{
        vin: vehicle.vin,
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        license: vehicle.license,
        lastMileage: vehicle.lastMileage,
        odometer: vehicle.odometer,
        updatedAt: vehicle.updatedAt
      }}
      ownerName={ownerName}
      ros={ros.map((r: any) => ({
        roNumber: r.roNumber,
        status: r.status,
        mileage: r.mileage,
        updatedAt: r.updatedAt,
        createdAt: r.createdAt
      }))}
      resolvedMiles={resolvedMiles}
      dvi={dvi}
      carfax={carfax}
      localOe={localOe}
      mpd={mpd}
      latestRoNumber={latestRoNumber}
      cfg={{ configured: cfg.configured }}
      carfaxCfg={{ configured: carfaxCfg.configured }}
    />
  );
}
