import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, ctx: { params: { customerId: string } }) {
  try {
    const id = ctx.params?.customerId;
    if (!id || !ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid customerId" }, { status: 400 });
    }

    const db = await getDb();
    const _id = new ObjectId(id);

    const customer = await db.collection("customers").findOne({ _id });
    if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const [vehicle, ro, recentEvents] = await Promise.all([
      db
        .collection("vehicles")
        .find({ customerId: _id })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(3)
        .project({ year: 1, make: 1, model: 1, vin: 1, lastMileage: 1, updatedAt: 1 })
        .toArray(),
      db
        .collection("repair_orders")
        .find({ customerId: _id })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(5)
        .project({ roNumber: 1, vin: 1, mileage: 1, status: 1, updatedAt: 1 })
        .toArray(),
      db
        .collection("events")
        .find({
          provider: "autoflow",
          shopId: customer.shopId,
          receivedAt: { $gte: new Date(Date.now() - 1000 * 60 * 60 * 24 * 90) }, // last 90d
        })
        .sort({ receivedAt: -1 })
        .limit(20)
        .project({ payload: 1, receivedAt: 1 })
        .toArray(),
    ]);

    // Very light “suggestions” based on what we see
    const suggestions: Record<string, any> = {};
    if (!customer.name && (customer.firstName || customer.lastName)) {
      suggestions.name = [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim();
    }
    if (!customer.email) {
      const fromEvents = recentEvents
        .map(e => e?.payload?.customer?.email || e?.payload?.email)
        .find(Boolean);
      if (fromEvents) suggestions.email = String(fromEvents).toLowerCase();
    }
    if (!customer.phone) {
      const fromEvents =
        recentEvents
          .map(e => {
            const c = e?.payload?.customer;
            if (c?.phone) return c.phone;
            if (Array.isArray(c?.phone_numbers) && c.phone_numbers[0]?.phonenumber)
              return c.phone_numbers[0].phonenumber;
            return e?.payload?.phone;
          })
          .find(Boolean) || null;
      if (fromEvents) suggestions.phone = String(fromEvents).replace(/\D/g, "");
    }
    if (!customer.lastVin && vehicle[0]?.vin) suggestions.lastVin = vehicle[0].vin;
    if (customer.lastMileage == null && (vehicle[0]?.lastMileage ?? ro[0]?.mileage) != null) {
      suggestions.lastMileage = vehicle[0]?.lastMileage ?? ro[0]?.mileage;
    }

    return NextResponse.json({
      ok: true,
      customer: {
        _id: customer._id,
        name: customer.name ?? null,
        firstName: customer.firstName ?? null,
        lastName: customer.lastName ?? null,
        email: customer.email ?? null,
        phone: customer.phone ?? null,
        lastVin: customer.lastVin ?? null,
        lastRo: customer.lastRo ?? null,
        lastMileage: customer.lastMileage ?? null,
        status: customer.status ?? null,
        updatedAt: customer.updatedAt ?? null,
      },
      vehicles: vehicle,
      repairOrders: ro,
      recentAutoflowEvents: recentEvents,
      suggestions,
    });
  } catch (err) {
    console.error("inspect error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
