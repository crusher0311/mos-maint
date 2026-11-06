import { getDb } from "@/lib/data/db";

/** Bounded, read-only diagnostic of retained Mongo snapshots, not a provider
 * inventory or canonical history query. Preserve the route's sample semantics. */
export async function readTekmetricVisibilitySample(shopId: number | string, numbers: string[]) {
  const db = await getDb();
  const scope = { shopId: { $in: [shopId, String(shopId)] } };
  const shop = await db.collection("shops").findOne(scope, {
    projection: { preferences: 1, "tekmetric.shopId": 1, "tekmetric.lastActiveSyncOutcome": 1 },
    maxTimeMS: 2000,
  });
  const rows = await db.collection("tekmetric_work_orders").find({
    ...scope, ...(numbers.length ? { workOrderNumber: { $in: numbers.flatMap(n => [n, Number(n)]) } } : {}),
  }, {
    projection: { workOrderNumber: 1, status: 1, vin: 1, odometer: 1, label: 1, contextRecoveryNeeded: 1 },
    maxTimeMS: 3000,
  }).limit(2001).toArray();
  return { shop, rows };
}
