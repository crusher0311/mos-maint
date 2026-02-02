// app/api/customers/[customerId]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: { customerId?: string } }
) {
  const id = ctx.params?.customerId;
  if (!id) {
    return NextResponse.json({ error: "missing customerId" }, { status: 400 });
  }
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const _id = new ObjectId(id);
  const db = await getDb();

  // -- Customer ------------------------------------------------------------
  const customer = await db.collection("customers").findOne(
    { _id },
    {
      // project commonly-used fields; include others as needed
      projection: {
        _id: 1,
        shopId: 1,
        name: 1,
        firstName: 1,
        lastName: 1,
        email: 1,
        phone: 1,
        externalId: 1,
        lastVin: 1,
        lastRo: 1,
        lastMileage: 1,
        status: 1,
        openedAt: 1,
        updatedAt: 1,
        createdAt: 1,
      },
    }
  );

  if (!customer) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // -- Vehicles (latest first) --------------------------------------------
  const vehicles = await db
    .collection("vehicles")
    .find({ customerId: _id })
    .project({
      _id: 1,
      vin: 1,
      year: 1,
      make: 1,
      model: 1,
      lastMileage: 1,
      updatedAt: 1,
    })
    .sort({ updatedAt: -1, createdAt: -1 })
    .toArray();

  // -- Repair Orders (latest first) ---------------------------------------
  const repairOrders = await db
    .collection("repair_orders")
    .find({ customerId: _id })
    .project({
      _id: 1,
      roNumber: 1,
      vin: 1,
      mileage: 1,
      status: 1,
      updatedAt: 1,
    })
    .sort({ updatedAt: -1, createdAt: -1 })
    .toArray();

  // -- Recent AutoFlow events (best-effort match) -------------------------
  const afOrs: any[] = [];
  const shopFilter =
    customer.shopId != null ? { shopId: customer.shopId } : {};

  if (customer.externalId) {
    afOrs.push({ "payload.customer.id": customer.externalId });
    afOrs.push({ "payload.customer.remote_id": customer.externalId });
  }
  if (customer.email) {
    afOrs.push({ "payload.customer.email": customer.email });
  }
  if (customer.phone) {
    afOrs.push({ "payload.customer.phone": customer.phone });
    afOrs.push({ "payload.customer.phone_numbers.phonenumber": customer.phone });
  }
  if (customer.firstName) {
    afOrs.push({ "payload.customer.firstname": customer.firstName });
  }
  if (customer.lastName) {
    afOrs.push({ "payload.customer.lastname": customer.lastName });
  }

  // If we have nothing to key on, show newest shop events instead to aid inspection.
  const afQuery =
    afOrs.length > 0
      ? { provider: "autoflow", ...shopFilter, $or: afOrs }
      : { provider: "autoflow", ...shopFilter };

  const recentAutoflowEvents = await db
    .collection("events")
    .find(afQuery)
    .project({ payload: 1, receivedAt: 1 })
    .sort({ receivedAt: -1 })
    .limit(25)
    .toArray();

  // -- Suggestions (fill obvious gaps) ------------------------------------
  const suggestions: Record<string, any> = {};

  if (!customer.phone) {
    const withPhone = recentAutoflowEvents.find(
      (e: any) => e?.payload?.customer?.phone_numbers?.length
    );
    const phone =
      withPhone?.payload?.customer?.phone_numbers?.[0]?.phonenumber ?? null;
    if (phone) suggestions.phone = phone;
  }

  if (!customer.name && (customer.firstName || customer.lastName)) {
    const joined = [customer.firstName ?? "", customer.lastName ?? ""]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (joined) suggestions.name = joined;
  }

  return NextResponse.json({
    ok: true,
    customer,
    vehicles,
    repairOrders,
    recentAutoflowEvents,
    suggestions,
  });
}
