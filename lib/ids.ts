// lib/ids.ts
//
// Postgres-canonical (W3b, task #345). The `pg_counters` table is the
// source of truth; Mongo `counters` is shadow-mirrored during the soak
// window via the wave3 write-mode flag (`WRITE_MONGO_COUNTERS`).
//
// Historically this module talked to Mongo directly with
// `findOneAndUpdate({ $inc: { seq: 1 } })`. The atomic semantics now
// live in `lib/data/repositories/pg-counters.ts`; this file is a thin
// alias for the legacy import path.
import { nextSeq } from "@/lib/data/repositories/pg-counters";
import { getDb } from "@/lib/mongo";

/**
 * Atomically increments and returns the next numeric shopId
 * (1, 2, 3, …). The first call seeds the counter at 1.
 *
 * Floor-aligns to `MAX(shopId)` from the legacy Mongo `shops`
 * collection so that pre-existing IDs (which were created against the
 * Mongo counter) cannot collide with a freshly-seeded `pg_counters`
 * row. This is the same safeguard the platform-admin shop creation
 * path applies inline; centralizing it here means every caller of
 * `getNextShopId` benefits.
 */
export async function getNextShopId(): Promise<number> {
  let floor = 0;
  try {
    const db = await getDb();
    const last = await db
      .collection("shops")
      .find({}, { projection: { shopId: 1 } })
      .sort({ shopId: -1 })
      .limit(1)
      .toArray();
    const v = last[0]?.shopId;
    if (typeof v === "number" && Number.isFinite(v)) floor = v;
  } catch {
    // Floor-alignment is a safety net, not the source of truth. If
    // Mongo is unreachable the PG counter still gives a monotonic id.
  }
  return nextSeq("shopId", { floor });
}
