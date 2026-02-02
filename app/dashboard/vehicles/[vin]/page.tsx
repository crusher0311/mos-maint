// app/dashboard/vehicles/[vin]/page.tsx
import { requireSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import Link from "next/link";
import { fetchDviWithCache, resolveAutoflowConfig } from "@/lib/integrations/autoflow";
import { fetchCarfaxWithCache, resolveCarfaxConfig } from "@/lib/integrations/carfax";
import { getMaintenanceScheduleCached, getEnhancedVehicleData } from "@/lib/integrations/dataone-api";
import { searchVehiclesByVin, getRepairOrders, getRepairOrderInspections } from "@/lib/tekmetric";
import { resolveProtractorConfig, fetchAllActiveInspections } from "@/lib/integrations/protractor";
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
async function getLatestMilesForVin(vin: string): Promise<number | null> {
  const vinUpper = String(vin || "").toUpperCase();
  const toPos = (v: unknown) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // Latest RO mileage
  const roResult = await sql`
    SELECT mileage FROM work_orders 
    WHERE vin = ${vinUpper}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1
  `;
  const mRO = toPos(roResult[0]?.mileage);

  // Latest AF or manual close event with mileage
  const afResult = await sql`
    SELECT 
      COALESCE(
        (payload->>'mileage')::numeric,
        (payload->'ticket'->>'mileage')::numeric,
        (payload->'vehicle'->>'mileage')::numeric,
        (payload->'vehicle'->>'miles')::numeric,
        (payload->'vehicle'->>'odometer')::numeric
      ) as miles
    FROM events
    WHERE UPPER(COALESCE(vehicle_vin, vin, payload->'vehicle'->>'vin')) = ${vinUpper}
      AND (provider = 'autoflow' OR (provider = 'ui' AND type = 'manual_closed'))
    ORDER BY created_at DESC NULLS LAST
    LIMIT 1
  `;
  const mAF = toPos(afResult[0]?.miles);

  // Vehicle-level odometer/lastMileage/mileage
  const vehResult = await sql`
    SELECT mileage, odometer, last_mileage FROM vehicles 
    WHERE vin = ${vinUpper}
    LIMIT 1
  `;
  const veh = vehResult[0];
  const mVeh = toPos(veh?.mileage) ?? toPos(veh?.odometer) ?? toPos(veh?.last_mileage);

  return mRO ?? mAF ?? mVeh ?? null;
}

/* ---------- page ---------- */
type PageProps = { params: Promise<{ vin: string }> };

export default async function VehicleDetailPage({ params }: PageProps) {
  const session = await requireSession();
  const shopId = String(session.shopId);

  const { vin: vinParam } = await params;
  const vin = String(vinParam || "").toUpperCase();

  // Get shop UUID from shop_id
  const shopUuidResult = await sql`SELECT id FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
  const shopUuid = shopUuidResult[0]?.id as string | undefined;

  // Find vehicle in PostgreSQL
  const vehicleResult = shopUuid ? await sql`
    SELECT 
      id, vin, year, make, model, license_plate, last_mileage, odometer, updated_at, customer_id,
      declined_services, metadata, raw_data
    FROM vehicles
    WHERE shop_id = ${shopUuid}::uuid AND vin = ${vin}
    LIMIT 1
  ` : [];
  
  let vehicle: any = vehicleResult[0] ? {
    _id: vehicleResult[0].id,
    vin: vehicleResult[0].vin,
    year: vehicleResult[0].year,
    make: vehicleResult[0].make,
    model: vehicleResult[0].model,
    license: vehicleResult[0].license_plate,
    lastMileage: vehicleResult[0].last_mileage,
    odometer: vehicleResult[0].odometer,
    updatedAt: vehicleResult[0].updated_at,
    customerId: vehicleResult[0].customer_id,
    hasComponents: vehicleResult[0].metadata?.hasComponents || {},
    declinedServices: vehicleResult[0].declined_services || [],
    tekmetric: vehicleResult[0].raw_data?.tekmetric,
  } : null;

  // If not in vehicles collection, try to build from events (AutoFlow data)
  if (!vehicle && shopUuid) {
    const eventResult = await sql`
      SELECT payload, created_at
      FROM events
      WHERE shop_id = ${shopUuid}::uuid
        AND UPPER(COALESCE(vin, payload->'vehicle'->>'vin')) = ${vin}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (eventResult[0]) {
      const payload = eventResult[0].payload || {};
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
        updatedAt: eventResult[0].created_at || new Date(),
        customerId: null,
      };
    }
  }

  // If still not found, try to fetch from Tekmetric API using direct VIN search
  if (!vehicle) {
    const shopResult = await sql`SELECT tekmetric FROM shops LIMIT 1`;
    const shop = shopResult[0];
    if (shop?.tekmetric?.shopId && process.env.TEKMETRIC_CLIENT_ID) {
      try {
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
            tekmetric: {
              vehicleId: tekVehicle.id,
              customerId: tekVehicle.customerId,
              lastSynced: new Date()
            }
          };
          
          // Store in database for future lookups
          if (shopUuid) {
            await sql`
              INSERT INTO vehicles (vin, shop_id, year, make, model, license_plate, last_mileage, odometer, updated_at, tekmetric, created_at)
              VALUES (${vin}, ${shopUuid}::uuid, ${tekVehicle.year}, ${tekVehicle.make}, ${tekVehicle.model}, 
                      ${tekVehicle.licensePlate}, ${tekVehicle.mileageIn || tekVehicle.mileageOut}, 
                      ${tekVehicle.mileageIn || tekVehicle.mileageOut}, NOW(),
                      ${JSON.stringify(vehicle.tekmetric)}::jsonb, NOW())
              ON CONFLICT (vin, shop_id) DO UPDATE SET
                year = COALESCE(EXCLUDED.year, vehicles.year),
                make = COALESCE(EXCLUDED.make, vehicles.make),
                model = COALESCE(EXCLUDED.model, vehicles.model),
                tekmetric = EXCLUDED.tekmetric,
                updated_at = NOW()
            `;
          }
        }
      } catch (error) {
        console.error('[Vehicle Detail] Error fetching from Tekmetric:', error);
      }
    }
  }

  // If still not found, try to use cached plan data and DataOne VIN decoding
  if (!vehicle && shopUuid) {
    const cachedPlan = await sql`
      SELECT vin, mileage FROM cached_plans 
      WHERE shop_id = ${shopUuid}::uuid AND vin = ${vin}
      LIMIT 1
    `;
    if (cachedPlan[0]) {
      // Get vehicle info from DataOne VIN decoding
      const enhanced = await getEnhancedVehicleData(vin);
      vehicle = {
        _id: null,
        vin: vin,
        year: enhanced.ok ? enhanced.vehicle?.year : null,
        make: enhanced.ok ? enhanced.vehicle?.make : null,
        model: enhanced.ok ? enhanced.vehicle?.model : null,
        license: null,
        lastMileage: cachedPlan[0].mileage,
        odometer: cachedPlan[0].mileage,
        updatedAt: new Date(),
        customerId: null,
      };
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

  // Resolve current miles (used in header and to patch the latest RO row if it's 0)
  const resolvedMiles = await getLatestMilesForVin(vin);

  // Get customer info
  let customer: any = null;
  if (vehicle.customerId) {
    const custResult = await sql`
      SELECT first_name, last_name, name, email, phone
      FROM customers WHERE id = ${vehicle.customerId}
      LIMIT 1
    `;
    customer = custResult[0];
  }

  const ownerName =
    [customer?.first_name, customer?.last_name].filter(Boolean).join(" ").trim() || (customer?.name || "");

  // Get repair orders from events collection (AutoFlow webhooks store RO data here)
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
      WHERE shop_id = ${shopId}
        AND provider = 'autoflow'
        AND UPPER(COALESCE(vehicle_vin, vin, payload->'vehicle'->>'vin')) = ${vin}
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
  const latestRoNumber = ros[0]?.ro_number ?? null;

  // Autoflow - fetch DVI for the latest RO
  const cfg = await resolveAutoflowConfig(Number(shopId));
  
  let dvi: any;
  if (!latestRoNumber) {
    dvi = { ok: false, error: "No RO found for this vehicle." };
  } else if (!cfg.configured) {
    dvi = { ok: false, error: "AutoFlow not connected." };
  } else {
    dvi = await fetchDviWithCache(Number(shopId), String(latestRoNumber), 1000);
    if (dvi.raw) {
      console.log(`[DVI Debug] Full raw response keys:`, JSON.stringify(Object.keys(dvi.raw)));
      console.log(`[DVI Debug] dvis array:`, JSON.stringify(dvi.raw?.content?.dvis?.map((d: any) => ({ name: d.dvi_name, catCount: d.dvi_category?.length }))));
    }
  }

  // Try Tekmetric inspections if no AutoFlow DVI and vehicle has Tekmetric data
  let tekmetricDvi: any = null;
  if (vehicle.tekmetric?.repairOrderId || vehicle.tekmetric?.vehicleId) {
    const shopResult = await sql`SELECT tekmetric FROM shops LIMIT 1`;
    const shop = shopResult[0];
    if (shop?.tekmetric?.shopId && process.env.TEKMETRIC_CLIENT_ID) {
      try {
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
  const carfaxCfg = await resolveCarfaxConfig(Number(shopId));
  const carfax = carfaxCfg.configured
    ? await fetchCarfaxWithCache(Number(shopId), vin, 7 * 24 * 60 * 60 * 1000)
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

    const todayIsValid = typeof todayMilesRaw === "number" && todayMilesRaw > 0 && (!recs[0] || todayMilesRaw >= recs[0].miles);

    if (todayIsValid && recs[0]) {
      const days = Math.max(1, daysBetween(now, recs[0].date));
      const delta = (todayMilesRaw as number) - recs[0].miles;
      const val = delta / days;
      mpd.mpdFromToday = Math.abs(val) < 0.01 ? null : val;
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

  // OEM schedule - uses PostgreSQL cache
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
  const shopCheckResult = await sql`SELECT tekmetric FROM shops LIMIT 1`;
  const tekmetricConnected = !!shopCheckResult[0]?.tekmetric?.shopId;

  // Protractor inspections (DVI data from AutoVitals pushed to Protractor)
  let protractorDvi: any = null;
  const protractorCfg = await resolveProtractorConfig(Number(shopId));
  if (protractorCfg.configured) {
    try {
      const inspectionsResult = await fetchAllActiveInspections(Number(shopId));
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
        roNumber: r.ro_number,
        status: r.status,
        mileage: r.mileage,
        updatedAt: r.updated_at,
        createdAt: r.created_at
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
