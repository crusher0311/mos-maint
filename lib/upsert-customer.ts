// lib/upsert-customer.ts
import { Db } from "mongodb";

export async function upsertCustomerFromEvent(db: Db, shopId: number, payload: any) {
  const p = payload || {};
  const t = p.ticket || (p.payload && p.payload.ticket) || {};
  const c = p.customer || (t.customer ? { name: t.customer.name } : {}) || {};
  const v = p.vehicle  || (t.vehicle  ? t.vehicle : {}) || {};

  const name =
    [c.firstname, c.lastname].filter(Boolean).join(" ") ||
    c.name || "Unknown";

  const phone =
    (Array.isArray(c.phone_numbers) && c.phone_numbers[0]?.phonenumber) ||
    c.phone || null;

  const vehicle = {
    year: Number(v.year) || null,
    make: String(v.make || ""),
    model: String(v.model || ""),
    vin: v.vin || null,
    license: v.license || null,
    odometer: v.odometer
      ? Number(String(v.odometer).replace(/,/g, ""))
      : (t.mileage || null),
  };

  const doc = {
    shopId,
    name,
    emailLower: (c.email || "").toLowerCase() || null,
    phone,
    lastTicketId: String(t.id || t.remote_id || t.invoice || ""),
    lastStatus: t.status || (p.event && p.event.type) || null,
    vehicle,
    updatedAt: new Date(),
  };

  const match =
    vehicle.vin ? { shopId, "vehicle.vin": vehicle.vin } :
    phone       ? { shopId, phone } :
                  { shopId, name };

  await db.collection("customers").updateOne(
    match,
    { $set: doc, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
}
