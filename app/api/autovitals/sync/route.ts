import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { getSession } from "@/lib/auth";
import {
  getShopAutoVitalsConfig,
  getAppointmentUpdates,
  getVehicle,
  getInspectionResults,
  cacheAutoVitalsVehicle,
  cacheAutoVitalsAppointment,
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

    console.log(`[AutoVitals Sync] Starting sync for shop ${shopId}`);

    const appointmentsResult = await getAppointmentUpdates(config);
    if (!appointmentsResult.ok) {
      return NextResponse.json({ 
        error: `Failed to fetch appointments: ${appointmentsResult.error}` 
      }, { status: 500 });
    }

    const appointments = appointmentsResult.data;
    console.log(`[AutoVitals Sync] Found ${appointments.length} appointments`);

    let vehiclesSynced = 0;
    let inspectionsSynced = 0;
    const errors: string[] = [];

    for (const appointment of appointments) {
      try {
        await cacheAutoVitalsAppointment(appointment, shopId);

        if (appointment.vehicleId) {
          const vehicleResult = await getVehicle(appointment.vehicleId, config);
          if (vehicleResult.ok) {
            await cacheAutoVitalsVehicle(vehicleResult.data, shopId);
            vehiclesSynced++;
          }
        }

        const inspectionResult = await getInspectionResults(appointment.appointmentId, config);
        if (inspectionResult.ok && inspectionResult.data.items.length > 0) {
          await cacheAutoVitalsInspection(inspectionResult.data, shopId);
          inspectionsSynced++;
        }
      } catch (err) {
        const msg = `Failed to sync appointment ${appointment.appointmentId}: ${err}`;
        console.error(`[AutoVitals Sync] ${msg}`);
        errors.push(msg);
      }
    }

    console.log(`[AutoVitals Sync] Completed. Vehicles: ${vehiclesSynced}, Inspections: ${inspectionsSynced}`);

    return NextResponse.json({
      success: true,
      stats: {
        appointments: appointments.length,
        vehiclesSynced,
        inspectionsSynced,
        errors: errors.length,
      },
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined,
    });
  } catch (error) {
    console.error("[AutoVitals Sync] Error:", error);
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

    const vehicleCountRows = await sql`
      SELECT COUNT(*)::int as count FROM autovitals_vehicles WHERE shop_id = ${shopId}
    `;
    const vehicleCount = vehicleCountRows[0]?.count || 0;

    const appointmentCountRows = await sql`
      SELECT COUNT(*)::int as count FROM autovitals_appointments WHERE shop_id = ${shopId}
    `;
    const appointmentCount = appointmentCountRows[0]?.count || 0;

    const inspectionCountRows = await sql`
      SELECT COUNT(*)::int as count FROM autovitals_inspections WHERE shop_id = ${shopId}
    `;
    const inspectionCount = inspectionCountRows[0]?.count || 0;

    const lastVehicleRows = await sql`
      SELECT updated_at FROM autovitals_vehicles 
      WHERE shop_id = ${shopId} 
      ORDER BY updated_at DESC 
      LIMIT 1
    `;

    return NextResponse.json({
      vehicles: vehicleCount,
      appointments: appointmentCount,
      inspections: inspectionCount,
      lastSyncedAt: lastVehicleRows[0]?.updated_at || null,
    });
  } catch (error) {
    console.error("[AutoVitals Sync GET] Error:", error);
    return NextResponse.json({ error: "Failed to fetch sync status" }, { status: 500 });
  }
}
