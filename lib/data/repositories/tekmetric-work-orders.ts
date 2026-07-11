// Repository for the `tekmetric_work_orders` collection.
//
// `tekmetric_work_orders` is written by the Tekmetric backfill / webhook
// sync pipeline. Those writer modules stay on the legacy allowlist; this
// repository only exposes the narrow read shapes the app needs so route
// code never reaches into the Mongo driver directly (enforced by
// `scripts/check-direct-db.cjs`).
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "tekmetric_work_orders";

async function collection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(COLLECTION);
}

/**
 * Lists a vehicle's most-recent Tekmetric work orders for a shop, projecting
 * only the fields the DVI pre-fill needs to mine prior inspection findings
 * (`extractPastInspectionFindings`). Reads the already-synced cache — issues
 * no upstream Tekmetric calls.
 *
 * `shopId` is stored as either a string or number across docs, so both are
 * matched. `vin` is upper-cased here to match how VINs are persisted.
 */
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
 * Finds the newest cached non-terminal (open) Tekmetric work order for a
 * VIN — the RO new jobs should land on when the caller has no explicit RO id.
 */
export async function findLatestOpenTekmetricWorkOrderByVin(
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
