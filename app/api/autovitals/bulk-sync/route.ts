import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { getSession } from "@/lib/auth";
import {
  getShopAutoVitalsConfig,
  getAppointmentUpdates,
  getVehicle,
  getInspectionResults,
  cacheAutoVitalsVehicle,
  cacheAutoVitalsInspection,
} from "@/lib/integrations/autovitals";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const shopId = String(session.shopId);

    const config = await getShopAutoVitalsConfig(shopId);
    if (!config) {
      return NextResponse.json({ 
        error: "AutoVitals is not configured. Please set up your credentials in Settings." 
      }, { status: 400 });
    }

    console.log(`[AutoVitals Bulk Sync] Starting for shop ${shopId}`);

    const now = new Date();

    const appointmentsResult = await getAppointmentUpdates(config);
    if (!appointmentsResult.ok) {
      return NextResponse.json({ 
        error: `Failed to fetch appointments: ${appointmentsResult.error}` 
      }, { status: 500 });
    }

    const appointments = appointmentsResult.data;
    console.log(`[AutoVitals Bulk Sync] Found ${appointments.length} appointments`);

    let vehiclesSynced = 0;
    let vehiclesImported = 0;
    let inspectionsSynced = 0;
    let enrichmentQueued = 0;
    const errors: string[] = [];
    const processedVins = new Set<string>();

    for (const appointment of appointments) {
      try {
        if (appointment.vehicleId) {
          const vehicleResult = await getVehicle(appointment.vehicleId, config);
          if (vehicleResult.ok) {
            const avVehicle = vehicleResult.data;
            
            await cacheAutoVitalsVehicle(avVehicle, shopId);
            vehiclesSynced++;

            if (avVehicle.vin && !processedVins.has(avVehicle.vin)) {
              processedVins.add(avVehicle.vin);
              
              const vin = avVehicle.vin.toUpperCase();
              const customerName = avVehicle.customerName || appointment.customerName;
              const customerPhone = appointment.customerPhone;
              const customerEmail = appointment.customerEmail;

              const existingRows = await sql`
                SELECT id, oem_schedule_fetched_at, carfax_fetched_at 
                FROM vehicles 
                WHERE shop_id = ${shopId} AND vin = ${vin}
                LIMIT 1
              `;
              const existingVehicle = existingRows[0];

              const vehicleYear = avVehicle.year ? Number(avVehicle.year) : null;
              const vehicleMake = avVehicle.make || null;
              const vehicleModel = avVehicle.model || null;
              const lastMileage = avVehicle.mileage || appointment.mileageIn || null;
              const vehicleLicense = avVehicle.licensePlate || null;
              const custName = customerName || null;
              const custPhone = customerPhone || null;
              const custEmail = customerEmail || null;

              await sql`
                INSERT INTO vehicles (shop_id, vin, year, make, model, last_mileage, license, source, updated_at, customer_name, customer_phone, customer_email, created_at)
                VALUES (${shopId}, ${vin}, ${vehicleYear}, ${vehicleMake}, ${vehicleModel}, ${lastMileage}, ${vehicleLicense}, 'autovitals', ${now}, ${custName}, ${custPhone}, ${custEmail}, ${now})
                ON CONFLICT (shop_id, vin) DO UPDATE SET
                  year = COALESCE(EXCLUDED.year, vehicles.year),
                  make = COALESCE(EXCLUDED.make, vehicles.make),
                  model = COALESCE(EXCLUDED.model, vehicles.model),
                  last_mileage = COALESCE(EXCLUDED.last_mileage, vehicles.last_mileage),
                  license = COALESCE(EXCLUDED.license, vehicles.license),
                  source = EXCLUDED.source,
                  updated_at = EXCLUDED.updated_at,
                  customer_name = COALESCE(EXCLUDED.customer_name, vehicles.customer_name),
                  customer_phone = COALESCE(EXCLUDED.customer_phone, vehicles.customer_phone),
                  customer_email = COALESCE(EXCLUDED.customer_email, vehicles.customer_email)
              `;

              if (!existingVehicle) {
                vehiclesImported++;
              }

              const needsEnrichment = !existingVehicle || 
                !existingVehicle.oem_schedule_fetched_at ||
                !existingVehicle.carfax_fetched_at;

              if (needsEnrichment) {
                await sql`
                  INSERT INTO enrichment_queue (shop_id, vin, status, priority, updated_at, created_at, attempts)
                  VALUES (${shopId}, ${vin}, 'pending', 1, ${now}, ${now}, 0)
                  ON CONFLICT (shop_id, vin) DO UPDATE SET
                    status = 'pending',
                    priority = 1,
                    updated_at = ${now}
                `;
                enrichmentQueued++;
              }
            }
          }
        }

        if (appointment.appointmentId) {
          const inspectionResult = await getInspectionResults(appointment.appointmentId, config);
          if (inspectionResult.ok && inspectionResult.data.items.length > 0) {
            await cacheAutoVitalsInspection(inspectionResult.data, shopId);
            inspectionsSynced++;

            if (appointment.vin) {
              const vin = appointment.vin.toUpperCase();
              const itemCount = inspectionResult.data.items.length;
              const redCount = inspectionResult.data.items.filter((i: any) => i.status === "red").length;
              const yellowCount = inspectionResult.data.items.filter((i: any) => i.status === "yellow").length;

              await sql`
                UPDATE vehicles SET
                  last_dvi_at = ${now},
                  last_dvi_appointment_id = ${appointment.appointmentId},
                  dvi = jsonb_build_object('itemCount', ${itemCount}, 'redCount', ${redCount}, 'yellowCount', ${yellowCount})
                WHERE shop_id = ${shopId} AND vin = ${vin}
              `;
            }
          }
        }
      } catch (err) {
        const msg = `Failed to sync appointment ${appointment.appointmentId}: ${err}`;
        console.error(`[AutoVitals Bulk Sync] ${msg}`);
        errors.push(msg);
      }
    }

    const bulkSyncStats = {
      appointments: appointments.length,
      vehiclesSynced,
      vehiclesImported,
      inspectionsSynced,
      enrichmentQueued,
    };

    await sql`
      UPDATE shops SET
        settings = jsonb_set(
          jsonb_set(
            COALESCE(settings, '{}'),
            '{autovitals,lastBulkSyncAt}', ${JSON.stringify(now.toISOString())}::jsonb
          ),
          '{autovitals,lastBulkSyncStats}', ${JSON.stringify(bulkSyncStats)}::jsonb
        ),
        updated_at = ${now}
      WHERE shop_id = ${shopId}
    `;

    console.log(`[AutoVitals Bulk Sync] Completed. Vehicles: ${vehiclesSynced} synced, ${vehiclesImported} imported. Inspections: ${inspectionsSynced}. Enrichment queued: ${enrichmentQueued}`);

    return NextResponse.json({
      success: true,
      stats: {
        ...bulkSyncStats,
        errors: errors.length,
      },
      message: `Synced ${vehiclesSynced} vehicles from AutoVitals. ${vehiclesImported} new vehicles imported to MOS.`,
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
    });
  } catch (error) {
    console.error("[AutoVitals Bulk Sync] Error:", error);
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : "Sync failed" 
    }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const shopId = String(session.shopId);

    const avVehicleCountRows = await sql`
      SELECT COUNT(*)::int as count FROM autovitals_vehicles WHERE shop_id = ${shopId}
    `;
    const avVehicleCount = avVehicleCountRows[0]?.count || 0;

    const mosVehicleCountRows = await sql`
      SELECT COUNT(*)::int as count FROM vehicles WHERE shop_id = ${shopId} AND source = 'autovitals'
    `;
    const mosVehicleCount = mosVehicleCountRows[0]?.count || 0;

    const pendingEnrichmentRows = await sql`
      SELECT COUNT(*)::int as count FROM enrichment_queue WHERE shop_id = ${shopId} AND status = 'pending'
    `;
    const pendingEnrichment = pendingEnrichmentRows[0]?.count || 0;

    const shopRows = await sql`
      SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1
    `;
    const settings = shopRows[0]?.settings || {};

    return NextResponse.json({
      autovitalsVehicles: avVehicleCount,
      mosVehicles: mosVehicleCount,
      pendingEnrichment,
      lastBulkSyncAt: settings.autovitals?.lastBulkSyncAt || null,
      lastBulkSyncStats: settings.autovitals?.lastBulkSyncStats || null,
    });
  } catch (error) {
    console.error("[AutoVitals Bulk Sync GET] Error:", error);
    return NextResponse.json({ error: "Failed to fetch sync status" }, { status: 500 });
  }
}
