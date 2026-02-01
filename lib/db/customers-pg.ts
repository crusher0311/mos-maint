import sql from "@/lib/db/postgres";

export interface Customer {
  id: string;
  shop_id: string;
  external_id: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  last_ro: string | null;
  last_vin: string | null;
  last_mileage: number | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export async function getCustomerById(customerId: string): Promise<Customer | null> {
  const customers = await sql<Customer[]>`
    SELECT * FROM customers WHERE id = ${customerId} LIMIT 1
  `;
  return customers[0] || null;
}

export async function getCustomerByExternalId(shopId: string, externalId: string): Promise<Customer | null> {
  const customers = await sql<Customer[]>`
    SELECT * FROM customers 
    WHERE shop_id = ${shopId} AND external_id = ${externalId} 
    LIMIT 1
  `;
  return customers[0] || null;
}

export async function getCustomerByEmail(shopId: string, email: string): Promise<Customer | null> {
  const customers = await sql<Customer[]>`
    SELECT * FROM customers 
    WHERE shop_id = ${shopId} AND LOWER(email) = LOWER(${email}) 
    LIMIT 1
  `;
  return customers[0] || null;
}

export async function getCustomerByPhone(shopId: string, phone: string): Promise<Customer | null> {
  const digits = phone.replace(/\D/g, "");
  const customers = await sql<Customer[]>`
    SELECT * FROM customers 
    WHERE shop_id = ${shopId} AND phone = ${digits} 
    LIMIT 1
  `;
  return customers[0] || null;
}

export async function getCustomersForShop(shopId: string, limit = 50, offset = 0): Promise<Customer[]> {
  return sql<Customer[]>`
    SELECT * FROM customers 
    WHERE shop_id = ${shopId}
    ORDER BY updated_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function getOpenCustomersForDashboard(shopId: string, limit = 50): Promise<Customer[]> {
  const closedStatuses = ['closed', 'Close', 'CLOSED', 'Appointment'];
  return sql<Customer[]>`
    SELECT c.* FROM customers c
    WHERE c.shop_id = ${shopId}
      AND (c.status IS NULL OR c.status NOT IN (${sql(closedStatuses)}))
      AND c.last_vin IS NOT NULL AND c.last_vin != ''
    ORDER BY c.updated_at DESC
    LIMIT ${limit}
  `;
}

export async function upsertCustomer(
  shopId: string,
  data: {
    externalId?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    status?: string | null;
    lastRo?: string | null;
    lastVin?: string | null;
    lastMileage?: number | null;
    source?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<Customer> {
  const now = new Date();
  const normalizedPhone = data.phone?.replace(/\D/g, "") || null;
  const normalizedEmail = data.email?.trim().toLowerCase() || null;
  
  let derivedName = data.name;
  if (!derivedName) {
    const parts = [data.firstName, data.lastName].filter(Boolean);
    derivedName = parts.length > 0 ? parts.join(" ") : null;
  }

  const customers = await sql<Customer[]>`
    INSERT INTO customers (
      id, shop_id, external_id, first_name, last_name, name, email, phone,
      status, last_ro, last_vin, last_mileage, source, metadata, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), ${shopId}, ${data.externalId || null}, 
      ${data.firstName || null}, ${data.lastName || null}, ${derivedName},
      ${normalizedEmail}, ${normalizedPhone}, ${data.status || null},
      ${data.lastRo || null}, ${data.lastVin || null}, ${data.lastMileage || null},
      ${data.source || null}, ${data.metadata ? JSON.stringify(data.metadata) : null}::jsonb,
      ${now}, ${now}
    )
    ON CONFLICT (shop_id, external_id) WHERE external_id IS NOT NULL
    DO UPDATE SET
      first_name = COALESCE(EXCLUDED.first_name, customers.first_name),
      last_name = COALESCE(EXCLUDED.last_name, customers.last_name),
      name = COALESCE(EXCLUDED.name, customers.name),
      email = COALESCE(EXCLUDED.email, customers.email),
      phone = COALESCE(EXCLUDED.phone, customers.phone),
      status = COALESCE(EXCLUDED.status, customers.status),
      last_ro = COALESCE(EXCLUDED.last_ro, customers.last_ro),
      last_vin = COALESCE(EXCLUDED.last_vin, customers.last_vin),
      last_mileage = COALESCE(EXCLUDED.last_mileage, customers.last_mileage),
      source = COALESCE(EXCLUDED.source, customers.source),
      updated_at = ${now}
    RETURNING *
  `;
  
  return customers[0];
}

export async function updateCustomer(
  customerId: string,
  updates: Partial<Omit<Customer, 'id' | 'shop_id' | 'created_at'>>
): Promise<Customer | null> {
  const firstName = updates.first_name ?? null;
  const lastName = updates.last_name ?? null;
  const name = updates.name ?? null;
  const email = updates.email ?? null;
  const phone = updates.phone ?? null;
  const status = updates.status ?? null;
  const lastRo = updates.last_ro ?? null;
  const lastVin = updates.last_vin ?? null;
  const lastMileage = updates.last_mileage ?? null;
  const metadata = updates.metadata ? JSON.stringify(updates.metadata) : null;

  const customers = await sql<Customer[]>`
    UPDATE customers
    SET 
      first_name = COALESCE(${firstName}, first_name),
      last_name = COALESCE(${lastName}, last_name),
      name = COALESCE(${name}, name),
      email = COALESCE(${email}, email),
      phone = COALESCE(${phone}, phone),
      status = COALESCE(${status}, status),
      last_ro = COALESCE(${lastRo}, last_ro),
      last_vin = COALESCE(${lastVin}, last_vin),
      last_mileage = COALESCE(${lastMileage}, last_mileage),
      metadata = COALESCE(${metadata}::jsonb, metadata),
      updated_at = NOW()
    WHERE id = ${customerId}
    RETURNING *
  `;
  return customers[0] || null;
}

export async function searchCustomers(
  shopId: string,
  query: string,
  limit = 20
): Promise<Customer[]> {
  const searchTerm = `%${query}%`;
  return sql<Customer[]>`
    SELECT * FROM customers
    WHERE shop_id = ${shopId}
      AND (
        name ILIKE ${searchTerm}
        OR email ILIKE ${searchTerm}
        OR phone ILIKE ${searchTerm}
        OR last_vin ILIKE ${searchTerm}
      )
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
}
