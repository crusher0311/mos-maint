import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import {
  getShopAutoVitalsConfig,
  getAppointmentUpdates,
  getVehicle,
  getInspectionResults,
  getRepairOrderJobs,
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
    const user = { shopId: String(session.shopId) };

    const config = await getShopAutoVitalsConfig(user.shopId);
    if (!config) {
      return NextResponse.json({ 
        error: "AutoVitals is not configured. Please set up your credentials in Settings." 
      }, { status: 400 });
    }

    console.log(`[AutoVitals Sync] Starting sync for shop ${user.shopId}`);

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
        await cacheAutoVitalsAppointment(appointment, user.shopId);

        if (appointment.vehicleId) {
          const vehicleResult = await getVehicle(appointment.vehicleId, config);
          if (vehicleResult.ok) {
            await cacheAutoVitalsVehicle(vehicleResult.data, user.shopId);
            vehiclesSynced++;
          }
        }

        const inspectionResult = await getInspectionResults(appointment.appointmentId, config);
        if (inspectionResult.ok && inspectionResult.data.items.length > 0) {
          await cacheAutoVitalsInspection(inspectionResult.data, user.shopId);
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
    const user = { shopId: String(session.shopId) };

    const db = await getDb();

    const vehicleCount = await db.collection("autovitals_vehicles").countDocuments({ shopId: user.shopId });
    const appointmentCount = await db.collection("autovitals_appointments").countDocuments({ shopId: user.shopId });
    const inspectionCount = await db.collection("autovitals_inspections").countDocuments({ shopId: user.shopId });

    const lastVehicle = await db.collection("autovitals_vehicles")
      .findOne({ shopId: user.shopId }, { sort: { updatedAt: -1 } });

    return NextResponse.json({
      vehicles: vehicleCount,
      appointments: appointmentCount,
      inspections: inspectionCount,
      lastSyncedAt: lastVehicle?.updatedAt || null,
    });
  } catch (error) {
    console.error("[AutoVitals Sync GET] Error:", error);
    return NextResponse.json({ error: "Failed to fetch sync status" }, { status: 500 });
  }
}
