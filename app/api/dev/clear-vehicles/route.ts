import { NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { requireSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function DELETE() {
  try {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "This endpoint is only available in development" }, { status: 403 });
    }

    const session = await requireSession();
    const shopId = String(session.shopId);

    const vehiclesResult = await sql`DELETE FROM vehicles WHERE shop_id = ${shopId}`;
    const plansResult = await sql`DELETE FROM plans WHERE shop_id = ${shopId}`;
    const customersResult = await sql`DELETE FROM customers WHERE shop_id = ${shopId}`;
    const eventsResult = await sql`DELETE FROM events WHERE shop_id = ${shopId}`;
    const protractorWoResult = await sql`DELETE FROM protractor_work_orders WHERE shop_id = ${shopId}`;
    const protractorVehiclesResult = await sql`DELETE FROM protractor_vehicles WHERE shop_id = ${shopId}`;
    const autovitalsVehiclesResult = await sql`DELETE FROM autovitals_vehicles WHERE shop_id = ${shopId}`;
    const autovitalsAppointmentsResult = await sql`DELETE FROM autovitals_appointments WHERE shop_id = ${shopId}`;

    return NextResponse.json({
      ok: true,
      deleted: {
        vehicles: vehiclesResult.count,
        plans: plansResult.count,
        customers: customersResult.count,
        events: eventsResult.count,
        protractorWorkOrders: protractorWoResult.count,
        protractorVehicles: protractorVehiclesResult.count,
        autovitalsVehicles: autovitalsVehiclesResult.count,
        autovitalsAppointments: autovitalsAppointmentsResult.count,
      },
    });
  } catch (e: any) {
    console.error("[Clear Vehicles] Error:", e);
    return NextResponse.json({ error: e?.message || "Unexpected error" }, { status: 500 });
  }
}
