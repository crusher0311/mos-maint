/**
 * Postgres-backed Tekmetric cache repository — the read & write surface
 * used by `lib/data/repositories/tekmetric-work-orders.ts` when
 * `TEKMETRIC_CACHE_PG_CANONICAL=1` (task #556).
 *
 * Backs the `tekmetric_work_orders` and `tekmetric_repair_orders` mirror
 * tables (lib/db/schema/wave3.ts). The full Mongo snapshot is stored
 * verbatim in the `payload` jsonb so the legacy doc shape (including
 * `data.id`, `data.jobs`, `inspections`, `vehicleYear`/`vehicleMake`/…,
 * `customerName`, `updatedDate`/`createdDate`, …) survives the cutover;
 * the typed columns are denormalised copies that back the indexed
 * lookups. Reads reconstruct the Mongo doc shape as
 * `{ ...payload, shopId, workOrderId|repairOrderId }` so callers don't
 * change.
 *
 * `shopId` is an INTEGER column here; the Mongo docs store shopId as
 * either a string or a number across docs. Callers normalise to
 * `Number(shopId)` before hitting PG (the Mongo side keeps the
 * string/number `$in` variant matching).
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag. See
 * docs/runbooks/db-integration-cache-cutover.md.
 */
import { and, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { tekmetricWorkOrders, tekmetricRepairOrders } from "@/lib/db/schema/wave3";

type AnyDoc = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* work orders                                                                 */
/* -------------------------------------------------------------------------- */

function reconstructWorkOrder(row: {
  shopId: number;
  workOrderId: string;
  payload: unknown;
}): AnyDoc {
  const payload = (row.payload as AnyDoc) ?? {};
  return { ...payload, shopId: row.shopId, workOrderId: row.workOrderId };
}

export interface PgWorkOrderUpsertFields {
  repairOrderNumber?: number | null;
  status?: string | null;
  vin?: string | null;
  customerId?: string | null;
  vehicleId?: string | null;
  completedDate?: Date | null;
  postedDate?: Date | null;
  updatedDate?: Date | null;
  fetchedAt?: Date;
  [k: string]: unknown;
}

function workOrderColumns(set: PgWorkOrderUpsertFields): AnyDoc {
  const row: AnyDoc = {};
  if (set.repairOrderNumber !== undefined) row.repairOrderNumber = set.repairOrderNumber;
  if (set.status !== undefined) row.status = set.status;
  if (set.vin !== undefined) row.vin = set.vin;
  if (set.customerId !== undefined) row.customerId = set.customerId;
  if (set.vehicleId !== undefined) row.vehicleId = set.vehicleId;
  if (set.completedDate !== undefined) row.completedDate = set.completedDate;
  if (set.postedDate !== undefined) row.postedDate = set.postedDate;
  if (set.updatedDate !== undefined) row.updatedDate = set.updatedDate;
  if (set.fetchedAt !== undefined) row.fetchedAt = set.fetchedAt;
  return row;
}

export async function upsertWorkOrderSnapshot(
  shopId: number,
  workOrderId: string,
  set: PgWorkOrderUpsertFields,
): Promise<void> {
  const db = getDb();
  const cols = workOrderColumns(set);
  await db
    .insert(tekmetricWorkOrders)
    .values({
      shopId,
      workOrderId,
      ...cols,
      payload: set,
    } as typeof tekmetricWorkOrders.$inferInsert)
    .onConflictDoUpdate({
      target: [tekmetricWorkOrders.shopId, tekmetricWorkOrders.workOrderId],
      // Merge the new snapshot into the existing payload so partial
      // updates don't clobber fields written by a prior fuller fetch.
      set: {
        ...cols,
        payload: sql`${tekmetricWorkOrders.payload} || ${JSON.stringify(set)}::jsonb`,
      } as Partial<typeof tekmetricWorkOrders.$inferInsert>,
    });
}

/**
 * Finds a cached Tekmetric work order by its Tekmetric RO id (stored as
 * `workOrderId` — the PK text column — or nested `payload.data.id`).
 */
export async function findWorkOrderByRoId(
  shopId: number,
  roId: number,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricWorkOrders)
    .where(
      and(
        eq(tekmetricWorkOrders.shopId, shopId),
        or(
          eq(tekmetricWorkOrders.workOrderId, String(roId)),
          sql`(${tekmetricWorkOrders.payload} #>> '{data,id}') = ${String(roId)}`,
        ),
      ),
    )
    .limit(1);
  return rows.length ? reconstructWorkOrder(rows[0]) : null;
}

/**
 * Finds a cached Tekmetric work order by its Tekmetric RO id, matching
 * the `workOrderId` PK column only (the search route's plain
 * `workOrderId: String(roId)` lookup).
 */
export async function findWorkOrderByWorkOrderId(
  shopId: number,
  workOrderId: string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricWorkOrders)
    .where(
      and(
        eq(tekmetricWorkOrders.shopId, shopId),
        eq(tekmetricWorkOrders.workOrderId, String(workOrderId)),
      ),
    )
    .limit(1);
  return rows.length ? reconstructWorkOrder(rows[0]) : null;
}

const TERMINAL_RO_STATUSES = ["Invoiced", "Void", "Archived"];

/**
 * Finds the newest cached non-terminal (open) Tekmetric work order for a
 * VIN.
 */
export async function findLatestOpenWorkOrderByVin(
  shopId: number,
  vin: string,
): Promise<AnyDoc | null> {
  const vinUpper = String(vin || "").toUpperCase();
  if (!vinUpper) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricWorkOrders)
    .where(
      and(
        eq(tekmetricWorkOrders.shopId, shopId),
        eq(tekmetricWorkOrders.vin, vinUpper),
        notInArray(tekmetricWorkOrders.status, TERMINAL_RO_STATUSES),
      ),
    )
    // Mongo sorts by { fetchedAt: -1, updatedDate: -1 }.
    .orderBy(desc(tekmetricWorkOrders.fetchedAt), desc(tekmetricWorkOrders.updatedDate))
    .limit(1);
  return rows.length ? reconstructWorkOrder(rows[0]) : null;
}

/**
 * Fetches cached work orders by their human RO numbers
 * (`repairOrderNumber`). Returns Mongo-shaped docs; callers already read
 * `workOrderNumber` / `data.jobs` off the payload.
 */
export async function findWorkOrdersByNumbers(
  shopId: number,
  workOrderNumbers: Array<string | number>,
): Promise<AnyDoc[]> {
  const wanted = Array.from(
    new Set(
      workOrderNumbers
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n)),
    ),
  );
  if (wanted.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricWorkOrders)
    .where(
      and(
        eq(tekmetricWorkOrders.shopId, shopId),
        inArray(tekmetricWorkOrders.repairOrderNumber, wanted),
      ),
    )
    .limit(wanted.length * 2);
  return rows.map(reconstructWorkOrder);
}

/**
 * Lists a vehicle's most-recent Tekmetric work orders for a shop, sorted
 * by completedDate desc (mirrors the DVI pre-fill Mongo reader).
 */
export async function listRecentWorkOrdersForVehicle(
  shopId: number,
  vin: string,
  limit = 50,
): Promise<AnyDoc[]> {
  const vinUpper = String(vin || "").toUpperCase();
  if (!vinUpper) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricWorkOrders)
    .where(
      and(
        eq(tekmetricWorkOrders.shopId, shopId),
        eq(tekmetricWorkOrders.vin, vinUpper),
      ),
    )
    .orderBy(desc(tekmetricWorkOrders.completedDate))
    .limit(limit);
  return rows.map(reconstructWorkOrder);
}

/**
 * Finds the newest cached Tekmetric work order for a VIN that carries a
 * usable `customerName`. VIN match is case-insensitive; the customerName
 * guard mirrors the report route's Mongo filter
 * (`$exists && $nin [null, "", "Unknown Customer"]`). Sorted by the same
 * "most recent" key the Mongo side uses.
 */
export async function findLatestWorkOrderByVinWithCustomerName(
  shopId: number,
  vin: string,
): Promise<AnyDoc | null> {
  const vinUpper = String(vin || "").toUpperCase();
  if (!vinUpper) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricWorkOrders)
    .where(
      and(
        eq(tekmetricWorkOrders.shopId, shopId),
        sql`upper(${tekmetricWorkOrders.vin}) = ${vinUpper}`,
        sql`(${tekmetricWorkOrders.payload} ->> 'customerName') IS NOT NULL`,
        sql`(${tekmetricWorkOrders.payload} ->> 'customerName') NOT IN ('', 'Unknown Customer')`,
      ),
    )
    // Mongo sort: { updatedAt: -1, updatedDate: -1, createdAt: -1, createdDate: -1 }.
    // updatedAt/createdAt live only in the payload jsonb on hand-written docs;
    // the typed updatedDate column is the sync-writer field. Order by the
    // payload keys first (coalescing to the typed column) then the column.
    .orderBy(
      sql`(${tekmetricWorkOrders.payload} ->> 'updatedAt') desc nulls last`,
      desc(tekmetricWorkOrders.updatedDate),
      sql`(${tekmetricWorkOrders.payload} ->> 'createdAt') desc nulls last`,
      sql`(${tekmetricWorkOrders.payload} ->> 'createdDate') desc nulls last`,
    )
    .limit(1);
  return rows.length ? reconstructWorkOrder(rows[0]) : null;
}

/* -------------------------------------------------------------------------- */
/* repair orders                                                               */
/* -------------------------------------------------------------------------- */

function reconstructRepairOrder(row: {
  shopId: number;
  repairOrderId: string;
  payload: unknown;
}): AnyDoc {
  const payload = (row.payload as AnyDoc) ?? {};
  return { ...payload, shopId: row.shopId, repairOrderId: row.repairOrderId };
}

/**
 * Finds a cached Tekmetric repair order by its id (`repairOrderId` PK
 * text column). Mirrors the Mongo `findOne({ id })` lookup — the Mongo
 * docs store the id under `id`, which is promoted to the `repairOrderId`
 * column here.
 */
export async function findRepairOrderById(
  shopId: number,
  repairOrderId: number | string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricRepairOrders)
    .where(
      and(
        eq(tekmetricRepairOrders.shopId, shopId),
        eq(tekmetricRepairOrders.repairOrderId, String(repairOrderId)),
      ),
    )
    .limit(1);
  return rows.length ? reconstructRepairOrder(rows[0]) : null;
}

/**
 * Finds a cached Tekmetric repair order by id alone (no shop scope) —
 * mirrors the search route's `findOne({ $or: [{ id: <num> }, { id:
 * <str> }] })`, which has no shopId filter on the Mongo side. The PK is
 * (shop_id, repair_order_id) so a bare id can in principle match rows
 * across shops; we take the first, matching Mongo's arbitrary-first
 * `findOne` semantics.
 */
export async function findRepairOrderByIdAnyShop(
  repairOrderId: number | string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricRepairOrders)
    .where(eq(tekmetricRepairOrders.repairOrderId, String(repairOrderId)))
    .limit(1);
  return rows.length ? reconstructRepairOrder(rows[0]) : null;
}
