/**
 * Postgres-backed Shop-Ware cache repository — the read & write surface
 * used by `lib/data/repositories/shopware-cache.ts` when
 * `SHOPWARE_CACHE_PG_CANONICAL=1` (task #556).
 *
 * Backs the `shopware_repair_orders`, `shopware_vehicles`, and
 * `shopware_customers` mirror tables (lib/db/schema/wave3.ts). Each
 * write maps the Mongo-shaped upsert document onto the typed columns,
 * stashing the verbatim source document in the `raw`/`payload` jsonb so
 * no field is lost across the cutover.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag. See
 * docs/runbooks/db-integration-cache-cutover.md.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import {
  shopwareRepairOrders,
  shopwareVehicles,
  shopwareCustomers,
} from "@/lib/db/schema/wave3";

type AnyDoc = Record<string, unknown>;

export interface PgRepairOrderUpsertData {
  tenantId?: number;
  swShopId?: number;
  number?: number | null;
  state?: string | null;
  vin?: string | null;
  customerId?: number | null;
  vehicleId?: number | null;
  customerName?: string | null;
  vehicleYear?: number | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  odometer?: number | null;
  serviceCount?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  closedAt?: Date | null;
  raw?: unknown;
  syncedAt?: Date;
  partialFromWebhook?: boolean;
  fetchError?: string;
}

function repairOrderColumns(data: PgRepairOrderUpsertData): AnyDoc {
  const row: AnyDoc = {};
  if (data.tenantId !== undefined) row.tenantId = data.tenantId;
  if (data.swShopId !== undefined) row.swShopId = data.swShopId;
  if (data.number !== undefined) row.number = data.number;
  if (data.state !== undefined) row.state = data.state;
  if (data.vin !== undefined) row.vin = data.vin;
  if (data.customerId !== undefined) row.customerId = data.customerId;
  if (data.vehicleId !== undefined) row.vehicleId = data.vehicleId;
  if (data.customerName !== undefined) row.customerName = data.customerName;
  if (data.vehicleYear !== undefined) row.vehicleYear = data.vehicleYear;
  if (data.vehicleMake !== undefined) row.vehicleMake = data.vehicleMake;
  if (data.vehicleModel !== undefined) row.vehicleModel = data.vehicleModel;
  if (data.odometer !== undefined) row.odometer = data.odometer;
  if (data.serviceCount !== undefined) row.serviceCount = data.serviceCount;
  if (data.createdAt !== undefined) row.createdAtSrc = data.createdAt;
  if (data.updatedAt !== undefined) row.updatedAtSrc = data.updatedAt;
  if (data.closedAt !== undefined) row.closedAt = data.closedAt;
  if (data.partialFromWebhook !== undefined)
    row.partialFromWebhook = data.partialFromWebhook;
  if (data.fetchError !== undefined) row.fetchError = data.fetchError;
  if (data.raw !== undefined) row.raw = data.raw;
  return row;
}

export async function upsertRepairOrder(
  mosShopId: number,
  roId: number,
  data: PgRepairOrderUpsertData,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const cols = repairOrderColumns(data);
  const syncedAt = data.syncedAt ?? now;
  await db
    .insert(shopwareRepairOrders)
    .values({
      mosShopId,
      roId,
      ...cols,
      syncedAt,
    } as typeof shopwareRepairOrders.$inferInsert)
    .onConflictDoUpdate({
      target: [shopwareRepairOrders.mosShopId, shopwareRepairOrders.roId],
      set: { ...cols, syncedAt } as Partial<
        typeof shopwareRepairOrders.$inferInsert
      >,
    });
}

export async function markRepairOrderDeleted(
  mosShopId: number,
  roId: number,
): Promise<void> {
  const db = getDb();
  await db
    .update(shopwareRepairOrders)
    .set({ deleted: true, deletedAt: new Date(), deletedViaWebhook: true })
    .where(
      and(
        eq(shopwareRepairOrders.mosShopId, mosShopId),
        eq(shopwareRepairOrders.roId, roId),
      ),
    );
}

export interface PgVehicleUpsertData {
  tenantId?: number;
  vin?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  licensePlate?: string | null;
  customerId?: number | null;
  updatedAt?: Date;
  raw?: unknown;
  [k: string]: unknown;
}

export async function upsertVehicle(
  mosShopId: number,
  vehicleId: number,
  data: PgVehicleUpsertData,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const set: AnyDoc = { payload: data, updatedAt: data.updatedAt ?? now };
  if (data.vin !== undefined) set.vin = data.vin;
  if (data.year !== undefined) set.year = data.year;
  if (data.make !== undefined) set.make = data.make;
  if (data.model !== undefined) set.model = data.model;
  if (data.customerId !== undefined) set.customerId = data.customerId;
  await db
    .insert(shopwareVehicles)
    .values({
      mosShopId,
      vehicleId,
      ...set,
    } as typeof shopwareVehicles.$inferInsert)
    .onConflictDoUpdate({
      target: [shopwareVehicles.mosShopId, shopwareVehicles.vehicleId],
      set: set as Partial<typeof shopwareVehicles.$inferInsert>,
    });
}

export interface PgCustomerUpsertData {
  tenantId?: number;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  updatedAt?: Date;
  raw?: unknown;
  [k: string]: unknown;
}

export async function upsertCustomer(
  mosShopId: number,
  customerId: number,
  data: PgCustomerUpsertData,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const name = [data.firstName, data.lastName].filter(Boolean).join(" ") || null;
  const set: AnyDoc = {
    name,
    payload: data,
    updatedAt: data.updatedAt ?? now,
  };
  await db
    .insert(shopwareCustomers)
    .values({
      mosShopId,
      customerId,
      ...set,
    } as typeof shopwareCustomers.$inferInsert)
    .onConflictDoUpdate({
      target: [shopwareCustomers.mosShopId, shopwareCustomers.customerId],
      set: set as Partial<typeof shopwareCustomers.$inferInsert>,
    });
}
