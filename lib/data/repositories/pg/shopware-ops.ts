/**
 * Postgres-backed Shop-Ware OPERATIONAL repository — the read & write
 * surface used by `lib/data/repositories/shopware-ops.ts` when
 * `SHOPWARE_OPS_PG_CANONICAL=1` (task #999).
 *
 * Backs the `shopware_backfill_progress` table (lib/db/schema/wave3.ts),
 * the PG twin of the Mongo `shopware_backfill_progress` collection (the
 * oddly-named "ln" backfill-progress store). The Mongo doc is keyed by
 * `shopId` and accretes a large, evolving set of bookkeeping fields
 * (cursor state, chunk metrics, lease timing). To preserve byte-for-byte
 * doc shape across the cutover we store the *entire* merged document in
 * the `extra` jsonb column and project a handful of typed columns
 * (`completed`, `completedAt`, `lastRunAt`, `rosProcessed`,
 * `cursor`) purely for typed access; on read the typed columns are
 * overlaid back onto the spread `extra` so callers see an identical doc.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { shopwareBackfillProgress } from "@/lib/db/schema/wave3";

type AnyDoc = Record<string, unknown>;

/**
 * Mongo-style update operators supported by the backfill-progress
 * consumers: `$set`, `$inc`, `$setOnInsert`, `$unset`.
 */
export interface ProgressUpdate {
  set?: AnyDoc;
  inc?: Record<string, number>;
  setOnInsert?: AnyDoc;
  unset?: string[];
}

function toDate(v: unknown): Date | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Rebuild the Mongo-shaped doc from a stored row: spread the `extra`
 * catch-all, then overlay the typed columns (as their native types) so
 * `currentChunkEnd`/dates come back as real values and `shopId` is the
 * numeric key.
 */
function rowToDoc(row: typeof shopwareBackfillProgress.$inferSelect): AnyDoc {
  const extra = (row.extra as AnyDoc | null) ?? {};
  const doc: AnyDoc = { ...extra };
  doc.shopId = row.mosShopId;
  doc.completed = row.completed;
  if (row.completedAt !== null) doc.completedAt = row.completedAt;
  if (row.lastRunAt !== null) doc.lastRunAt = row.lastRunAt;
  doc.totalRosProcessed = row.rosProcessed;
  return doc;
}

/**
 * Apply a Mongo-style update to an in-memory doc, mirroring the field
 * semantics of `$set`/`$inc`/`$setOnInsert`/`$unset`.
 */
function applyUpdate(
  base: AnyDoc,
  update: ProgressUpdate,
  isInsert: boolean,
): AnyDoc {
  const next: AnyDoc = { ...base };
  if (update.set) {
    for (const [k, v] of Object.entries(update.set)) {
      // Mongo drops keys explicitly set to `undefined` (as with
      // `completedAt: isComplete ? new Date() : undefined`). Preserve
      // that so we don't stamp stale timestamps.
      if (v === undefined) continue;
      next[k] = v;
    }
  }
  if (update.inc) {
    for (const [k, v] of Object.entries(update.inc)) {
      const cur = typeof next[k] === "number" ? (next[k] as number) : 0;
      next[k] = cur + v;
    }
  }
  if (isInsert && update.setOnInsert) {
    for (const [k, v] of Object.entries(update.setOnInsert)) {
      if (v === undefined) continue;
      next[k] = v;
    }
  }
  if (update.unset) {
    for (const k of update.unset) delete next[k];
  }
  return next;
}

/** Project the typed columns from a merged doc. */
function typedColumns(doc: AnyDoc, mosShopId: number): AnyDoc {
  return {
    mosShopId,
    completed:
      typeof doc.completed === "boolean" ? (doc.completed as boolean) : false,
    completedAt: toDate(doc.completedAt),
    lastRunAt: toDate(doc.lastRunAt),
    rosProcessed:
      typeof doc.totalRosProcessed === "number"
        ? (doc.totalRosProcessed as number)
        : 0,
    cursor:
      doc.currentChunkEnd !== undefined
        ? { currentChunkEnd: doc.currentChunkEnd }
        : null,
    extra: doc,
    updatedAt: new Date(),
  };
}

export async function findProgress(shopId: number): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(shopwareBackfillProgress)
    .where(eq(shopwareBackfillProgress.mosShopId, shopId))
    .limit(1);
  if (rows.length === 0) return null;
  return rowToDoc(rows[0]);
}

export async function findAllProgress(): Promise<AnyDoc[]> {
  const db = getDb();
  const rows = await db.select().from(shopwareBackfillProgress);
  return rows.map(rowToDoc);
}

/**
 * Upsert one progress doc, mirroring Mongo `updateOne(..., { upsert })`.
 * We read-modify-write so `$inc`/`$setOnInsert` semantics stay exact.
 */
export async function updateProgress(
  shopId: number,
  update: ProgressUpdate,
  opts: { upsert?: boolean } = {},
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(shopwareBackfillProgress)
    .where(eq(shopwareBackfillProgress.mosShopId, shopId))
    .limit(1);

  const isInsert = rows.length === 0;
  if (isInsert && !opts.upsert) return;

  const base: AnyDoc = isInsert
    ? { shopId }
    : rowToDoc(rows[0]);
  const merged = applyUpdate(base, update, isInsert);
  const cols = typedColumns(merged, shopId);

  if (isInsert) {
    await db
      .insert(shopwareBackfillProgress)
      .values(cols as typeof shopwareBackfillProgress.$inferInsert);
  } else {
    await db
      .update(shopwareBackfillProgress)
      .set(cols as Partial<typeof shopwareBackfillProgress.$inferInsert>)
      .where(eq(shopwareBackfillProgress.mosShopId, shopId));
  }
}

/**
 * Bulk reopen (Mongo `updateMany` used by the horizon-reopen sweep).
 * Kept for completeness; the shared `reopenCompletedShopsForHorizon`
 * helper stays on Mongo for now, so this is currently unused by runtime.
 */
export async function updateManyProgress(
  shopIds: number[],
  update: ProgressUpdate,
): Promise<void> {
  for (const shopId of shopIds) {
    await updateProgress(shopId, update, { upsert: false });
  }
}
