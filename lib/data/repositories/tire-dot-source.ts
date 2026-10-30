import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";
import { getClient } from "@/lib/db/drizzle";
import { isTekmetricCachePgCanonical } from "@/lib/db/integration-cache-write-mode";
import { TIRE_DOT_LIMITS } from "@/lib/tire-dot-report-contract";

export const tireSourceMode = () => isTekmetricCachePgCanonical() ? "pg" as const : "mongo" as const;
/** Only the worker calls this repository. No provider client, operational writes,
 * OFFSET scan, or source-wide query is allowed here. Index installation is separate. */
export async function readTireSourcePage(shopId: number, after: string | null, mode: "pg" | "mongo") {
  if (mode !== tireSourceMode()) throw new Error("Source store changed; start a new report");
  if (mode === "pg") {
    return getClient().begin(async tx => {
      await tx.unsafe("SET LOCAL statement_timeout='2000ms'");
      const rows = await tx.unsafe(`SELECT work_order_id AS key, status,
        CASE WHEN pg_column_size(payload) <= 1000000 THEN payload ELSE NULL END AS payload,
        pg_column_size(payload) AS bytes FROM tekmetric_work_orders
        WHERE shop_id=$1 AND ($2::text IS NULL OR work_order_id > $2)
        ORDER BY work_order_id LIMIT $3`, [shopId, after, TIRE_DOT_LIMITS.page]);
      if (rows.some(r => Number(r.bytes) > 1_000_000)) throw new Error("Retained invoice exceeds safe extraction size");
      return rows.map(r => ({ key: String(r.key), doc: { ...r.payload, ...(r.status != null ? { status: r.status } : {}), shopId, workOrderId: r.key } }));
    });
  }
  // Approved shop+_id index is deliberately hinted: never silently COLLSCAN.
  const rows = await (await getDb()).collection("tekmetric_work_orders").aggregate([
    { $match: {
    shopId: { $in: [shopId, String(shopId)] },
    ...(after ? { _id: { $gt: new ObjectId(after) } } : {}),
    } }, { $sort: { _id: 1 } }, { $limit: TIRE_DOT_LIMITS.page },
    { $project: { shopId: 1, workOrderId: 1, status: 1, repairOrderStatus: 1,
      vin: 1, vehicleYear: 1, vehicleMake: 1, vehicleModel: 1,
      deletedDate: 1, deletedAt: 1, deleted: 1, isDeleted: 1,
      archived: 1, isArchived: 1, archivedDate: 1,
      oversized: { $gt: [{ $bsonSize: "$$ROOT" }, 1_000_000] },
      data: { $cond: [{ $lte: [{ $bsonSize: "$$ROOT" }, 1_000_000] }, "$data", null] },
    } },
  ], { hint: "tire_dot_shop_id", maxTimeMS: 2_000 }).toArray();
  if (rows.some(r => !(r._id instanceof ObjectId))) throw new Error("Unsupported retained record key; source coverage cannot be established");
  if (rows.some(r => r.oversized)) throw new Error("Retained invoice exceeds safe extraction size");
  return rows.map(doc => ({ key: String(doc._id), doc }));
}
