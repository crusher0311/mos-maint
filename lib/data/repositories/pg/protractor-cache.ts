/**
 * Postgres-backed Protractor cache repository — the read & write surface
 * used by `lib/data/repositories/protractor-work-orders.ts` and
 * `protractor-vehicles.ts` when `PROTRACTOR_CACHE_PG_CANONICAL=1`
 * (task #556).
 *
 * Backs the `protractor_work_orders` and `protractor_vehicles` mirror
 * tables (lib/db/schema/wave3.ts). The full Mongo snapshot is stored
 * verbatim in the `payload` jsonb so the legacy doc shape (including
 * `data.WorkOrderNumber`, `servicePackages`, `pricing`, …) survives the
 * cutover; the typed columns are denormalised copies that back the
 * indexed lookups. Reads reconstruct the Mongo doc shape as
 * `{ shopId, workOrderId|vin, ...payload }` so callers don't change.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag. See
 * docs/runbooks/db-integration-cache-cutover.md.
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import {
  protractorInvoiceCache,
  protractorInvoices,
  protractorWorkOrders,
  protractorVehicles,
} from "@/lib/db/schema/wave3";

type AnyDoc = Record<string, unknown>;
/** Up to two cache identities for each of the report's 300 scoped ROs. */
const MAX_BATCH_LOOKUP_IDS = 600;

async function withStatementTimeout<T>(
  maxTimeMS: number | undefined,
  work: (db: any) => Promise<T>,
): Promise<T> {
  const db = getDb();
  if (!maxTimeMS || maxTimeMS <= 0) return work(db);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(Math.max(1, Math.floor(maxTimeMS)))}, true)`,
    );
    return work(tx);
  });
}

/* -------------------------------------------------------------------------- */
/* work orders                                                                 */
/* -------------------------------------------------------------------------- */

export interface PgWorkOrderUpsertFields {
  workOrderGuid?: string | null;
  workOrderNumber?: number | null;
  type?: string | null;
  status?: string | null;
  vin?: string | null;
  serviceItemId?: string | null;
  contactId?: string | null;
  odometer?: number | null;
  workflowStage?: string | null;
  completed?: boolean;
  scheduledTime?: string | null;
  promisedTime?: string | null;
  fetchedAt?: Date;
  [k: string]: unknown;
}

function workOrderColumns(set: PgWorkOrderUpsertFields): AnyDoc {
  const row: AnyDoc = {};
  if (set.workOrderGuid !== undefined) row.workOrderGuid = set.workOrderGuid;
  if (set.workOrderNumber !== undefined) row.workOrderNumber = set.workOrderNumber;
  if (set.type !== undefined) row.type = set.type;
  if (set.status !== undefined) row.status = set.status;
  if (set.vin !== undefined) row.vin = set.vin;
  if (set.serviceItemId !== undefined) row.serviceItemId = set.serviceItemId;
  if (set.contactId !== undefined) row.contactId = set.contactId;
  if (set.odometer !== undefined) row.odometer = set.odometer;
  if (set.workflowStage !== undefined) row.workflowStage = set.workflowStage;
  if (set.completed !== undefined) row.completed = set.completed;
  if (set.scheduledTime !== undefined) row.scheduledTime = set.scheduledTime;
  if (set.promisedTime !== undefined) row.promisedTime = set.promisedTime;
  if (set.fetchedAt !== undefined) row.fetchedAt = set.fetchedAt;
  return row;
}

export async function upsertWorkOrderSnapshot(
  shopId: number,
  workOrderId: string,
  set: PgWorkOrderUpsertFields,
  now: Date,
): Promise<void> {
  const db = getDb();
  const cols = workOrderColumns(set);
  await db
    .insert(protractorWorkOrders)
    .values({
      shopId,
      workOrderId,
      ...cols,
      payload: set,
      createdAt: now,
    } as typeof protractorWorkOrders.$inferInsert)
    .onConflictDoUpdate({
      target: [protractorWorkOrders.shopId, protractorWorkOrders.workOrderId],
      // Merge the new snapshot into the existing payload so partial
      // updates don't clobber fields written by a prior fuller fetch.
      set: {
        ...cols,
        payload: sql`${protractorWorkOrders.payload} || ${JSON.stringify(set)}::jsonb`,
      } as Partial<typeof protractorWorkOrders.$inferInsert>,
    });
}

function reconstructWorkOrder(row: {
  shopId: number;
  workOrderId: string;
  payload: unknown;
}): AnyDoc {
  const payload = (row.payload as AnyDoc) ?? {};
  return { ...payload, shopId: row.shopId, workOrderId: row.workOrderId };
}

export async function findCachedWorkOrderByLegacyRoNumber(
  shopId: number,
  roNumber: number,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(protractorWorkOrders)
    .where(
      and(
        eq(protractorWorkOrders.shopId, shopId),
        sql`(${protractorWorkOrders.payload} #>> '{data,WorkOrderNumber}') = ${String(roNumber)}`,
      ),
    )
    .limit(1);
  return rows.length ? reconstructWorkOrder(rows[0]) : null;
}

// Task #903: RO-number lookup covering BOTH the current snapshot shape
// (top-level workOrderNumber column) and the legacy shape (payload
// data.WorkOrderNumber). Newest snapshot wins.
export async function findCachedWorkOrderByRoNumber(
  shopId: number,
  roNumber: number,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(protractorWorkOrders)
    .where(
      and(
        eq(protractorWorkOrders.shopId, shopId),
        sql`(${protractorWorkOrders.workOrderNumber} = ${roNumber} OR (${protractorWorkOrders.payload} #>> '{data,WorkOrderNumber}') = ${String(roNumber)})`,
      ),
    )
    .orderBy(desc(protractorWorkOrders.fetchedAt))
    .limit(1);
  return rows.length ? reconstructWorkOrder(rows[0]) : null;
}

export async function listOpenWorkOrdersWithPricing(
  shopId: number,
  limit = 25,
): Promise<AnyDoc[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(protractorWorkOrders)
    .where(
      and(
        eq(protractorWorkOrders.shopId, shopId),
        ne(protractorWorkOrders.completed, true),
        sql`${protractorWorkOrders.workflowStage} IN ('EstimateCompleted','WorkAuthorized','InspectionInProgress','InspectionComplete','Unassigned')`,
        sql`(${protractorWorkOrders.payload} #>> '{pricing,grandTotal}')::numeric > 0`,
      ),
    )
    .orderBy(desc(protractorWorkOrders.fetchedAt))
    .limit(limit);
  return rows.map(reconstructWorkOrder);
}

export async function findCachedWorkOrderById(
  shopId: number,
  workOrderId: string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(protractorWorkOrders)
    .where(
      and(
        eq(protractorWorkOrders.shopId, shopId),
        eq(protractorWorkOrders.workOrderId, workOrderId),
      ),
    )
    .limit(1);
  return rows.length ? reconstructWorkOrder(rows[0]) : null;
}

export async function findCachedWorkOrdersByIds(
  shopId: number,
  workOrderIds: string[],
  options: { maxTimeMS?: number } = {},
): Promise<AnyDoc[]> {
  const ids = Array.from(
    new Set(workOrderIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ).slice(0, MAX_BATCH_LOOKUP_IDS);
  if (ids.length === 0) return [];
  const rows = await withStatementTimeout<any[]>(options.maxTimeMS, (db) =>
    db
      .select()
      .from(protractorWorkOrders)
      .where(
        and(
          eq(protractorWorkOrders.shopId, shopId),
          inArray(protractorWorkOrders.workOrderId, ids),
        ),
      )
      .orderBy(desc(protractorWorkOrders.fetchedAt)),
  );
  return rows.map(reconstructWorkOrder);
}

export async function findCachedInvoiceSnapshotsByIds(
  shopId: number,
  invoiceIds: string[],
  options: { maxTimeMS?: number } = {},
): Promise<AnyDoc[]> {
  const ids = Array.from(
    new Set(invoiceIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ).slice(0, MAX_BATCH_LOOKUP_IDS);
  if (ids.length === 0) return [];
  const rows = await withStatementTimeout<any[]>(options.maxTimeMS, (db) =>
    db
      .select()
      .from(protractorInvoices)
      .where(
        and(
          eq(protractorInvoices.shopId, shopId),
          inArray(protractorInvoices.invoiceId, ids),
        ),
      )
      .orderBy(desc(protractorInvoices.fetchedAt)),
  );
  return rows.map((row) => ({
    ...(row.payload as AnyDoc),
    shopId: row.shopId,
    invoiceId: row.invoiceId,
  }));
}

export async function findInvoiceCacheEntriesByIds(
  shopId: number,
  invoiceIds: string[],
  options: { maxTimeMS?: number } = {},
): Promise<AnyDoc[]> {
  const ids = Array.from(
    new Set(invoiceIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ).slice(0, MAX_BATCH_LOOKUP_IDS);
  if (ids.length === 0) return [];
  const rows = await withStatementTimeout<any[]>(options.maxTimeMS, (db) =>
    db
      .select()
      .from(protractorInvoiceCache)
      .where(
        and(
          eq(protractorInvoiceCache.shopId, shopId),
          inArray(protractorInvoiceCache.invoiceId, ids),
        ),
      )
      .orderBy(desc(protractorInvoiceCache.cachedAt)),
  );
  return rows.map((row) => ({
    ...(row.payload as AnyDoc),
    shopId: row.shopId,
    invoiceId: row.invoiceId,
    cachedAt: row.cachedAt,
  }));
}

export async function findDisplayRoNumbersByIds(
  shopId: number,
  workOrderIds: string[],
  options: { maxTimeMS?: number } = {},
): Promise<Record<string, string>> {
  if (workOrderIds.length === 0) return {};
  const rows = await withStatementTimeout<any[]>(options.maxTimeMS, (db) =>
    db
      .select({
        workOrderId: protractorWorkOrders.workOrderId,
        workOrderNumber: protractorWorkOrders.workOrderNumber,
        payload: protractorWorkOrders.payload,
      })
      .from(protractorWorkOrders)
      .where(
        and(
          eq(protractorWorkOrders.shopId, shopId),
          inArray(protractorWorkOrders.workOrderId, workOrderIds),
        ),
      ),
  );

  const out: Record<string, string> = {};
  for (const row of rows) {
    const payload = (row.payload as AnyDoc) ?? {};
    const legacyData = (payload.data as AnyDoc | undefined) ?? {};
    const number = row.workOrderNumber ?? legacyData.WorkOrderNumber;
    if (Number.isFinite(Number(number)) && Number(number) > 0) {
      out[row.workOrderId] = String(number);
    }
  }
  return out;
}

export async function listCachedWorkOrdersForServiceItem(
  shopId: number,
  serviceItemId: string,
  options?: { includeOpen?: boolean },
): Promise<AnyDoc[]> {
  const db = getDb();
  const conditions = [
    eq(protractorWorkOrders.shopId, shopId),
    eq(protractorWorkOrders.serviceItemId, serviceItemId),
  ];
  if (options?.includeOpen) {
    conditions.push(ne(protractorWorkOrders.completed, true));
  }
  const rows = await db
    .select()
    .from(protractorWorkOrders)
    .where(and(...conditions))
    .orderBy(desc(protractorWorkOrders.fetchedAt));
  return rows.map(reconstructWorkOrder);
}

/* -------------------------------------------------------------------------- */
/* vehicles                                                                    */
/* -------------------------------------------------------------------------- */

export interface PgVehicleUpsertFields {
  protractorId?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  odometer?: number | null;
  odometerDate?: string | null;
  licensePlate?: string | null;
  ownerId?: string | null;
  fetchedAt?: Date;
  updatedAt?: Date;
  [k: string]: unknown;
}

function vehicleColumns(set: PgVehicleUpsertFields): AnyDoc {
  const row: AnyDoc = {};
  if (set.protractorId !== undefined) row.protractorId = set.protractorId;
  if (set.year !== undefined) row.year = set.year;
  if (set.make !== undefined) row.make = set.make;
  if (set.model !== undefined) row.model = set.model;
  if (set.odometer !== undefined) row.odometer = set.odometer;
  if (set.odometerDate !== undefined) row.odometerDate = set.odometerDate;
  if (set.licensePlate !== undefined) row.licensePlate = set.licensePlate;
  if (set.ownerId !== undefined) row.ownerId = set.ownerId;
  if (set.fetchedAt !== undefined) row.fetchedAt = set.fetchedAt;
  if (set.updatedAt !== undefined) row.updatedAt = set.updatedAt;
  return row;
}

export async function upsertVehicleSnapshot(
  shopId: number,
  vin: string,
  set: PgVehicleUpsertFields,
  now: Date,
): Promise<void> {
  const db = getDb();
  const vinUpper = vin.toUpperCase();
  const cols = vehicleColumns(set);
  await db
    .insert(protractorVehicles)
    .values({
      shopId,
      vin: vinUpper,
      ...cols,
      payload: set,
      createdAt: now,
    } as typeof protractorVehicles.$inferInsert)
    .onConflictDoUpdate({
      target: [protractorVehicles.shopId, protractorVehicles.vin],
      set: {
        ...cols,
        payload: sql`${protractorVehicles.payload} || ${JSON.stringify(set)}::jsonb`,
      } as Partial<typeof protractorVehicles.$inferInsert>,
    });
}

export async function findVehicleByShopAndVin(
  shopId: number,
  vin: string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(protractorVehicles)
    .where(
      and(
        eq(protractorVehicles.shopId, shopId),
        eq(protractorVehicles.vin, vin.toUpperCase()),
      ),
    )
    .limit(1);
  if (!rows.length) return null;
  const row = rows[0];
  const payload = (row.payload as AnyDoc) ?? {};
  return { ...payload, shopId: row.shopId, vin: row.vin };
}
