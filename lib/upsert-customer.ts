import sql from "@/lib/db/postgres";

export async function upsertCustomerFromEvent(shopId: number | string, payload: Record<string, unknown>) {
  const p = payload || {};
  const t = (p.ticket as Record<string, unknown>) || 
    ((p.payload as Record<string, unknown>)?.ticket as Record<string, unknown>) || {};
  const c = (p.customer as Record<string, unknown>) || 
    (t.customer ? { name: (t.customer as Record<string, unknown>).name } : {});
  const v = (p.vehicle as Record<string, unknown>) || 
    (t.vehicle as Record<string, unknown>) || {};

  const cRecord = c as Record<string, unknown>;
  const vRecord = v as Record<string, unknown>;
  const tRecord = t as Record<string, unknown>;

  const name =
    [cRecord.firstname, cRecord.lastname].filter(Boolean).join(" ") ||
    (cRecord.name as string) || "Unknown";

  const phoneNumbers = cRecord.phone_numbers as Array<{phonenumber?: string}> | undefined;
  const phone =
    (Array.isArray(phoneNumbers) && phoneNumbers[0]?.phonenumber) ||
    (cRecord.phone as string) || null;

  const odometerRaw = vRecord.odometer;
  const odometerNum = odometerRaw
    ? Number(String(odometerRaw).replace(/,/g, ""))
    : (tRecord.mileage as number) || null;

  const vin = vRecord.vin ? String(vRecord.vin).toUpperCase() : null;
  const shopIdStr = String(shopId);
  const emailLower = ((cRecord.email as string) || "").toLowerCase() || null;
  const lastTicketId = String(tRecord.id || tRecord.remote_id || tRecord.invoice || "");
  const eventPayload = p.event as Record<string, unknown> | undefined;
  const lastStatus = (tRecord.status as string) || (eventPayload?.type as string) || null;

  const vehicleYear = Number(vRecord.year) || null;
  const vehicleMake = String(vRecord.make || "");
  const vehicleModel = String(vRecord.model || "");
  const vehicleLicense = (vRecord.license as string) || null;

  await sql`
    INSERT INTO customers (
      shop_id, name, email_lower, phone, 
      last_ticket_id, last_status,
      vehicle_year, vehicle_make, vehicle_model, vehicle_vin, vehicle_license, vehicle_odometer,
      created_at, updated_at
    ) VALUES (
      ${shopIdStr}, ${name}, ${emailLower}, ${phone},
      ${lastTicketId}, ${lastStatus},
      ${vehicleYear}, ${vehicleMake}, ${vehicleModel}, ${vin}, ${vehicleLicense}, ${odometerNum},
      NOW(), NOW()
    )
    ON CONFLICT (shop_id, COALESCE(vehicle_vin, ''), COALESCE(phone, ''), COALESCE(name, ''))
    DO UPDATE SET
      name = COALESCE(EXCLUDED.name, customers.name),
      email_lower = COALESCE(EXCLUDED.email_lower, customers.email_lower),
      phone = COALESCE(EXCLUDED.phone, customers.phone),
      last_ticket_id = COALESCE(EXCLUDED.last_ticket_id, customers.last_ticket_id),
      last_status = COALESCE(EXCLUDED.last_status, customers.last_status),
      vehicle_year = COALESCE(EXCLUDED.vehicle_year, customers.vehicle_year),
      vehicle_make = COALESCE(EXCLUDED.vehicle_make, customers.vehicle_make),
      vehicle_model = COALESCE(EXCLUDED.vehicle_model, customers.vehicle_model),
      vehicle_vin = COALESCE(EXCLUDED.vehicle_vin, customers.vehicle_vin),
      vehicle_license = COALESCE(EXCLUDED.vehicle_license, customers.vehicle_license),
      vehicle_odometer = COALESCE(EXCLUDED.vehicle_odometer, customers.vehicle_odometer),
      updated_at = NOW()
  `;
}
