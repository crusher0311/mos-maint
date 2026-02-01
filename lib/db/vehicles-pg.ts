import sql from "@/lib/db/postgres";

export interface Vehicle {
  id: string;
  shop_id: string;
  customer_id: string | null;
  vin: string;
  year: number | null;
  make: string | null;
  model: string | null;
  submodel: string | null;
  engine: string | null;
  transmission: string | null;
  drivetrain: string | null;
  license_plate: string | null;
  color: string | null;
  last_mileage: number | null;
  external_id: string | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export async function getVehicleById(vehicleId: string): Promise<Vehicle | null> {
  const vehicles = await sql<Vehicle[]>`
    SELECT * FROM vehicles WHERE id = ${vehicleId} LIMIT 1
  `;
  return vehicles[0] || null;
}

export async function getVehicleByVin(shopId: string, vin: string): Promise<Vehicle | null> {
  const normalizedVin = vin.toUpperCase().trim();
  const vehicles = await sql<Vehicle[]>`
    SELECT * FROM vehicles 
    WHERE shop_id = ${shopId} AND vin = ${normalizedVin}
    LIMIT 1
  `;
  return vehicles[0] || null;
}

export async function getVehiclesForCustomer(customerId: string): Promise<Vehicle[]> {
  return sql<Vehicle[]>`
    SELECT * FROM vehicles 
    WHERE customer_id = ${customerId}
    ORDER BY updated_at DESC
  `;
}

export async function getVehiclesForShop(shopId: string, limit = 50, offset = 0): Promise<Vehicle[]> {
  return sql<Vehicle[]>`
    SELECT * FROM vehicles 
    WHERE shop_id = ${shopId}
    ORDER BY updated_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function upsertVehicle(
  shopId: string,
  vin: string,
  data: {
    customerId?: string | null;
    year?: number | null;
    make?: string | null;
    model?: string | null;
    submodel?: string | null;
    engine?: string | null;
    transmission?: string | null;
    drivetrain?: string | null;
    licensePlate?: string | null;
    color?: string | null;
    lastMileage?: number | null;
    externalId?: string | null;
    source?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<Vehicle> {
  const now = new Date();
  const normalizedVin = vin.toUpperCase().trim();

  const vehicles = await sql<Vehicle[]>`
    INSERT INTO vehicles (
      id, shop_id, customer_id, vin, year, make, model, submodel,
      engine, transmission, drivetrain, license_plate, color,
      last_mileage, external_id, source, metadata, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), ${shopId}, ${data.customerId || null}, ${normalizedVin},
      ${data.year || null}, ${data.make || null}, ${data.model || null}, ${data.submodel || null},
      ${data.engine || null}, ${data.transmission || null}, ${data.drivetrain || null},
      ${data.licensePlate || null}, ${data.color || null}, ${data.lastMileage || null},
      ${data.externalId || null}, ${data.source || null},
      ${data.metadata ? JSON.stringify(data.metadata) : null}::jsonb,
      ${now}, ${now}
    )
    ON CONFLICT (shop_id, vin)
    DO UPDATE SET
      customer_id = COALESCE(EXCLUDED.customer_id, vehicles.customer_id),
      year = COALESCE(EXCLUDED.year, vehicles.year),
      make = COALESCE(EXCLUDED.make, vehicles.make),
      model = COALESCE(EXCLUDED.model, vehicles.model),
      submodel = COALESCE(EXCLUDED.submodel, vehicles.submodel),
      engine = COALESCE(EXCLUDED.engine, vehicles.engine),
      transmission = COALESCE(EXCLUDED.transmission, vehicles.transmission),
      drivetrain = COALESCE(EXCLUDED.drivetrain, vehicles.drivetrain),
      license_plate = COALESCE(EXCLUDED.license_plate, vehicles.license_plate),
      color = COALESCE(EXCLUDED.color, vehicles.color),
      last_mileage = COALESCE(EXCLUDED.last_mileage, vehicles.last_mileage),
      external_id = COALESCE(EXCLUDED.external_id, vehicles.external_id),
      source = COALESCE(EXCLUDED.source, vehicles.source),
      updated_at = ${now}
    RETURNING *
  `;
  
  return vehicles[0];
}

export async function updateVehicle(
  vehicleId: string,
  updates: Partial<Omit<Vehicle, 'id' | 'shop_id' | 'vin' | 'created_at'>>
): Promise<Vehicle | null> {
  const customerId = updates.customer_id ?? null;
  const year = updates.year ?? null;
  const make = updates.make ?? null;
  const model = updates.model ?? null;
  const submodel = updates.submodel ?? null;
  const engine = updates.engine ?? null;
  const transmission = updates.transmission ?? null;
  const drivetrain = updates.drivetrain ?? null;
  const licensePlate = updates.license_plate ?? null;
  const color = updates.color ?? null;
  const lastMileage = updates.last_mileage ?? null;
  const metadata = updates.metadata ? JSON.stringify(updates.metadata) : null;

  const vehicles = await sql<Vehicle[]>`
    UPDATE vehicles
    SET 
      customer_id = COALESCE(${customerId}, customer_id),
      year = COALESCE(${year}, year),
      make = COALESCE(${make}, make),
      model = COALESCE(${model}, model),
      submodel = COALESCE(${submodel}, submodel),
      engine = COALESCE(${engine}, engine),
      transmission = COALESCE(${transmission}, transmission),
      drivetrain = COALESCE(${drivetrain}, drivetrain),
      license_plate = COALESCE(${licensePlate}, license_plate),
      color = COALESCE(${color}, color),
      last_mileage = COALESCE(${lastMileage}, last_mileage),
      metadata = COALESCE(${metadata}::jsonb, metadata),
      updated_at = NOW()
    WHERE id = ${vehicleId}
    RETURNING *
  `;
  return vehicles[0] || null;
}

export async function searchVehicles(
  shopId: string,
  query: string,
  limit = 20
): Promise<Vehicle[]> {
  const searchTerm = `%${query}%`;
  return sql<Vehicle[]>`
    SELECT * FROM vehicles
    WHERE shop_id = ${shopId}
      AND (
        vin ILIKE ${searchTerm}
        OR make ILIKE ${searchTerm}
        OR model ILIKE ${searchTerm}
        OR license_plate ILIKE ${searchTerm}
      )
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
}

export async function getRecentVehiclesByVin(shopId: string, vins: string[]): Promise<Vehicle[]> {
  if (vins.length === 0) return [];
  const normalizedVins = vins.map(v => v.toUpperCase().trim());
  return sql<Vehicle[]>`
    SELECT * FROM vehicles
    WHERE shop_id = ${shopId} AND vin = ANY(${normalizedVins})
    ORDER BY updated_at DESC
  `;
}
