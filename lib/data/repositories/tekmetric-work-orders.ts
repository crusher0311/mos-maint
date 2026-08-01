// Repository for the `tekmetric_work_orders` collection.
//
// `tekmetric_work_orders` is written by the Tekmetric backfill / webhook
// sync pipeline. Those writer modules stay on the legacy allowlist; this
// repository only exposes the narrow read shapes the app needs so route
// code never reaches into the Mongo driver directly (enforced by
// `scripts/check-direct-db.cjs`).
//
// Task #556: every public helper is gated on
// `isTekmetricCachePgCanonical()`. When OFF (default), the original
// Mongo body runs verbatim (zero behaviour change). When ON, reads go to
// the Postgres mirror and writes replay the Mongo write via
// `shadowWriteMongoIntegrationCache`. See
// docs/runbooks/db-integration-cache-cutover.md.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isTekmetricCachePgCanonical,
  shouldShadowWriteMongoTekmetricCache,
  shadowWriteMongoIntegrationCache,
} from "@/lib/db/integration-cache-write-mode";
import * as pg from "./pg/tekmetric-cache";

const COLLECTION = "tekmetric_work_orders";
const REPAIR_ORDERS_COLLECTION = "tekmetric_repair_orders";

async function collection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(COLLECTION);
}

async function repairOrdersCollection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(REPAIR_ORDERS_COLLECTION);
}

// Task #808: statuses that mean an RO can no longer accept new jobs. Mirrors
// the open-RO lookup in /api/tekmetric/apply-canned-job.
const TERMINAL_RO_STATUSES = ["Invoiced", "Void", "Archived"];

/**
 * Finds a cached Tekmetric work order by its Tekmetric RO id (stored as
 * `workOrderId` — string or number across docs — or nested `data.id`).
 */
export async function findTekmetricWorkOrderByRoId(
  shopId: string | number,
  roId: number,
): Promise<Document | null> {
  if (isTekmetricCachePgCanonical()) {
    return (await pg.findWorkOrderByRoId(
      Number(shopId),
      roId,
    )) as Document | null;
  }
  return findTekmetricWorkOrderByRoIdMongo(shopId, roId);
}

async function findTekmetricWorkOrderByRoIdMongo(
  shopId: string | number,
  roId: number,
): Promise<Document | null> {
  const col = await collection();
  return col.findOne({
    shopId: { $in: [String(shopId), Number(shopId)] },
    $or: [
      { workOrderId: { $in: [String(roId), Number(roId)] } },
      { "data.id": Number(roId) },
    ],
  });
}

/**
 * Finds a cached Tekmetric work order by its plain `workOrderId`
 * (string), scoped to a shop. Used by the extension jobs-search route to
 * resolve a vehicle context from an RO id.
 */
export async function findTekmetricWorkOrderByWorkOrderId(
  shopId: string | number,
  workOrderId: string,
): Promise<Document | null> {
  if (isTekmetricCachePgCanonical()) {
    return (await pg.findWorkOrderByWorkOrderId(
      Number(shopId),
      workOrderId,
    )) as Document | null;
  }
  return findTekmetricWorkOrderByWorkOrderIdMongo(shopId, workOrderId);
}

async function findTekmetricWorkOrderByWorkOrderIdMongo(
  shopId: string | number,
  workOrderId: string,
): Promise<Document | null> {
  const col = await collection();
  return col.findOne({
    shopId: { $in: [String(shopId), Number(shopId)] },
    workOrderId: String(workOrderId),
  });
}

/**
 * Finds a cached Tekmetric repair order by its id (`id` field — string or
 * number across docs). Mirrors the extension jobs-search fallback lookup,
 * which has no shopId filter on the Mongo side.
 */
export async function findTekmetricRepairOrderById(
  roId: string | number,
): Promise<Document | null> {
  if (isTekmetricCachePgCanonical()) {
    return (await pg.findRepairOrderByIdAnyShop(roId)) as Document | null;
  }
  return findTekmetricRepairOrderByIdMongo(roId);
}

async function findTekmetricRepairOrderByIdMongo(
  roId: string | number,
): Promise<Document | null> {
  const col = await repairOrdersCollection();
  return col.findOne({
    $or: [{ id: parseInt(String(roId)) }, { id: String(roId) }],
  });
}

/**
 * Finds the newest cached Tekmetric work order for a VIN that carries a
 * usable `customerName`. Used by the shared report route to attribute a
 * customer name. VIN match is case-insensitive; the customerName guard
 * mirrors `$exists && $nin [null, "", "Unknown Customer"]`.
 */
export async function findLatestTekmetricWorkOrderByVinWithCustomerName(
  shopId: string | number,
  vin: string,
): Promise<Document | null> {
  if (isTekmetricCachePgCanonical()) {
    return (await pg.findLatestWorkOrderByVinWithCustomerName(
      Number(shopId),
      vin,
    )) as Document | null;
  }
  return findLatestTekmetricWorkOrderByVinWithCustomerNameMongo(shopId, vin);
}

async function findLatestTekmetricWorkOrderByVinWithCustomerNameMongo(
  shopId: string | number,
  vin: string,
): Promise<Document | null> {
  const col = await collection();
  return col.findOne(
    {
      vin: { $regex: new RegExp(`^${vin}$`, "i") },
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
      customerName: { $exists: true, $nin: [null, "", "Unknown Customer"] },
    },
    // Task #960: sync-written mirror docs carry only Tekmetric's *Date
    // fields (updatedDate/createdDate), not updatedAt/createdAt —
    // include both so "most recent" holds for either writer.
    {
      sort: {
        updatedAt: -1,
        updatedDate: -1,
        createdAt: -1,
        createdDate: -1,
      },
      projection: { customerName: 1 },
    },
  );
}

/**
 * Finds the newest cached non-terminal (open) Tekmetric work order for a
 * VIN — the RO new jobs should land on when the caller has no explicit RO id.
 */
export async function findLatestOpenTekmetricWorkOrderByVin(
  shopId: string | number,
  vin: string,
): Promise<Document | null> {
  if (isTekmetricCachePgCanonical()) {
    return (await pg.findLatestOpenWorkOrderByVin(
      Number(shopId),
      vin,
    )) as Document | null;
  }
  return findLatestOpenTekmetricWorkOrderByVinMongo(shopId, vin);
}

async function findLatestOpenTekmetricWorkOrderByVinMongo(
  shopId: string | number,
  vin: string,
): Promise<Document | null> {
  const vinUpper = String(vin || "").toUpperCase();
  if (!vinUpper) return null;
  const col = await collection();
  return col.findOne(
    {
      shopId: { $in: [String(shopId), Number(shopId)] },
      vin: vinUpper,
      status: { $nin: TERMINAL_RO_STATUSES },
    },
    { sort: { fetchedAt: -1, updatedDate: -1 } },
  );
}

/**
 * Fetches cached work orders by their human RO numbers (the number printed on
 * the RO, stored as `workOrderNumber` — string or number across docs). Used to
 * re-hydrate declined-job line items from the raw RO cache when a `job_index`
 * row's lines are thin (indexed by a pre-May-2026 indexer that dropped
 * labor/part detail). Projects only the jobs payload.
 */
export async function findTekmetricWorkOrdersByNumbers(
  shopId: string | number,
  workOrderNumbers: Array<string | number>,
): Promise<Document[]> {
  if (isTekmetricCachePgCanonical()) {
    return (await pg.findWorkOrdersByNumbers(
      Number(shopId),
      workOrderNumbers,
    )) as Document[];
  }
  return findTekmetricWorkOrdersByNumbersMongo(shopId, workOrderNumbers);
}

async function findTekmetricWorkOrdersByNumbersMongo(
  shopId: string | number,
  workOrderNumbers: Array<string | number>,
): Promise<Document[]> {
  const wanted = Array.from(
    new Set(
      workOrderNumbers
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n)),
    ),
  );
  if (wanted.length === 0) return [];
  const col = await collection();
  return col
    .find(
      {
        shopId: { $in: [String(shopId), Number(shopId)] },
        workOrderNumber: { $in: [...wanted, ...wanted.map(String)] },
      },
      { projection: { workOrderNumber: 1, "data.jobs": 1 } },
    )
    .limit(wanted.length * 2)
    .toArray();
}

export async function listRecentTekmetricWorkOrdersForVehicle(
  shopId: string | number,
  vin: string,
  limit = 50,
): Promise<Document[]> {
  if (isTekmetricCachePgCanonical()) {
    return (await pg.listRecentWorkOrdersForVehicle(
      Number(shopId),
      vin,
      limit,
    )) as Document[];
  }
  return listRecentTekmetricWorkOrdersForVehicleMongo(shopId, vin, limit);
}

async function listRecentTekmetricWorkOrdersForVehicleMongo(
  shopId: string | number,
  vin: string,
  limit = 50,
): Promise<Document[]> {
  const vinUpper = String(vin || "").toUpperCase();
  if (!vinUpper) return [];
  const col = await collection();
  return col
    .find(
      {
        shopId: { $in: [String(shopId), Number(shopId)] },
        vin: vinUpper,
      },
      {
        projection: { inspections: 1, completedDate: 1, updatedDate: 1, createdDate: 1 },
        sort: { completedDate: -1 },
        limit,
      },
    )
    .toArray();
}

/* -------------------------------------------------------------------------- */
/* write                                                                       */
/* -------------------------------------------------------------------------- */

export interface TekmetricWorkOrderUpsertFields {
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

/**
 * Upserts a Tekmetric work-order snapshot keyed by (shopId, workOrderId).
 * The full `set` object is stored verbatim in the PG `payload` jsonb so
 * the Mongo doc shape survives the cutover.
 */
export async function upsertTekmetricWorkOrderSnapshot(
  shopId: string | number,
  workOrderId: string,
  set: TekmetricWorkOrderUpsertFields,
): Promise<void> {
  if (isTekmetricCachePgCanonical()) {
    await pg.upsertWorkOrderSnapshot(Number(shopId), workOrderId, set);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoTekmetricCache,
      "tekmetric.work_orders.upsert",
      () => upsertTekmetricWorkOrderSnapshotMongo(shopId, workOrderId, set),
    );
    return;
  }
  await upsertTekmetricWorkOrderSnapshotMongo(shopId, workOrderId, set);
}

async function upsertTekmetricWorkOrderSnapshotMongo(
  shopId: string | number,
  workOrderId: string,
  set: TekmetricWorkOrderUpsertFields,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId, workOrderId },
    { $set: set },
    { upsert: true },
  );
}
