import sql from "@/lib/db/postgres";

export interface ProtractorVehicle {
  id: string;
  shop_id: string;
  external_shop_id: number | null;
  vehicle_id: string;
  vin: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  license_plate: string | null;
  customer_id: string | null;
  raw_data: Record<string, unknown> | null;
  synced_at: Date;
}

export async function upsertProtractorVehicle(
  shopUUID: string,
  externalShopId: number | null,
  data: {
    vehicleId: string;
    vin?: string | null;
    year?: number | null;
    make?: string | null;
    model?: string | null;
    licensePlate?: string | null;
    customerId?: string | null;
    rawData?: Record<string, unknown> | null;
  }
): Promise<ProtractorVehicle> {
  const now = new Date();
  const normalizedVin = data.vin?.toUpperCase().trim() || null;

  const vehicles = await sql<ProtractorVehicle[]>`
    INSERT INTO protractor_vehicles (
      id, shop_id, external_shop_id, vehicle_id, vin,
      year, make, model, license_plate, customer_id,
      raw_data, synced_at
    ) VALUES (
      gen_random_uuid(),
      ${shopUUID},
      ${externalShopId},
      ${data.vehicleId},
      ${normalizedVin},
      ${data.year || null},
      ${data.make || null},
      ${data.model || null},
      ${data.licensePlate || null},
      ${data.customerId || null},
      ${data.rawData ? JSON.stringify(data.rawData) : null}::jsonb,
      ${now}
    )
    ON CONFLICT (shop_id, vehicle_id)
    DO UPDATE SET
      vin = COALESCE(EXCLUDED.vin, protractor_vehicles.vin),
      year = COALESCE(EXCLUDED.year, protractor_vehicles.year),
      make = COALESCE(EXCLUDED.make, protractor_vehicles.make),
      model = COALESCE(EXCLUDED.model, protractor_vehicles.model),
      license_plate = COALESCE(EXCLUDED.license_plate, protractor_vehicles.license_plate),
      customer_id = COALESCE(EXCLUDED.customer_id, protractor_vehicles.customer_id),
      raw_data = COALESCE(EXCLUDED.raw_data, protractor_vehicles.raw_data),
      synced_at = ${now}
    RETURNING *
  `;
  
  return vehicles[0];
}

export async function getProtractorVehicle(
  shopId: string,
  vehicleId: string
): Promise<ProtractorVehicle | null> {
  const vehicles = await sql<ProtractorVehicle[]>`
    SELECT * FROM protractor_vehicles
    WHERE shop_id = ${shopId} AND vehicle_id = ${vehicleId}
    LIMIT 1
  `;
  return vehicles[0] || null;
}

export async function getProtractorVehicleByVin(
  shopId: string,
  vin: string
): Promise<ProtractorVehicle | null> {
  const normalizedVin = vin.toUpperCase().trim();
  const vehicles = await sql<ProtractorVehicle[]>`
    SELECT * FROM protractor_vehicles
    WHERE shop_id = ${shopId} AND vin = ${normalizedVin}
    LIMIT 1
  `;
  return vehicles[0] || null;
}

export async function getProtractorVehiclesForCustomer(
  shopId: string,
  customerId: string
): Promise<ProtractorVehicle[]> {
  return sql<ProtractorVehicle[]>`
    SELECT * FROM protractor_vehicles
    WHERE shop_id = ${shopId} AND customer_id = ${customerId}
    ORDER BY synced_at DESC
  `;
}
