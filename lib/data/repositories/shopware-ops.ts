// Repository for the Shop-Ware OPERATIONAL backfill-progress store
// (task #999).
//
// Backs the Mongo `shopware_backfill_progress` collection (the oddly
// named "ln" backfill-progress store) — the per-shop reverse-chrono
// backfill cursor + lease + chunk-metrics bookkeeping consumed by
// `app/api/cron/shopware-backfill/route.ts`, `lib/backfill/trigger.ts`,
// `lib/shopware-jobs-prewarm.ts`, and the admin sync-health view.
//
// Dispatch: when `isShopwareOpsPgCanonical()` we read & write Postgres
// (via `./pg/shopware-ops`) and shadow-write Mongo behind the
// `WRITE_MONGO_SHOPWARE_OPS` kill-switch. Default OFF keeps Mongo
// canonical and byte-identical to pre-cutover behavior.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isShopwareOpsPgCanonical,
  shouldShadowWriteMongoShopwareOps,
  shadowWriteMongoIntegrationOps,
} from "@/lib/db/integration-ops-write-mode";
import * as pg from "./pg/shopware-ops";

const COLLECTION = "shopware_backfill_progress";

export type AnyDoc = Record<string, unknown>;

/**
 * Mongo-style update operators supported by the backfill-progress
 * consumers. Mirrors `pg.ProgressUpdate`.
 */
export interface ProgressUpdate {
  set?: AnyDoc;
  inc?: Record<string, number>;
  setOnInsert?: AnyDoc;
  unset?: string[];
}

async function collection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(COLLECTION);
}

/** Read one shop's progress doc (keyed by numeric shopId). */
export async function findShopwareBackfillProgress(
  shopId: number,
): Promise<AnyDoc | null> {
  if (isShopwareOpsPgCanonical()) {
    return pg.findProgress(shopId);
  }
  const col = await collection();
  return (await col.findOne({ shopId })) as AnyDoc | null;
}

/** Read all progress docs (admin sync-health + platform-admin views). */
export async function findAllShopwareBackfillProgress(): Promise<AnyDoc[]> {
  if (isShopwareOpsPgCanonical()) {
    return pg.findAllProgress();
  }
  const col = await collection();
  return (await col.find({}).toArray()) as AnyDoc[];
}

/**
 * Upsert one shop's progress doc, mirroring Mongo
 * `updateOne({ shopId }, { $set, $inc, $setOnInsert }, { upsert })`.
 */
export async function updateShopwareBackfillProgress(
  shopId: number,
  update: ProgressUpdate,
  opts: { upsert?: boolean } = {},
): Promise<void> {
  if (isShopwareOpsPgCanonical()) {
    await pg.updateProgress(shopId, update, opts);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoShopwareOps,
      "shopware.backfill_progress.update",
      () => updateShopwareBackfillProgressMongo(shopId, update, opts),
    );
    return;
  }
  await updateShopwareBackfillProgressMongo(shopId, update, opts);
}

function toMongoUpdate(update: ProgressUpdate): Document {
  const doc: Document = {};
  if (update.set) doc.$set = update.set;
  if (update.inc) doc.$inc = update.inc;
  if (update.setOnInsert) doc.$setOnInsert = update.setOnInsert;
  if (update.unset) {
    doc.$unset = Object.fromEntries(update.unset.map((k) => [k, ""]));
  }
  return doc;
}

async function updateShopwareBackfillProgressMongo(
  shopId: number,
  update: ProgressUpdate,
  opts: { upsert?: boolean },
): Promise<void> {
  const col = await collection();
  await col.updateOne({ shopId }, toMongoUpdate(update), {
    upsert: !!opts.upsert,
  });
}
