import sql from "@/lib/db/postgres";

export interface ProtractorWorkOrder {
  id: string;
  shop_id: string;
  external_shop_id: number | null;
  work_order_id: string;
  work_order_number: string | null;
  vin: string | null;
  status: string | null;
  customer_id: string | null;
  vehicle_id: string | null;
  customer_name: string | null;
  vehicle_year: number | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  mileage: number | null;
  created_date: Date | null;
  closed_date: Date | null;
  raw_data: Record<string, unknown> | null;
  synced_at: Date;
}

export async function upsertProtractorWorkOrder(
  shopUUID: string,
  externalShopId: number | null,
  data: {
    workOrderId: string;
    workOrderNumber?: string | null;
    vin?: string | null;
    status?: string | null;
    customerId?: string | null;
    vehicleId?: string | null;
    customerName?: string | null;
    vehicleYear?: number | null;
    vehicleMake?: string | null;
    vehicleModel?: string | null;
    mileage?: number | null;
    createdDate?: Date | null;
    closedDate?: Date | null;
    rawData?: Record<string, unknown> | null;
  }
): Promise<ProtractorWorkOrder> {
  const now = new Date();
  const normalizedVin = data.vin?.toUpperCase().trim() || null;

  const orders = await sql<ProtractorWorkOrder[]>`
    INSERT INTO protractor_work_orders (
      id, shop_id, external_shop_id, work_order_id, work_order_number,
      vin, status, customer_id, vehicle_id, customer_name,
      vehicle_year, vehicle_make, vehicle_model, mileage,
      created_date, closed_date, raw_data, synced_at
    ) VALUES (
      gen_random_uuid(),
      ${shopUUID},
      ${externalShopId},
      ${data.workOrderId},
      ${data.workOrderNumber || null},
      ${normalizedVin},
      ${data.status || null},
      ${data.customerId || null},
      ${data.vehicleId || null},
      ${data.customerName || null},
      ${data.vehicleYear || null},
      ${data.vehicleMake || null},
      ${data.vehicleModel || null},
      ${data.mileage || null},
      ${data.createdDate || null},
      ${data.closedDate || null},
      ${data.rawData ? JSON.stringify(data.rawData) : null}::jsonb,
      ${now}
    )
    ON CONFLICT (shop_id, work_order_id)
    DO UPDATE SET
      work_order_number = COALESCE(EXCLUDED.work_order_number, protractor_work_orders.work_order_number),
      vin = COALESCE(EXCLUDED.vin, protractor_work_orders.vin),
      status = COALESCE(EXCLUDED.status, protractor_work_orders.status),
      customer_id = COALESCE(EXCLUDED.customer_id, protractor_work_orders.customer_id),
      vehicle_id = COALESCE(EXCLUDED.vehicle_id, protractor_work_orders.vehicle_id),
      customer_name = COALESCE(EXCLUDED.customer_name, protractor_work_orders.customer_name),
      vehicle_year = COALESCE(EXCLUDED.vehicle_year, protractor_work_orders.vehicle_year),
      vehicle_make = COALESCE(EXCLUDED.vehicle_make, protractor_work_orders.vehicle_make),
      vehicle_model = COALESCE(EXCLUDED.vehicle_model, protractor_work_orders.vehicle_model),
      mileage = COALESCE(EXCLUDED.mileage, protractor_work_orders.mileage),
      closed_date = COALESCE(EXCLUDED.closed_date, protractor_work_orders.closed_date),
      raw_data = COALESCE(EXCLUDED.raw_data, protractor_work_orders.raw_data),
      synced_at = ${now}
    RETURNING *
  `;
  
  return orders[0];
}

export async function getProtractorWorkOrder(
  shopId: string,
  workOrderId: string
): Promise<ProtractorWorkOrder | null> {
  const orders = await sql<ProtractorWorkOrder[]>`
    SELECT * FROM protractor_work_orders
    WHERE shop_id = ${shopId} AND work_order_id = ${workOrderId}
    LIMIT 1
  `;
  return orders[0] || null;
}

export async function getProtractorWorkOrdersByVin(
  shopId: string,
  vin: string,
  limit = 50
): Promise<ProtractorWorkOrder[]> {
  const normalizedVin = vin.toUpperCase().trim();
  return sql<ProtractorWorkOrder[]>`
    SELECT * FROM protractor_work_orders
    WHERE shop_id = ${shopId} AND vin = ${normalizedVin}
    ORDER BY created_date DESC NULLS LAST, synced_at DESC
    LIMIT ${limit}
  `;
}

export async function getOpenProtractorWorkOrders(
  shopId: string,
  limit = 100
): Promise<ProtractorWorkOrder[]> {
  return sql<ProtractorWorkOrder[]>`
    SELECT * FROM protractor_work_orders
    WHERE shop_id = ${shopId}
    AND closed_date IS NULL
    AND (status IS NULL OR status NOT IN ('Closed', 'Invoiced', 'Posted', 'Void'))
    ORDER BY created_date DESC NULLS LAST, synced_at DESC
    LIMIT ${limit}
  `;
}

export async function deleteProtractorWorkOrder(
  shopId: string,
  workOrderId: string
): Promise<void> {
  await sql`
    DELETE FROM protractor_work_orders
    WHERE shop_id = ${shopId} AND work_order_id = ${workOrderId}
  `;
}

export async function getActiveProtractorWorkOrdersForShop(
  shopUUID: string,
  limit = 200
): Promise<ProtractorWorkOrder[]> {
  return sql<ProtractorWorkOrder[]>`
    SELECT * FROM protractor_work_orders
    WHERE shop_id = ${shopUUID}
    AND closed_date IS NULL
    AND (status IS NULL OR status NOT IN ('Closed', 'Invoiced', 'Posted', 'Void'))
    ORDER BY created_date DESC NULLS LAST
    LIMIT ${limit}
  `;
}
