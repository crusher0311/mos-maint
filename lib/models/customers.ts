import sql from "@/lib/db/postgres";

type RawPayload = Record<string, unknown>;

function normalizeEmail(s?: unknown): string | null {
  if (!s) return null;
  const t = String(s).trim().toLowerCase();
  return t || null;
}

function normalizePhone(s?: unknown): string | null {
  if (!s) return null;
  const digits = String(s).replace(/\D/g, "");
  return digits || null;
}

function normalizeNumber(s?: unknown): number | null {
  if (s == null) return null;
  const n = Number(String(s).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function cleanPersonToken(s?: unknown): string | null {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  const cleaned = t.replace(/\*+$/g, "").trim();
  return cleaned || null;
}

function looksLikeCompany(s?: string | null): boolean {
  if (!s) return false;
  const x = s.toLowerCase();

  const keywords = [
    " llc", " inc", " co", " corp", " corporation", " company", " ltd", " llp",
    " laboratory", " laboratories", " clinic", " collision", " electric",
    " university", " hospital", " pathology", " services", " auto ", " repair",
  ];
  if (keywords.some((k) => x.includes(k))) return true;

  const wordCount = x.split(/\s+/).filter(Boolean).length;
  return wordCount >= 2;
}

const CLOSED_SET = ["closed", "Close", "CLOSED", "Appointment"] as const;

function extractCustomer(payload: RawPayload) {
  const a = (payload?.data as Record<string, unknown>)?.customer as Record<string, unknown> | undefined;
  const b = payload?.customer as Record<string, unknown> | undefined;

  let externalId: string | null = null;
  let first: string | null = null;
  let last: string | null = null;
  let email: string | null = null;
  let phone: string | null = null;
  let name: string | null = null;

  if (a) {
    externalId = a?.id != null ? String(a.id) : null;
    first = cleanPersonToken(a?.firstName);
    last  = cleanPersonToken(a?.lastName);
    email = normalizeEmail(a?.email);
    phone = normalizePhone(a?.phone);
    if (a?.name && String(a.name).trim()) name = String(a.name).trim();
  } else if (b) {
    externalId = b?.id != null ? String(b.id) : (b?.remote_id != null ? String(b.remote_id) : null);
    first = cleanPersonToken(b?.firstname);
    last  = cleanPersonToken(b?.lastname);

    if (Array.isArray(b?.phone_numbers) && b.phone_numbers.length > 0) {
      const mobile = (b.phone_numbers as Record<string, unknown>[]).find((p) => String(p?.phone_type).toUpperCase() === "M");
      const pick = mobile ?? b.phone_numbers[0];
      phone = normalizePhone((pick as Record<string, unknown>)?.phonenumber);
    }
    email = normalizeEmail(b?.email);
    if (b?.name && String(b.name).trim()) name = String(b.name).trim();
  }

  if (!name && !first && looksLikeCompany(last)) {
    name = last;
    last = null;
  }
  if (!name) {
    const joined = [first ?? "", last ?? ""].filter(Boolean).join(" ").trim();
    name = joined || null;
  }

  return { externalId, first, last, name, email, phone };
}

function extractVehicleTicket(payload: RawPayload) {
  const ticket = payload?.ticket as Record<string, unknown> | undefined;
  const vehicle = payload?.vehicle as Record<string, unknown> | undefined;

  const roNumber = ticket?.invoice ?? ticket?.id ?? null;
  const vin = vehicle?.vin ?? null;
  const mileage = normalizeNumber(vehicle?.odometer);
  const ticketStatus = ticket?.status ?? null;

  return {
    roNumber: roNumber != null ? String(roNumber) : null,
    vin: vin != null ? String(vin).toUpperCase() : null,
    mileage,
    ticketStatus: ticketStatus != null ? String(ticketStatus) : null,
    vehicleMeta: vehicle
      ? {
          year: normalizeNumber(vehicle.year) ?? undefined,
          make: vehicle.make as string | undefined,
          model: vehicle.model as string | undefined,
          license: vehicle.license as string | undefined,
        }
      : undefined,
  };
}

export async function upsertCustomerFromAutoflow(shopId: number | string, payload: RawPayload) {
  const shopIdStr = String(shopId);

  const { externalId, first, last, name, email, phone } = extractCustomer(payload);
  const { roNumber, vin, mileage, ticketStatus, vehicleMeta } = extractVehicleTicket(payload);

  const hasIdentity = Boolean(externalId || email || phone);
  const hasAnyName = Boolean(name || first || last);
  const hasUsefulVehicle = Boolean(vin || (vehicleMeta && (vehicleMeta.make || vehicleMeta.model)));
  const hasRO = Boolean(roNumber);
  if (!hasIdentity && !hasAnyName && !hasUsefulVehicle && !hasRO) {
    return { ok: true as const, customerId: null, vehicleId: null, roNumber: roNumber ?? null, mileage: mileage ?? null };
  }

  let customerId: string | null = null;

  if (externalId) {
    const existing = await sql`SELECT id FROM customers WHERE shop_id = ${shopIdStr} AND external_id = ${externalId} LIMIT 1`;
    if (existing.length > 0) customerId = existing[0].id;
  }
  if (!customerId && email) {
    const existing = await sql`SELECT id FROM customers WHERE shop_id = ${shopIdStr} AND email = ${email} LIMIT 1`;
    if (existing.length > 0) customerId = existing[0].id;
  }
  if (!customerId && phone) {
    const existing = await sql`SELECT id FROM customers WHERE shop_id = ${shopIdStr} AND phone = ${phone} LIMIT 1`;
    if (existing.length > 0) customerId = existing[0].id;
  }

  if (customerId) {
    await sql`
      UPDATE customers SET
        external_id = COALESCE(${externalId}, external_id),
        first_name = COALESCE(${first}, first_name),
        last_name = COALESCE(${last}, last_name),
        name = COALESCE(${name}, name),
        email = COALESCE(${email}, email),
        phone = COALESCE(${phone}, phone),
        last_ro = COALESCE(${roNumber}, last_ro),
        last_vin = COALESCE(${vin}, last_vin),
        last_mileage = COALESCE(${mileage}, last_mileage),
        last_status = COALESCE(${ticketStatus}, last_status),
        status = COALESCE(${ticketStatus}, status),
        source = 'autoflow',
        updated_at = NOW()
      WHERE id = ${customerId}::uuid
    `;
  } else {
    const result = await sql`
      INSERT INTO customers (shop_id, external_id, first_name, last_name, name, email, phone, last_ro, last_vin, last_mileage, last_status, status, source, created_by)
      VALUES (${shopIdStr}, ${externalId}, ${first}, ${last}, ${name}, ${email}, ${phone}, ${roNumber}, ${vin}, ${mileage}, ${ticketStatus}, ${ticketStatus || 'open'}, 'autoflow', 'autoflow-webhook')
      RETURNING id
    `;
    customerId = result[0]?.id;
  }

  let vehicleId: string | null = null;
  if (vin && customerId) {
    const existingVehicle = await sql`SELECT id FROM vehicles WHERE shop_id = ${shopIdStr} AND vin = ${vin} LIMIT 1`;
    
    if (existingVehicle.length > 0) {
      vehicleId = existingVehicle[0].id;
      await sql`
        UPDATE vehicles SET
          customer_id = ${customerId}::uuid,
          customer_external_id = ${externalId},
          mileage = COALESCE(${mileage}, mileage),
          year = COALESCE(${vehicleMeta?.year || null}, year),
          make = COALESCE(${vehicleMeta?.make || null}, make),
          model = COALESCE(${vehicleMeta?.model || null}, model),
          source = 'autoflow',
          updated_at = NOW()
        WHERE id = ${vehicleId}::uuid
      `;
    } else {
      const result = await sql`
        INSERT INTO vehicles (shop_id, vin, customer_id, customer_external_id, mileage, year, make, model, source)
        VALUES (${shopIdStr}, ${vin}, ${customerId}::uuid, ${externalId}, ${mileage}, ${vehicleMeta?.year || null}, ${vehicleMeta?.make || null}, ${vehicleMeta?.model || null}, 'autoflow')
        RETURNING id
      `;
      vehicleId = result[0]?.id;
    }
  }

  if (roNumber && customerId) {
    await sql`
      INSERT INTO repair_orders (shop_id, ro_number, customer_id, customer_external_id, vehicle_id, vin, mileage, status, source)
      VALUES (${shopIdStr}, ${roNumber}, ${customerId}::uuid, ${externalId}, ${vehicleId ? sql`${vehicleId}::uuid` : null}, ${vin}, ${mileage}, ${ticketStatus}, 'autoflow')
      ON CONFLICT (shop_id, ro_number) DO UPDATE SET
        customer_id = ${customerId}::uuid,
        customer_external_id = ${externalId},
        vehicle_id = COALESCE(${vehicleId ? sql`${vehicleId}::uuid` : null}, repair_orders.vehicle_id),
        vin = COALESCE(${vin}, repair_orders.vin),
        mileage = COALESCE(${mileage}, repair_orders.mileage),
        status = COALESCE(${ticketStatus}, repair_orders.status),
        updated_at = NOW()
    `;
  }

  return { ok: true as const, customerId, vehicleId, roNumber: roNumber ?? null, mileage: mileage ?? null };
}

export async function upsertCustomerFromAutoflowEvent(payload: RawPayload, shopIdRaw: string | number) {
  const shopIdStr = String(shopIdRaw);

  const customer = payload?.customer as Record<string, unknown> | undefined;
  const ticket = payload?.ticket as Record<string, unknown> | undefined;
  const vehicle = payload?.vehicle as Record<string, unknown> | undefined;

  const externalId =
    (customer?.id != null ? String(customer.id) : null) ??
    (payload?.customerId != null ? String(payload.customerId) : null) ??
    null;

  const firstName = cleanPersonToken(customer?.firstName) ?? cleanPersonToken(payload?.firstName) ?? null;
  const lastName = cleanPersonToken(customer?.lastName) ?? cleanPersonToken(payload?.lastName) ?? null;

  let derivedName: string | null = null;
  if (customer?.name && String(customer.name).trim()) {
    derivedName = String(customer.name).trim();
  } else if (payload?.name && String(payload.name).trim()) {
    derivedName = String(payload.name).trim();
  }
  
  if (!derivedName) {
    const joined = [firstName ?? "", lastName ?? ""].filter(Boolean).join(" ").trim();
    if (joined) derivedName = joined;
    else if (!firstName && looksLikeCompany(lastName)) derivedName = lastName;
    else derivedName = "(no name)";
  }

  const email = normalizeEmail(customer?.email ?? payload?.email);
  let phone = normalizePhone(customer?.phone ?? payload?.phone);
  if (!phone && Array.isArray(customer?.phone_numbers) && (customer.phone_numbers as unknown[]).length) {
    const phoneNumbers = customer.phone_numbers as Record<string, unknown>[];
    const mobile = phoneNumbers.find((p) => String(p?.phone_type).toUpperCase() === "M");
    const pick = mobile ?? phoneNumbers[0];
    phone = normalizePhone(pick?.phonenumber);
  }

  const ro = ticket?.invoice != null ? String(ticket.invoice) : (ticket?.id != null ? String(ticket.id) : null);
  const rawStatus = ticket?.status ? String(ticket.status) : null;
  const vin = vehicle?.vin ? String(vehicle.vin).toUpperCase() : null;
  const odometer = normalizeNumber(vehicle?.odometer);

  let customerId: string | null = null;

  if (externalId) {
    const existing = await sql`SELECT id FROM customers WHERE shop_id = ${shopIdStr} AND external_id = ${externalId} LIMIT 1`;
    if (existing.length > 0) customerId = existing[0].id;
  }
  if (!customerId && email) {
    const existing = await sql`SELECT id FROM customers WHERE shop_id = ${shopIdStr} AND email = ${email} LIMIT 1`;
    if (existing.length > 0) customerId = existing[0].id;
  }
  if (!customerId && phone) {
    const existing = await sql`SELECT id FROM customers WHERE shop_id = ${shopIdStr} AND phone = ${phone} LIMIT 1`;
    if (existing.length > 0) customerId = existing[0].id;
  }

  if (customerId) {
    await sql`
      UPDATE customers SET
        external_id = COALESCE(${externalId}, external_id),
        name = COALESCE(${derivedName}, name),
        first_name = COALESCE(${firstName}, first_name),
        last_name = COALESCE(${lastName}, last_name),
        email = COALESCE(${email}, email),
        phone = COALESCE(${phone}, phone),
        provider = 'autoflow',
        last_ticket_id = COALESCE(${ro}, last_ticket_id),
        last_status = COALESCE(${rawStatus}, last_status),
        status = COALESCE(${rawStatus}, status),
        last_vin = COALESCE(${vin}, last_vin),
        last_mileage = COALESCE(${odometer}, last_mileage),
        last_event_at = NOW(),
        updated_at = NOW()
      WHERE id = ${customerId}::uuid
    `;
  } else {
    await sql`
      INSERT INTO customers (shop_id, external_id, name, first_name, last_name, email, phone, provider, last_ticket_id, last_status, status, last_vin, last_mileage, opened_at)
      VALUES (${shopIdStr}, ${externalId}, ${derivedName}, ${firstName}, ${lastName}, ${email}, ${phone}, 'autoflow', ${ro}, ${rawStatus}, ${rawStatus || 'open'}, ${vin}, ${odometer}, NOW())
    `;
  }
}

export type OpenCustomer = {
  id: string;
  shopId: string;
  name?: string | null;
  lastStatus?: string | null;
  status?: string | null;
  lastTicketId?: string | null;
  updatedAt?: Date;
  vehicle?: {
    year?: number | null;
    make?: string | null;
    model?: string | null;
    vin?: string | null;
    odometer?: number | null;
    license?: string | null;
  };
};

export async function getOpenCustomersForDashboard(shopIdInput: number | string, limit = 50): Promise<OpenCustomer[]> {
  const shopIdStr = String(shopIdInput);

  const customers = await sql`
    SELECT c.id, c.shop_id, c.name, c.status, c.last_status, c.last_ticket_id, c.updated_at,
           v.year, v.make, v.model, v.vin, v.mileage as odometer, v.license_plate as license
    FROM customers c
    LEFT JOIN vehicles v ON v.customer_id = c.id
    WHERE c.shop_id = ${shopIdStr}
      AND c.status NOT IN ('closed', 'Close', 'CLOSED', 'Appointment')
      AND v.vin IS NOT NULL AND v.vin != ''
    ORDER BY c.updated_at DESC
    LIMIT ${limit}
  `;

  return customers.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    shopId: String(row.shop_id),
    name: row.name as string | null,
    lastStatus: row.last_status as string | null,
    status: row.status as string | null,
    lastTicketId: row.last_ticket_id as string | null,
    updatedAt: row.updated_at as Date,
    vehicle: {
      year: row.year as number | null,
      make: row.make as string | null,
      model: row.model as string | null,
      vin: row.vin as string | null,
      odometer: row.odometer as number | null,
      license: row.license as string | null,
    },
  }));
}
