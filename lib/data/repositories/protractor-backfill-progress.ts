// Repository for the Protractor `backfill_progress` collection — the
// per-shop backfill walk state, including the inline chunk lease the
// sync engine claims via `findOneAndUpdate` on the progress doc itself.
//
// Task #999: reads/writes dispatch to Postgres when
// `PROTRACTOR_OPS_PG_CANONICAL=1`, with a Mongo shadow write during the
// soak window (`WRITE_MONGO_PROTRACTOR_OPS`). Default flag OFF keeps
// Mongo canonical — byte-identical to prior behavior.
//
// The progress doc grows an evolving set of chunk-metric / reconcile
// bookkeeping fields; the repo takes flat Mongo-shaped `$set` / `$inc` /
// `$unset` / `$setOnInsert` maps so callers keep expressing the exact
// same mutation, and returns docs in the same shape (typed columns + the
// `extra` jsonb catch-all spread back).
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isProtractorOpsPgCanonical,
  shouldShadowWriteMongoProtractorOps,
  shadowWriteMongoIntegrationOps,
} from "@/lib/db/integration-ops-write-mode";
import * as pg from "./pg/protractor-backfill-progress";

const COLLECTION = "backfill_progress";

// The progress doc is intentionally open-shaped: the sync engine adds
// chunk-metric / reconcile bookkeeping fields over time. Only the stable
// operational fields are pinned here; the rest ride along.
export interface BackfillProgressDoc extends Document {
  shopId: number;
  startedAt?: Date;
  completed?: boolean;
  completedAt?: Date;
  complete?: boolean;
  lastRunAt?: Date;
  lastError?: string | null;
  lastErrorAt?: Date | null;
  currentChunkEnd?: Date;
  inProgress?: boolean;
  lastActivityAt?: Date;
  lastAttemptedAt?: Date;
  retryCount?: number;
  logicVersion?: number;
  currentChunkStart?: Date;
  currentCursor?: string;
  lastInvoiceCount?: number;
  lastChunkMetrics?: { durationMs?: number; [k: string]: unknown };
  recentChunkMetrics?: Array<Record<string, unknown>>;
  pendingAttempt?: {
    chunkEnd?: Date | string;
    days?: number;
    startedAt?: Date | string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

async function collection(): Promise<Collection<BackfillProgressDoc>> {
  const db = await getDb();
  return db.collection<BackfillProgressDoc>(COLLECTION);
}

/* ------------------------------------------------------------------ reads */

export async function findByShop(
  shopId: number,
): Promise<BackfillProgressDoc | null> {
  if (isProtractorOpsPgCanonical()) return pg.findByShop(shopId);
  const col = await collection();
  return col.findOne({ shopId });
}

export async function findAllProgress(): Promise<BackfillProgressDoc[]> {
  if (isProtractorOpsPgCanonical()) return pg.findAllProgress();
  const col = await collection();
  return col.find({}).toArray();
}

export async function findStaleBackfills(
  staleThreshold: Date,
): Promise<BackfillProgressDoc[]> {
  if (isProtractorOpsPgCanonical()) return pg.findStaleBackfills(staleThreshold);
  const col = await collection();
  return col
    .find({
      completed: { $ne: true },
      $or: [
        { lastAttemptedAt: { $lt: staleThreshold } },
        {
          lastAttemptedAt: { $exists: false },
          lastRunAt: { $lt: staleThreshold },
        },
        { inProgress: true, lastAttemptedAt: { $lt: staleThreshold } },
        {
          inProgress: true,
          lastAttemptedAt: { $exists: false },
          lastRunAt: { $exists: false },
          startedAt: { $lt: staleThreshold },
        },
      ],
    })
    .toArray();
}

export async function findProgressForShops(
  shopIds: number[],
): Promise<Array<{ shopId: number; completed: boolean }>> {
  if (isProtractorOpsPgCanonical()) return pg.findProgressForShops(shopIds);
  const col = await collection();
  const docs = await col
    .find({ shopId: { $in: shopIds } })
    .project({ shopId: 1, completed: 1 })
    .toArray();
  return docs.map((d: any) => ({
    shopId: Number(d.shopId),
    completed: d.completed === true,
  }));
}

/* ----------------------------------------------------------------- writes */

/**
 * Flat Mongo-shaped merge mutation. `set`/`setOnInsert`/`inc`/`unset`
 * map 1:1 onto Mongo `$set`/`$setOnInsert`/`$inc`/`$unset` and are always
 * an upsert (mirroring the historical `{ upsert: true }`).
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
  if (isProtractorOpsPgCanonical()) {
    await pg.upsertMerge(shopId, opts);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.backfill_progress.upsertMerge",
      () => upsertMergeMongo(shopId, opts),
    );
    return;
  }
  await upsertMergeMongo(shopId, opts);
}

async function upsertMergeMongo(
  shopId: number,
  opts: {
    set?: Record<string, unknown>;
    setOnInsert?: Record<string, unknown>;
    inc?: Record<string, number>;
    unset?: string[];
  },
): Promise<void> {
  const col = await collection();
  const update: Record<string, unknown> = {};
  if (opts.set) update.$set = opts.set;
  if (opts.setOnInsert) update.$setOnInsert = opts.setOnInsert;
  if (opts.inc) update.$inc = opts.inc;
  if (opts.unset) {
    update.$unset = Object.fromEntries(opts.unset.map((k) => [k, ""]));
  }
  await col.updateOne({ shopId }, update, { upsert: true });
}

export async function deleteByShop(shopId: number): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.deleteByShop(shopId);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.backfill_progress.deleteByShop",
      () => deleteByShopMongo(shopId),
    );
    return;
  }
  await deleteByShopMongo(shopId);
}

async function deleteByShopMongo(shopId: number): Promise<void> {
  const col = await collection();
  await col.deleteOne({ shopId });
}

/**
 * Inline per-shop chunk lease — claims the run lock iff it is unheld or
 * stale, returning the post-update doc (or null when another instance
 * holds a fresh lock). Mirrors the Mongo `findOneAndUpdate` with
 * `upsert: true, returnDocument: 'after'` and the duplicate-key ⇒ "held"
 * semantics.
 */
export async function acquireLease(
  shopId: number,
  staleLockThreshold: Date,
  now: Date,
): Promise<BackfillProgressDoc | null> {
  if (isProtractorOpsPgCanonical()) {
    const result = await pg.acquireLease(shopId, staleLockThreshold, now);
    // Shadow the lock into Mongo (best-effort) so the mirror reflects the
    // holder during the soak window. Only shadow when we actually claimed.
    if (result) {
      await shadowWriteMongoIntegrationOps(
        shouldShadowWriteMongoProtractorOps,
        "protractor.backfill_progress.acquireLease",
        async () => {
          const col = await collection();
          await col.updateOne(
            { shopId },
            {
              $set: {
                lastAttemptedAt: now,
                lastActivityAt: now,
                inProgress: true,
                lastError: null,
                lastErrorAt: null,
                retryCount: 0,
              },
            },
            { upsert: true },
          );
        },
      );
    }
    return result;
  }
  return acquireLeaseMongo(shopId, staleLockThreshold, now);
}

async function acquireLeaseMongo(
  shopId: number,
  staleLockThreshold: Date,
  now: Date,
): Promise<BackfillProgressDoc | null> {
  const col = await collection();
  try {
    const lockResult = await col.findOneAndUpdate(
      {
        shopId,
        $or: [
          { inProgress: { $ne: true } },
          { lastActivityAt: { $lt: staleLockThreshold } },
        ],
      },
      {
        $set: {
          lastAttemptedAt: now,
          lastActivityAt: now,
          inProgress: true,
          lastError: null,
          lastErrorAt: null,
          retryCount: 0,
        },
      },
      { upsert: true, returnDocument: "after" },
    );
    return (lockResult as BackfillProgressDoc | null) ?? null;
  } catch (err: any) {
    if (err?.code === 11000) {
      // Doc already exists with a fresh lock — another instance owns it.
      return null;
    }
    throw err;
  }
}
