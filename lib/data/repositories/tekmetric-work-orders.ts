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
