import sql from "@/lib/db/postgres";

export interface WorkOrder {
  id: string;
  shop_id: string;
  customer_id: string | null;
  vehicle_id: string | null;
  order_number: string;
  status: string | null;
  odometer_in: number | null;
  odometer_out: number | null;
  labor_total: number | null;
  parts_total: number | null;
  total: number | null;
  opened_date: Date | null;
  closed_date: Date | null;
  source_system: string | null;
  source_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export async function getWorkOrderById(workOrderId: string): Promise<WorkOrder | null> {
  const orders = await sql<WorkOrder[]>`
    SELECT * FROM work_orders WHERE id = ${workOrderId} LIMIT 1
  `;
  return orders[0] || null;
}

export async function getWorkOrderByOrderNumber(shopId: string, orderNumber: string): Promise<WorkOrder | null> {
  const orders = await sql<WorkOrder[]>`
    SELECT * FROM work_orders 
    WHERE shop_id = ${shopId} AND order_number = ${orderNumber}
    LIMIT 1
  `;
  return orders[0] || null;
}

export async function getWorkOrdersForVehicle(vehicleId: string, limit = 50): Promise<WorkOrder[]> {
  return sql<WorkOrder[]>`
    SELECT * FROM work_orders 
    WHERE vehicle_id = ${vehicleId}
    ORDER BY opened_date DESC NULLS LAST, created_at DESC
    LIMIT ${limit}
  `;
}

export async function getWorkOrdersForCustomer(customerId: string, limit = 50): Promise<WorkOrder[]> {
  return sql<WorkOrder[]>`
    SELECT * FROM work_orders 
    WHERE customer_id = ${customerId}
    ORDER BY opened_date DESC NULLS LAST, created_at DESC
    LIMIT ${limit}
  `;
}

export async function getRecentWorkOrdersForShop(shopId: string, limit = 50, offset = 0): Promise<WorkOrder[]> {
  return sql<WorkOrder[]>`
    SELECT * FROM work_orders 
    WHERE shop_id = ${shopId}
    ORDER BY opened_date DESC NULLS LAST, created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function getOpenWorkOrdersForShop(shopId: string, limit = 100): Promise<WorkOrder[]> {
  return sql<WorkOrder[]>`
    SELECT * FROM work_orders 
    WHERE shop_id = ${shopId}
      AND closed_date IS NULL
      AND (status IS NULL OR status NOT IN ('closed', 'Closed', 'CLOSED', 'completed', 'Completed'))
    ORDER BY opened_date DESC NULLS LAST, created_at DESC
    LIMIT ${limit}
  `;
}

export async function upsertWorkOrder(
  shopId: string,
  orderNumber: string,
  data: {
    customerId?: string | null;
    vehicleId?: string | null;
    status?: string | null;
    odometerIn?: number | null;
    odometerOut?: number | null;
    laborTotal?: number | null;
    partsTotal?: number | null;
    total?: number | null;
    openedDate?: Date | null;
    closedDate?: Date | null;
    sourceSystem?: string | null;
    sourceId?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<WorkOrder> {
  const now = new Date();

  const orders = await sql<WorkOrder[]>`
    INSERT INTO work_orders (
      id, shop_id, customer_id, vehicle_id, order_number, status,
      odometer_in, odometer_out, labor_total, parts_total, total,
      opened_date, closed_date, source_system, source_id, metadata, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), ${shopId}, ${data.customerId || null}, ${data.vehicleId || null},
      ${orderNumber}, ${data.status || null},
      ${data.odometerIn || null}, ${data.odometerOut || null}, 
      ${data.laborTotal || null}, ${data.partsTotal || null}, ${data.total || null},
      ${data.openedDate || null}, ${data.closedDate || null},
      ${data.sourceSystem || null}, ${data.sourceId || null},
      ${data.metadata ? JSON.stringify(data.metadata) : null}::jsonb,
      ${now}, ${now}
    )
    ON CONFLICT (shop_id, order_number) WHERE order_number IS NOT NULL
    DO UPDATE SET
      customer_id = COALESCE(EXCLUDED.customer_id, work_orders.customer_id),
      vehicle_id = COALESCE(EXCLUDED.vehicle_id, work_orders.vehicle_id),
      status = COALESCE(EXCLUDED.status, work_orders.status),
      odometer_in = COALESCE(EXCLUDED.odometer_in, work_orders.odometer_in),
      odometer_out = COALESCE(EXCLUDED.odometer_out, work_orders.odometer_out),
      labor_total = COALESCE(EXCLUDED.labor_total, work_orders.labor_total),
      parts_total = COALESCE(EXCLUDED.parts_total, work_orders.parts_total),
      total = COALESCE(EXCLUDED.total, work_orders.total),
      closed_date = COALESCE(EXCLUDED.closed_date, work_orders.closed_date),
      updated_at = ${now}
    RETURNING *
  `;
  
  return orders[0];
}

export async function updateWorkOrder(
  workOrderId: string,
  updates: Partial<Omit<WorkOrder, 'id' | 'shop_id' | 'order_number' | 'created_at'>>
): Promise<WorkOrder | null> {
  const customerId = updates.customer_id ?? null;
  const vehicleId = updates.vehicle_id ?? null;
  const status = updates.status ?? null;
  const odometerIn = updates.odometer_in ?? null;
  const odometerOut = updates.odometer_out ?? null;
  const laborTotal = updates.labor_total ?? null;
  const partsTotal = updates.parts_total ?? null;
  const total = updates.total ?? null;
  const closedDate = updates.closed_date ?? null;
  const metadata = updates.metadata ? JSON.stringify(updates.metadata) : null;

  const orders = await sql<WorkOrder[]>`
    UPDATE work_orders
    SET 
      customer_id = COALESCE(${customerId}, customer_id),
      vehicle_id = COALESCE(${vehicleId}, vehicle_id),
      status = COALESCE(${status}, status),
      odometer_in = COALESCE(${odometerIn}, odometer_in),
      odometer_out = COALESCE(${odometerOut}, odometer_out),
      labor_total = COALESCE(${laborTotal}, labor_total),
      parts_total = COALESCE(${partsTotal}, parts_total),
      total = COALESCE(${total}, total),
      closed_date = COALESCE(${closedDate}, closed_date),
      metadata = COALESCE(${metadata}::jsonb, metadata),
      updated_at = NOW()
    WHERE id = ${workOrderId}
    RETURNING *
  `;
  return orders[0] || null;
}

export async function getWorkOrderCountForShop(shopId: string, since?: Date): Promise<number> {
  const result = await sql<{count: string}[]>`
    SELECT COUNT(*) as count FROM work_orders 
    WHERE shop_id = ${shopId}
    ${since ? sql`AND created_at >= ${since}` : sql``}
  `;
  return parseInt(result[0]?.count || '0', 10);
}

export async function searchWorkOrders(
  shopId: string,
  query: string,
  limit = 20
): Promise<WorkOrder[]> {
  const searchTerm = `%${query}%`;
  return sql<WorkOrder[]>`
    SELECT * FROM work_orders
    WHERE shop_id = ${shopId}
      AND (
        order_number ILIKE ${searchTerm}
        OR status ILIKE ${searchTerm}
      )
    ORDER BY opened_date DESC NULLS LAST, created_at DESC
    LIMIT ${limit}
  `;
}

export async function getWorkOrdersWithJobs(shopId: string, orderNumber: string): Promise<{
  workOrder: WorkOrder | null;
  jobs: any[];
}> {
  const orders = await sql<WorkOrder[]>`
    SELECT * FROM work_orders 
    WHERE shop_id = ${shopId} AND order_number = ${orderNumber}
    LIMIT 1
  `;
  
  const workOrder = orders[0] || null;
  
  if (!workOrder) {
    return { workOrder: null, jobs: [] };
  }
  
  const jobs = await sql`
    SELECT * FROM work_order_jobs 
    WHERE work_order_id = ${workOrder.id}
    ORDER BY created_at
  `;
  
  return { workOrder, jobs };
}
