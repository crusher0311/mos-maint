import sql from "@/lib/db/postgres";

export interface TekmetricWorkOrder {
  id: string;
  shop_id: string;
  external_shop_id: number;
  work_order_id: string;
  work_order_number: string | null;
  vin: string | null;
  status: string | null;
  status_code: string | null;
  label: string | null;
  label_color: string | null;
  customer_id: number | null;
  vehicle_id: number | null;
  customer_name: string | null;
  vehicle_year: number | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_submodel: string | null;
  mileage_in: number | null;
  mileage_out: number | null;
  created_date: Date | null;
  closed_date: Date | null;
  raw_data: Record<string, unknown> | null;
  synced_at: Date;
}

export async function upsertTekmetricWorkOrder(
  shopUUID: string,
  externalShopId: number,
  data: {
    workOrderId: string;
    workOrderNumber?: string | null;
    vin?: string | null;
    status?: string | null;
    statusCode?: string | null;
    label?: string | null;
    labelColor?: string | null;
    customerId?: number | null;
    vehicleId?: number | null;
    customerName?: string | null;
    vehicleYear?: number | null;
    vehicleMake?: string | null;
    vehicleModel?: string | null;
    vehicleSubmodel?: string | null;
    mileageIn?: number | null;
    mileageOut?: number | null;
    createdDate?: Date | null;
    closedDate?: Date | null;
    rawData?: Record<string, unknown> | null;
  }
): Promise<TekmetricWorkOrder> {
  const now = new Date();
  const normalizedVin = data.vin?.toUpperCase().trim() || null;

  const orders = await sql<TekmetricWorkOrder[]>`
    INSERT INTO tekmetric_work_orders (
      id, shop_id, external_shop_id, work_order_id, work_order_number,
      vin, status, status_code, label, label_color,
      customer_id, vehicle_id, customer_name,
      vehicle_year, vehicle_make, vehicle_model, vehicle_submodel,
      mileage_in, mileage_out, created_date, closed_date,
      raw_data, synced_at
    ) VALUES (
      gen_random_uuid(),
      ${shopUUID},
      ${externalShopId},
      ${data.workOrderId},
      ${data.workOrderNumber || null},
      ${normalizedVin},
      ${data.status || null},
      ${data.statusCode || null},
      ${data.label || null},
      ${data.labelColor || null},
      ${data.customerId || null},
      ${data.vehicleId || null},
      ${data.customerName || null},
      ${data.vehicleYear || null},
      ${data.vehicleMake || null},
      ${data.vehicleModel || null},
      ${data.vehicleSubmodel || null},
      ${data.mileageIn || null},
      ${data.mileageOut || null},
      ${data.createdDate || null},
      ${data.closedDate || null},
      ${data.rawData ? JSON.stringify(data.rawData) : null}::jsonb,
      ${now}
    )
    ON CONFLICT (shop_id, work_order_id)
    DO UPDATE SET
      work_order_number = COALESCE(EXCLUDED.work_order_number, tekmetric_work_orders.work_order_number),
      vin = COALESCE(EXCLUDED.vin, tekmetric_work_orders.vin),
      status = COALESCE(EXCLUDED.status, tekmetric_work_orders.status),
      status_code = COALESCE(EXCLUDED.status_code, tekmetric_work_orders.status_code),
      label = COALESCE(EXCLUDED.label, tekmetric_work_orders.label),
      label_color = COALESCE(EXCLUDED.label_color, tekmetric_work_orders.label_color),
      customer_id = COALESCE(EXCLUDED.customer_id, tekmetric_work_orders.customer_id),
      vehicle_id = COALESCE(EXCLUDED.vehicle_id, tekmetric_work_orders.vehicle_id),
      customer_name = COALESCE(EXCLUDED.customer_name, tekmetric_work_orders.customer_name),
      vehicle_year = COALESCE(EXCLUDED.vehicle_year, tekmetric_work_orders.vehicle_year),
      vehicle_make = COALESCE(EXCLUDED.vehicle_make, tekmetric_work_orders.vehicle_make),
      vehicle_model = COALESCE(EXCLUDED.vehicle_model, tekmetric_work_orders.vehicle_model),
      vehicle_submodel = COALESCE(EXCLUDED.vehicle_submodel, tekmetric_work_orders.vehicle_submodel),
      mileage_in = COALESCE(EXCLUDED.mileage_in, tekmetric_work_orders.mileage_in),
      mileage_out = COALESCE(EXCLUDED.mileage_out, tekmetric_work_orders.mileage_out),
      closed_date = COALESCE(EXCLUDED.closed_date, tekmetric_work_orders.closed_date),
      raw_data = COALESCE(EXCLUDED.raw_data, tekmetric_work_orders.raw_data),
      synced_at = ${now}
    RETURNING *
  `;
  
  return orders[0];
}

export async function getTekmetricWorkOrder(
  shopId: string,
  workOrderId: string
): Promise<TekmetricWorkOrder | null> {
  const orders = await sql<TekmetricWorkOrder[]>`
    SELECT * FROM tekmetric_work_orders
    WHERE shop_id = ${shopId} AND work_order_id = ${workOrderId}
    LIMIT 1
  `;
  return orders[0] || null;
}

export async function getTekmetricWorkOrdersByVin(
  shopId: string,
  vin: string,
  limit = 50
): Promise<TekmetricWorkOrder[]> {
  const normalizedVin = vin.toUpperCase().trim();
  return sql<TekmetricWorkOrder[]>`
    SELECT * FROM tekmetric_work_orders
    WHERE shop_id = ${shopId} AND vin = ${normalizedVin}
    ORDER BY created_date DESC NULLS LAST, synced_at DESC
    LIMIT ${limit}
  `;
}

export async function getOpenTekmetricWorkOrders(
  shopId: string,
  limit = 100
): Promise<TekmetricWorkOrder[]> {
  return sql<TekmetricWorkOrder[]>`
    SELECT * FROM tekmetric_work_orders
    WHERE shop_id = ${shopId}
    AND closed_date IS NULL
    AND (status IS NULL OR status NOT IN ('Invoice', 'Invoiced', 'Posted', 'Deleted', 'Void'))
    ORDER BY created_date DESC NULLS LAST, synced_at DESC
    LIMIT ${limit}
  `;
}

export async function deleteTekmetricWorkOrder(
  shopId: string,
  workOrderId: string
): Promise<void> {
  await sql`
    DELETE FROM tekmetric_work_orders
    WHERE shop_id = ${shopId} AND work_order_id = ${workOrderId}
  `;
}

export async function getActiveWorkOrdersForShop(
  externalShopId: number,
  limit = 200
): Promise<TekmetricWorkOrder[]> {
  return sql<TekmetricWorkOrder[]>`
    SELECT * FROM tekmetric_work_orders
    WHERE external_shop_id = ${externalShopId}
    AND closed_date IS NULL
    AND (status IS NULL OR status NOT IN ('Invoice', 'Invoiced', 'Posted', 'Deleted', 'Void'))
    ORDER BY created_date DESC NULLS LAST
    LIMIT ${limit}
  `;
}
