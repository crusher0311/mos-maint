/**
 * Postgres-backed Protractor backfill-progress store — the read & write
 * surface used by `lib/data/repositories/protractor-backfill-progress.ts`
 * when `PROTRACTOR_OPS_PG_CANONICAL=1` (task #999).
 *
 * Backs the `protractor_backfill_progress` table
 * (lib/db/schema/integration-ops.ts). The Mongo `backfill_progress` doc
 * grows a large, evolving set of chunk-metric / reconcile bookkeeping
 * fields; only a handful map to typed columns (shopId, completed/
 * completedAt/complete, startedAt, lastRunAt, lastError/lastErrorAt,
 * currentChunkEnd, plus the inline chunk lease lockOwner/lockExpiresAt).
 * Everything else lives verbatim in the `extra` jsonb catch-all and is
 * spread back on read so callers see the exact same doc shape.
 *
 * The inline chunk lease (`findOneAndUpdate` on the progress doc in the
 * Mongo path) is preserved by an owner+expiry-guarded UPDATE ...
 * RETURNING that atomically claims the row iff it is unheld or stale.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { protractorBackfillProgress } from "@/lib/db/schema/integration-ops";
import type { BackfillProgressDoc } from "../protractor-backfill-progress";

// Columns that have a dedicated typed slot in the PG table. Everything
// else in a progress doc is round-tripped through the `extra` jsonb.
const TYPED_KEYS = new Set([
  "shopId",
  "startedAt",
  "completed",
  "completedAt",
  "complete",
  "lastRunAt",
  "lastError",
  "lastErrorAt",
  "currentChunkEnd",
  "lockOwner",
  "lockExpiresAt",
  "updatedAt",
  "_id",
]);

function rowToDoc(row: Record<string, any>): BackfillProgressDoc {
  const extra = (row.extra ?? {}) as Record<string, unknown>;
  const doc: Record<string, unknown> = { ...extra };
  doc.shopId = row.shopId;
  if (row.startedAt != null) doc.startedAt = row.startedAt;
  doc.completed = row.completed ?? false;
  if (row.completedAt != null) doc.completedAt = row.completedAt;
  if (row.complete != null) doc.complete = row.complete;
  if (row.lastRunAt != null) doc.lastRunAt = row.lastRunAt;
  if (row.lastError != null) doc.lastError = row.lastError;
  if (row.lastErrorAt != null) doc.lastErrorAt = row.lastErrorAt;
  if (row.currentChunkEnd != null) doc.currentChunkEnd = row.currentChunkEnd;
  return doc as BackfillProgressDoc;
}

// Split a flat set-doc into typed columns + an extra-merge map.
function splitSet(set: Record<string, unknown>): {
  cols: Record<string, unknown>;
  extra: Record<string, unknown>;
} {
  const cols: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(set)) {
    if (TYPED_KEYS.has(k)) cols[k] = v;
    else extra[k] = v;
  }
  return { cols, extra };
}

export async function findByShop(
  shopId: number,
): Promise<BackfillProgressDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(protractorBackfillProgress)
    .where(eq(protractorBackfillProgress.shopId, shopId))
    .limit(1);
  return rows[0] ? rowToDoc(rows[0]) : null;
}

export async function findAllProgress(): Promise<BackfillProgressDoc[]> {
  const db = getDb();
  const rows = await db.select().from(protractorBackfillProgress);
  return rows.map(rowToDoc);
}

/**
 * Merge-upsert: apply `$set` typed columns + merge `set` extras into the
 * jsonb, optionally `$inc` a numeric extra key, optionally `$unset` extra
 * keys, and optionally `$setOnInsert` extras (only on first insert).
 */
export async function upsertMerge(
  shopId: number,
  opts: {
    set?: Record<string, unknown>;
    setOnInsert?: Record<string, unknown>;
    inc?: Record<string, number>;
    unset?: string[];
  },
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const { cols, extra } = splitSet(opts.set ?? {});

  // Read-modify-write of the extra jsonb to honor $inc/$unset/$setOnInsert
  // exactly as Mongo would. Progress docs are per-shop and written under
  // the per-shop lease, so there is no concurrent-writer race here.
  const existing = await db
    .select()
    .from(protractorBackfillProgress)
    .where(eq(protractorBackfillProgress.shopId, shopId))
    .limit(1);
  const priorExtra = ((existing[0]?.extra ?? {}) as Record<string, unknown>) || {};
  const insertMode = existing.length === 0;

  const mergedExtra: Record<string, unknown> = { ...priorExtra };
  if (insertMode && opts.setOnInsert) {
    for (const [k, v] of Object.entries(opts.setOnInsert)) {
      if (TYPED_KEYS.has(k)) (cols as Record<string, unknown>)[k] = v;
      else mergedExtra[k] = v;
    }
  }
  for (const [k, v] of Object.entries(extra)) mergedExtra[k] = v;
  if (opts.inc) {
    for (const [k, delta] of Object.entries(opts.inc)) {
      mergedExtra[k] = (Number(mergedExtra[k]) || 0) + delta;
    }
  }
  if (opts.unset) {
    for (const k of opts.unset) {
      if (TYPED_KEYS.has(k)) (cols as Record<string, unknown>)[k] = null;
      else delete mergedExtra[k];
    }
  }

  await db
    .insert(protractorBackfillProgress)
    .values({
      shopId,
      ...(cols as Record<string, unknown>),
      extra: mergedExtra,
      updatedAt: now,
    } as typeof protractorBackfillProgress.$inferInsert)
    .onConflictDoUpdate({
      target: protractorBackfillProgress.shopId,
      set: {
        ...(cols as Record<string, unknown>),
        extra: mergedExtra,
        updatedAt: now,
      } as Partial<typeof protractorBackfillProgress.$inferInsert>,
    });
}

export async function deleteByShop(shopId: number): Promise<void> {
  const db = getDb();
  await db
    .delete(protractorBackfillProgress)
    .where(eq(protractorBackfillProgress.shopId, shopId));
}

/**
 * Inline chunk lease — the Mongo `findOneAndUpdate` that claims the
 * per-shop run lock iff it is unheld or stale, returning the post-update
 * doc (or null when another instance holds a fresh lock).
 *
 * Preserves the Mongo semantics:
 *   filter: shopId AND (inProgress != true OR lastActivityAt < stale)
 *   $set:   lastAttemptedAt, lastActivityAt, inProgress:true, retryCount:0,
 *           lastError:null, lastErrorAt:null
 *   upsert: true, returnDocument: 'after'
 *
 * inProgress / lastActivityAt / lastAttemptedAt / retryCount are extra
 * jsonb fields; the guard is expressed against the jsonb.
 */
export async function acquireLease(
  shopId: number,
  staleLockThreshold: Date,
  now: Date,
): Promise<BackfillProgressDoc | null> {
  const db = getDb();

  const setExtra = {
    lastAttemptedAt: now.toISOString(),
    lastActivityAt: now.toISOString(),
    inProgress: true,
    retryCount: 0,
  };

  // Try to claim/take-over an existing row iff not held or stale.
  const guardedUpdate = await db
    .update(protractorBackfillProgress)
    .set({
      lastError: null,
      lastErrorAt: null,
      extra: sql`COALESCE(${protractorBackfillProgress.extra}, '{}'::jsonb) || ${JSON.stringify(setExtra)}::jsonb`,
      updatedAt: now,
    })
    .where(
      and(
        eq(protractorBackfillProgress.shopId, shopId),
        or(
          sql`COALESCE((${protractorBackfillProgress.extra} ->> 'inProgress')::boolean, false) IS NOT TRUE`,
          sql`(${protractorBackfillProgress.extra} ->> 'lastActivityAt')::timestamptz < ${staleLockThreshold.toISOString()}`,
        ),
      ),
    )
    .returning();

  if (guardedUpdate[0]) return rowToDoc(guardedUpdate[0]);

  // No row updated: either the row exists with a fresh lock, or there is
  // no row yet. Try an insert-if-absent (mirrors Mongo upsert). If a row
  // already exists (fresh lock held), the conflict-do-nothing returns 0
  // rows → treat as "another instance owns it".
  const inserted = await db
    .insert(protractorBackfillProgress)
    .values({
      shopId,
      lastError: null,
      lastErrorAt: null,
      extra: setExtra,
      updatedAt: now,
    } as typeof protractorBackfillProgress.$inferInsert)
    .onConflictDoNothing({ target: protractorBackfillProgress.shopId })
    .returning();

  return inserted[0] ? rowToDoc(inserted[0]) : null;
}

/**
 * Stale-resume query. Mirrors the Mongo:
 *   completed != true AND (
 *     lastAttemptedAt < stale OR
 *     (no lastAttemptedAt AND lastRunAt < stale) OR
 *     (inProgress AND lastAttemptedAt < stale) OR
 *     (inProgress AND no lastAttemptedAt AND no lastRunAt AND startedAt < stale)
 *   )
 */
export async function findStaleBackfills(
  staleThreshold: Date,
): Promise<BackfillProgressDoc[]> {
  const db = getDb();
  const stale = staleThreshold.toISOString();
  const rows = await db
    .select()
    .from(protractorBackfillProgress)
    .where(
      and(
        sql`COALESCE(${protractorBackfillProgress.completed}, false) IS NOT TRUE`,
        or(
          sql`(${protractorBackfillProgress.extra} ->> 'lastAttemptedAt')::timestamptz < ${stale}`,
          sql`(${protractorBackfillProgress.extra} -> 'lastAttemptedAt') IS NULL AND ${protractorBackfillProgress.lastRunAt} < ${staleThreshold}`,
          sql`(${protractorBackfillProgress.extra} ->> 'inProgress')::boolean IS TRUE AND (${protractorBackfillProgress.extra} ->> 'lastAttemptedAt')::timestamptz < ${stale}`,
          sql`(${protractorBackfillProgress.extra} ->> 'inProgress')::boolean IS TRUE AND (${protractorBackfillProgress.extra} -> 'lastAttemptedAt') IS NULL AND (${protractorBackfillProgress.extra} -> 'lastRunAt') IS NULL AND ${protractorBackfillProgress.startedAt} < ${staleThreshold}`,
        ),
      ),
    );
  return rows.map(rowToDoc);
}

/**
 * New-shop fastpath projection: {shopId, completed} for a set of shops.
 */
export async function findProgressForShops(
  shopIds: number[],
): Promise<Array<{ shopId: number; completed: boolean }>> {
  if (shopIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      shopId: protractorBackfillProgress.shopId,
      completed: protractorBackfillProgress.completed,
    })
    .from(protractorBackfillProgress)
    .where(inArray(protractorBackfillProgress.shopId, shopIds));
  return rows.map((r) => ({ shopId: r.shopId, completed: r.completed ?? false }));
}
