/**
 * Per-shop single-flight lock for the Tekmetric INITIAL sync
 * (`syncSingleShop` — the "first vehicles" active-RO sweep that runs
 * when a shop connects).
 *
 * Why this exists (task #966): on 2026-07-29 ~1:42pm CT, connecting one
 * new Tekmetric shop during business hours started the initial sync
 * 8 times in 5 minutes — the connect route, its retries, and the
 * new-shop fastpath cron all kicked the same work with no overlap
 * guard, all inline on the busy web process. The parallel copies
 * fought over the shared Tekmetric rate budget and hammered Mongo,
 * degrading interactive traffic fleet-wide for ~20 minutes.
 *
 * This lock makes the initial sync single-flight per shop: the first
 * trigger runs, every overlapping trigger becomes a logged no-op.
 *
 * Design mirrors `inflight-lock.ts` (the full-page backfill lock) but
 * lives in its own collection because the initial sync predates any
 * `tekmetric_backfill_progress` row and has different lifetime
 * semantics (minutes, not days).
 *
 * - TTL: a crashed run never blocks the shop for more than
 *   DEFAULT_INITIAL_SYNC_LOCK_TTL_MS; the next trigger takes over.
 * - Owner-scoped release: a stale `finally` in a runaway promise can't
 *   clear a lock the TTL already handed to a new run.
 */

import os from "os";

export const INITIAL_SYNC_LOCK_COLLECTION = "tekmetric_initial_sync_locks";

// Worst observed healthy initial sync is ~4-5 minutes (1000 active ROs
// plus per-RO vehicle/customer lookups against the shared limiter).
// 15 minutes matches the settings GET watchdog that flips a stuck
// "running" state to "failed" — past that, the run is presumed dead and
// the lock may be taken over.
export const DEFAULT_INITIAL_SYNC_LOCK_TTL_MS = 15 * 60 * 1000;

export type InitialSyncLockResult =
  | { acquired: true; shopId: number; owner: string; expiresAt: Date }
  | {
      acquired: false;
      shopId: number;
      heldBy: string | null;
      startedAt: Date | null;
      heldUntil: Date | null;
    };

function buildOwnerId(): string {
  const host = process.env.HOSTNAME || os.hostname() || "unknown";
  return `${host}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Atomically take the per-shop initial-sync lock. Free or TTL-expired
 * locks are taken in a single findOneAndUpdate round trip so two
 * concurrent triggers cannot both win. Missing docs are inserted; a
 * concurrent insert loses via the unique _id (shopId) and reports busy.
 */
export async function acquireInitialSyncLock(
  db: any,
  shopId: number,
  ttlMs: number = DEFAULT_INITIAL_SYNC_LOCK_TTL_MS,
): Promise<InitialSyncLockResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const owner = buildOwnerId();
  const col = db.collection(INITIAL_SYNC_LOCK_COLLECTION);

  const res = await col.findOneAndUpdate(
    {
      _id: shopId,
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: null },
        { expiresAt: { $lte: now } },
      ],
    },
    { $set: { owner, startedAt: now, expiresAt } },
    { returnDocument: "after" },
  );
  const updated = res?.value ?? res;
  if (updated && updated.owner === owner) {
    return { acquired: true, shopId, owner, expiresAt };
  }

  // No takeable doc matched: either held by someone else, or missing.
  const existing = await col.findOne({ _id: shopId });
  if (existing) {
    return {
      acquired: false,
      shopId,
      heldBy: existing.owner || null,
      startedAt: existing.startedAt || null,
      heldUntil: existing.expiresAt || null,
    };
  }

  try {
    await col.insertOne({ _id: shopId, owner, startedAt: now, expiresAt });
    return { acquired: true, shopId, owner, expiresAt };
  } catch (err: any) {
    // E11000 duplicate key — a concurrent trigger inserted first.
    if (err?.code === 11000) {
      const doc = await col.findOne({ _id: shopId }).catch(() => null);
      return {
        acquired: false,
        shopId,
        heldBy: doc?.owner || null,
        startedAt: doc?.startedAt || null,
        heldUntil: doc?.expiresAt || null,
      };
    }
    throw err;
  }
}

/** Owner-scoped release; a no-op if the TTL already handed the lock off. */
export async function releaseInitialSyncLock(
  db: any,
  shopId: number,
  owner: string,
): Promise<void> {
  try {
    await db
      .collection(INITIAL_SYNC_LOCK_COLLECTION)
      .deleteOne({ _id: shopId, owner });
  } catch (err: any) {
    // Never let a release failure mask the sync result — the TTL will
    // reclaim the lock regardless.
    console.warn(
      `[Tekmetric InitialSyncLock] Shop ${shopId}: release failed (TTL will reclaim): ${err?.message || err}`,
    );
  }
}
