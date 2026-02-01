import { NextResponse } from "next/server";
import { getCustomerById } from "@/lib/db/customers-pg";
import { getVehiclesByCustomerId } from "@/lib/db/vehicles-pg";
import { getWorkOrdersForCustomer } from "@/lib/db/work-orders-pg";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

export async function GET(_: Request, ctx: { params: { customerId: string } }) {
  try {
    const id = ctx.params?.customerId;
    if (!id || !isValidUUID(id)) {
      return NextResponse.json({ error: "Invalid customerId" }, { status: 400 });
    }

    const customer = await getCustomerById(id);
    if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const ninetyDaysAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 90);

    const [vehicles, repairOrders, recentEvents] = await Promise.all([
      getVehiclesByCustomerId(id).then(v => v.slice(0, 3)),
      getWorkOrdersForCustomer(id, 5),
      customer.shop_id ? sql<{payload: Record<string, unknown>, received_at: Date}[]>`
        SELECT payload, received_at FROM events
        WHERE shop_id = ${customer.shop_id}
          AND provider = 'autoflow'
          AND received_at >= ${ninetyDaysAgo}
        ORDER BY received_at DESC
        LIMIT 20
      ` : []
    ]);

    const suggestions: Record<string, unknown> = {};
    if (!customer.name && (customer.first_name || customer.last_name)) {
      suggestions.name = [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim();
    }
    if (!customer.email) {
      const fromEvents = recentEvents
        .map(e => {
          const payload = e.payload as Record<string, unknown>;
          const cust = payload?.customer as Record<string, unknown> | undefined;
          return cust?.email || payload?.email;
        })
        .find(Boolean);
      if (fromEvents) suggestions.email = String(fromEvents).toLowerCase();
    }
    if (!customer.phone) {
      const fromEvents =
        recentEvents
          .map(e => {
            const payload = e.payload as Record<string, unknown>;
            const c = payload?.customer as Record<string, unknown> | undefined;
            if (c?.phone) return c.phone;
            const phoneNumbers = c?.phone_numbers as Array<{phonenumber?: string}> | undefined;
            if (Array.isArray(phoneNumbers) && phoneNumbers[0]?.phonenumber)
              return phoneNumbers[0].phonenumber;
            return payload?.phone;
          })
          .find(Boolean) || null;
      if (fromEvents) suggestions.phone = String(fromEvents).replace(/\D/g, "");
    }
    if (!customer.last_vin && vehicles[0]?.vin) suggestions.lastVin = vehicles[0].vin;
    if (customer.last_mileage == null && (vehicles[0]?.last_mileage ?? repairOrders[0]?.odometer_in) != null) {
      suggestions.lastMileage = vehicles[0]?.last_mileage ?? repairOrders[0]?.odometer_in;
    }

    return NextResponse.json({
      ok: true,
      customer: {
        id: customer.id,
        name: customer.name ?? null,
        firstName: customer.first_name ?? null,
        lastName: customer.last_name ?? null,
        email: customer.email ?? null,
        phone: customer.phone ?? null,
        lastVin: customer.last_vin ?? null,
        lastRo: customer.last_ro ?? null,
        lastMileage: customer.last_mileage ?? null,
        status: customer.status ?? null,
        updatedAt: customer.updated_at ?? null,
      },
      vehicles: vehicles.map(v => ({
        id: v.id,
        year: v.year,
        make: v.make,
        model: v.model,
        vin: v.vin,
        lastMileage: v.last_mileage,
        updatedAt: v.updated_at,
      })),
      repairOrders: repairOrders.map(ro => ({
        id: ro.id,
        roNumber: ro.order_number,
        vin: null,
        mileage: ro.odometer_in,
        status: ro.status,
        updatedAt: ro.updated_at,
      })),
      recentAutoflowEvents: recentEvents.map(e => ({
        payload: e.payload,
        receivedAt: e.received_at,
      })),
      suggestions,
    });
  } catch (err) {
    console.error("inspect error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
