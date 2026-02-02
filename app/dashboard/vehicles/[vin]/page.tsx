// app/dashboard/vehicles/[vin]/page.tsx
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import Link from "next/link";
import { fetchDviWithCache, resolveAutoflowConfig } from "@/lib/integrations/autoflow";
import { fetchCarfaxWithCache, resolveCarfaxConfig } from "@/lib/integrations/carfax";
import { getMaintenanceScheduleCached, getEnhancedVehicleData } from "@/lib/integrations/dataone-api";
import { searchVehiclesByVin, getRepairOrders, getRepairOrderInspections } from "@/lib/tekmetric";
import { resolveProtractorConfig, fetchAllActiveInspections, fetchInvoicesForVehicle as fetchProtractorInvoices } from "@/lib/integrations/protractor";
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

  // Vehicle-level odometer/lastMileage/mileage (Tekmetric stores as mileage)
  const veh = await db.collection("vehicles").findOne({ vin }, { projection: { odometer: 1, lastMileage: 1, mileage: 1 } });
  const mVeh = toPos(veh?.mileage) ?? toPos(veh?.odometer) ?? toPos(veh?.lastMileage);

  return mRO ?? mAF ?? mVeh ?? null;
}

/* ---------- page ---------- */
type PageProps = { params: Promise<{ vin: string }> };

export default async function VehicleDetailPage({ params }: PageProps) {
  const session = await requireSession();
  const db = await getDb();
  const shopId = Number(session.shopId);

  const { vin: vinParam } = await params;
  const vin = String(vinParam || "").toUpperCase();

  let vehicle = await db.collection("vehicles").findOne(
    { 
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
      vin 
    },
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
        hasComponents: 1,
        declinedServices: 1,
      },
    }
  );

  // If not in vehicles collection, try to build from events (AutoFlow data)
  if (!vehicle) {
    const eventVehicle = await db.collection("events").findOne(
      {
        $and: [
          { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
          { 
            $or: [
              { vehicleVin: { $regex: new RegExp(`^${vin}$`, 'i') } },
              { vin: { $regex: new RegExp(`^${vin}$`, 'i') } },
              { "payload.vehicle.vin": { $regex: new RegExp(`^${vin}$`, 'i') } }
            ]
          }
        ]
      },
      { sort: { createdAt: -1 } }
    );

    if (eventVehicle) {
      const payload = eventVehicle.payload || {};
      const veh = payload.vehicle || {};
      vehicle = {
        _id: null,
        vin: vin,
        year: veh.year || null,
        make: veh.make || null,
        model: veh.model || null,
        license: veh.license || veh.plate || null,
        lastMileage: veh.mileage || veh.miles || veh.odometer || payload.ticket?.mileage || null,
        odometer: veh.odometer || veh.mileage || veh.miles || null,
        updatedAt: eventVehicle.createdAt || new Date(),
        customerId: null,
      };
    }
  }

  // If still not found, try to fetch from Tekmetric API using direct VIN search
  if (!vehicle) {
    const shop = await db.collection("shops").findOne({});
    if (shop?.tekmetric?.shopId && process.env.TEKMETRIC_CLIENT_ID) {
      try {
        // Direct VIN search - single API call
        const vehicleResponse = await searchVehiclesByVin(shop.tekmetric.shopId, vin);
        
        if (vehicleResponse.content.length > 0) {
          const tekVehicle = vehicleResponse.content[0];
          
          vehicle = {
            _id: null,
            vin: vin,
            year: tekVehicle.year || null,
            make: tekVehicle.make || null,
            model: tekVehicle.model || null,
            license: tekVehicle.licensePlate || null,
            lastMileage: tekVehicle.mileageIn || tekVehicle.mileageOut || null,
            odometer: tekVehicle.mileageIn || tekVehicle.mileageOut || null,
            updatedAt: tekVehicle.updatedDate ? new Date(tekVehicle.updatedDate) : new Date(),
            customerId: null,
          };
          
          // Store in database for future lookups
          await db.collection("vehicles").updateOne(
            { vin },
            { 
              $set: {
                ...vehicle,
                shopId: String(shopId),
                tekmetric: {
                  vehicleId: tekVehicle.id,
                  customerId: tekVehicle.customerId,
                  lastSynced: new Date()
                }
              },
              $setOnInsert: { createdAt: new Date() }
            },
            { upsert: true }
          );
        }
      } catch (error) {
        console.error('[Vehicle Detail] Error fetching from Tekmetric:', error);
      }
    }
  }

  if (!vehicle) {
    return (
      <main className="mx-auto max-w-5xl p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Vehicle</h1>
          <Link href="/dashboard" className="text-sm underline">
            ← Back to Dashboard
          </Link>
        </div>
        <p className="text-sm">
          No vehicle found for VIN <code>{vin}</code>.
        </p>
      </main>
    );
  }

  // Enhance vehicle data with DataOne VIN decoding if missing key info
  if (!vehicle.year || !vehicle.make || !vehicle.model) {
    const enhanced = await getEnhancedVehicleData(vin);
    if (enhanced.ok && enhanced.vehicle) {
      vehicle = {
        ...vehicle,
        year: vehicle.year || enhanced.vehicle.year,
        make: vehicle.make || enhanced.vehicle.make,
        model: vehicle.model || enhanced.vehicle.model,
      };
    }
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

  // Get repair orders from events collection (AutoFlow webhooks store RO data here)
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

  // Also fetch Protractor invoices if shop uses Protractor
  let protractorRos: typeof eventRos = [];
  const protractorVehicle = await db.collection("protractor_vehicles").findOne({
    $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
    vin: vin.toUpperCase()
  });
  
  if (protractorVehicle?.protractorId) {
    try {
      const invoiceResult = await fetchProtractorInvoices(shopId, String(protractorVehicle.protractorId));
      if (invoiceResult.ok && invoiceResult.invoices) {
        protractorRos = invoiceResult.invoices.map((inv: any) => ({
          _id: inv.ID || inv.InvoiceNumber,
          roNumber: inv.InvoiceNumber || inv.ID,
          status: inv.Posted ? "Posted" : "Open",
          mileage: inv.Usage || inv.Mileage || null,
          updatedAt: inv.InvoiceDate ? new Date(inv.InvoiceDate) : new Date(),
          createdAt: inv.InvoiceDate ? new Date(inv.InvoiceDate) : new Date(),
          source: "protractor"
        }));
        console.log(`[Protractor] Found ${protractorRos.length} invoices for vehicle ${vin}`);
      }
    } catch (error) {
      console.log(`[Protractor] Invoice fetch error for ${vin}:`, error);
    }
  }

  // Merge AutoFlow and Protractor ROs, dedupe by roNumber, sort by date
  const allRos = [...eventRos, ...protractorRos];
  const rosMap = new Map<string, typeof allRos[0]>();
  for (const ro of allRos) {
    const key = String(ro.roNumber);
    if (!rosMap.has(key) || (ro.updatedAt > rosMap.get(key)!.updatedAt)) {
      rosMap.set(key, ro);
    }
  }
  const ros = Array.from(rosMap.values()).sort((a, b) => 
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  ).slice(0, 20);

  const latestRoNumber = ros[0]?.roNumber ?? null;

  // Autoflow - fetch DVI for the latest RO
  const cfg = await resolveAutoflowConfig(shopId);
  
  let dvi: any;
  if (!latestRoNumber) {
    dvi = { ok: false, error: "No RO found for this vehicle." };
  } else if (!cfg.configured) {
    dvi = { ok: false, error: "AutoFlow not connected." };
  } else {
    dvi = await fetchDviWithCache(shopId, String(latestRoNumber), 1000);
    if (dvi.raw) {
      console.log(`[DVI Debug] Full raw response keys:`, JSON.stringify(Object.keys(dvi.raw)));
      console.log(`[DVI Debug] dvis array:`, JSON.stringify(dvi.raw?.content?.dvis?.map((d: any) => ({ name: d.dvi_name, catCount: d.dvi_category?.length }))));
    }
  }

  // Try Tekmetric inspections if no AutoFlow DVI and vehicle has Tekmetric data
  let tekmetricDvi: any = null;
  if (vehicle.tekmetric?.repairOrderId || vehicle.tekmetric?.vehicleId) {
    const shop = await db.collection("shops").findOne({});
    if (shop?.tekmetric?.shopId && process.env.TEKMETRIC_CLIENT_ID) {
      try {
        // Get latest RO for this vehicle from Tekmetric
        const roResponse = await getRepairOrders(shop.tekmetric.shopId, {
          vehicleId: vehicle.tekmetric.vehicleId,
          size: 1,
          sortDirection: 'DESC'
        });
        
        if (roResponse.content.length > 0) {
          const latestTekRo = roResponse.content[0];
          console.log(`[Tekmetric] Fetching inspections for RO ${latestTekRo.id}`);
          const inspections = await getRepairOrderInspections(latestTekRo.id);
          
          if (inspections.length > 0) {
            console.log(`[Tekmetric] Found ${inspections.length} inspections`);
            tekmetricDvi = {
              ok: true,
              source: 'tekmetric',
              inspections: inspections,
              items: inspections.flatMap((insp: any) => 
                (insp.items || []).map((item: any) => ({
                  name: item.name || item.categoryName || 'Unknown',
                  status: item.status,
                  notes: item.notes,
                  source: 'tekmetric'
                }))
              )
            };
          }
        }
      } catch (error) {
        console.log(`[Tekmetric] Inspection fetch error:`, error);
      }
    }
  }

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

  // OEM schedule - uses MongoDB Atlas cache (first call fetches from DataOne API, subsequent calls use cache)
  const oemData = await getMaintenanceScheduleCached(vin);
  console.log(`[Vehicle Detail] OEM data source: ${oemData.source}, count: ${oemData.count}`);
  
  const localOe = {
    ok: oemData.ok,
    count: oemData.count,
    items: (oemData.items || []).map((item: any) => ({
      category: item.maintenance_category || "General",
      name: item.maintenance_name || "Unknown",
      notes: item.maintenance_notes,
      miles: item.miles,
      months: item.months,
    })),
    error: oemData.error,
    source: oemData.source,
  };

  // Check if shop has Tekmetric connected
  const shop = await db.collection("shops").findOne({});
  const tekmetricConnected = !!shop?.tekmetric?.shopId;

  // Protractor inspections (DVI data from AutoVitals pushed to Protractor)
  let protractorDvi: any = null;
  const protractorCfg = await resolveProtractorConfig(shopId);
  if (protractorCfg.configured) {
    try {
      const inspectionsResult = await fetchAllActiveInspections(shopId);
      if (inspectionsResult.ok && inspectionsResult.inspections && inspectionsResult.inspections.length > 0) {
        console.log(`[Protractor] Found ${inspectionsResult.inspections.length} inspections`);
        protractorDvi = {
          ok: true,
          source: 'protractor',
          inspections: inspectionsResult.inspections,
          items: inspectionsResult.inspections.flatMap((insp: any) =>
            (insp.Items || []).map((item: any) => ({
              name: item.Name || item.Description || 'Unknown',
              status: item.Result || item.Status || 'Unknown',
              notes: item.Notes,
              severity: item.Severity,
              source: 'protractor'
            }))
          )
        };
      }
    } catch (error) {
      console.log(`[Protractor] Inspection fetch error:`, error);
    }
  }

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
        updatedAt: vehicle.updatedAt,
        hasComponents: vehicle.hasComponents || {},
        declinedServices: vehicle.declinedServices || [],
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
      tekmetricDvi={tekmetricDvi}
      protractorDvi={protractorDvi}
      carfax={carfax}
      localOe={localOe}
      mpd={mpd}
      latestRoNumber={latestRoNumber}
      cfg={{ configured: cfg.configured }}
      carfaxCfg={{ configured: carfaxCfg.configured }}
      tekmetricConnected={tekmetricConnected}
      protractorConnected={protractorCfg.configured}
    />
  );
}
