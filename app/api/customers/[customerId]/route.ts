// app/api/customers/[customerId]/route.ts
import { NextRequest, NextResponse } from "next/server";
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

export async function GET(
  _req: NextRequest,
  ctx: { params: { customerId?: string } }
) {
  const id = ctx.params?.customerId;
  if (!id) {
    return NextResponse.json({ error: "missing customerId" }, { status: 400 });
  }
  if (!isValidUUID(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const customer = await getCustomerById(id);

  if (!customer) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const vehicles = await getVehiclesByCustomerId(id);
  const repairOrders = await getWorkOrdersForCustomer(id);

  const recentAutoflowEvents = customer.shop_id ? await sql<{payload: Record<string, unknown>, received_at: Date}[]>`
    SELECT payload, received_at FROM events
    WHERE shop_id = ${customer.shop_id}
      AND provider = 'autoflow'
      AND (
        payload->'customer'->>'id' = ${customer.external_id || ''}
        OR payload->'customer'->>'email' = ${customer.email || ''}
        OR payload->'customer'->>'phone' = ${customer.phone || ''}
      )
    ORDER BY received_at DESC
    LIMIT 25
  ` : [];

  const suggestions: Record<string, unknown> = {};

  if (!customer.phone) {
    const withPhone = recentAutoflowEvents.find(
      (e) => {
        const payload = e.payload as Record<string, unknown>;
        const cust = payload?.customer as Record<string, unknown> | undefined;
        const phoneNumbers = cust?.phone_numbers as Array<{phonenumber?: string}> | undefined;
        return phoneNumbers && phoneNumbers.length > 0;
      }
    );
    if (withPhone) {
      const payload = withPhone.payload as Record<string, unknown>;
      const cust = payload?.customer as Record<string, unknown>;
      const phoneNumbers = cust?.phone_numbers as Array<{phonenumber?: string}>;
      const phone = phoneNumbers?.[0]?.phonenumber ?? null;
      if (phone) suggestions.phone = phone;
    }
  }

  if (!customer.name && (customer.first_name || customer.last_name)) {
    const joined = [customer.first_name ?? "", customer.last_name ?? ""]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (joined) suggestions.name = joined;
  }

  return NextResponse.json({
    ok: true,
    customer: {
      id: customer.id,
      shopId: customer.shop_id,
      name: customer.name,
      firstName: customer.first_name,
      lastName: customer.last_name,
      email: customer.email,
      phone: customer.phone,
      externalId: customer.external_id,
      lastVin: customer.last_vin,
      lastRo: customer.last_ro,
      lastMileage: customer.last_mileage,
      status: customer.status,
      updatedAt: customer.updated_at,
      createdAt: customer.created_at,
    },
    vehicles: vehicles.map(v => ({
      id: v.id,
      vin: v.vin,
      year: v.year,
      make: v.make,
      model: v.model,
      lastMileage: v.last_mileage,
      updatedAt: v.updated_at,
    })),
    repairOrders: repairOrders.map(wo => ({
      id: wo.id,
      roNumber: wo.order_number,
      vin: null,
      mileage: wo.odometer_in,
      status: wo.status,
      updatedAt: wo.updated_at,
    })),
    recentAutoflowEvents: recentAutoflowEvents.map(e => ({
      payload: e.payload,
      receivedAt: e.received_at,
    })),
    suggestions,
  });
}
