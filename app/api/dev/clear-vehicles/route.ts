import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function DELETE() {
  try {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "This endpoint is only available in development" }, { status: 403 });
    }

    const session = await requireSession();
    const shopId = Number(session.shopId);

    const db = await getDb();

    const vehiclesResult = await db.collection("vehicles").deleteMany({ shopId });
    const plansResult = await db.collection("plans").deleteMany({ shopId });
    const customersResult = await db.collection("customers").deleteMany({ shopId });
    
    const eventsResult = await db.collection("events").deleteMany({ 
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] 
    });

    const protractorWoResult = await db.collection("protractor_work_orders").deleteMany({ shopId });
    const protractorVehiclesResult = await db.collection("protractor_vehicles").deleteMany({ shopId });
    const autovitalsVehiclesResult = await db.collection("autovitals_vehicles").deleteMany({ 
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] 
    });
    const autovitalsAppointmentsResult = await db.collection("autovitals_appointments").deleteMany({ 
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] 
    });

    return NextResponse.json({
      ok: true,
      deleted: {
        vehicles: vehiclesResult.deletedCount,
        plans: plansResult.deletedCount,
        customers: customersResult.deletedCount,
        events: eventsResult.deletedCount,
        protractorWorkOrders: protractorWoResult.deletedCount,
        protractorVehicles: protractorVehiclesResult.deletedCount,
        autovitalsVehicles: autovitalsVehiclesResult.deletedCount,
        autovitalsAppointments: autovitalsAppointmentsResult.deletedCount,
      },
    });
  } catch (e: any) {
    console.error("[Clear Vehicles] Error:", e);
    return NextResponse.json({ error: e?.message || "Unexpected error" }, { status: 500 });
  }
}
