/**
 * Repository for the `protractor_callback_events` store — the webhook
 * event records threaded across the Protractor callback request path
 * (app/api/callbacks/protractor) and the protractor-sync /
 * protractor-webhook-health / protractor-af-log-tail crons.
 *
 * Task #1006 (finishing task #999): the old flow threaded a Mongo
 * ObjectId across ~40 call sites, which the PG table (serial id) could
 * not honor. The contract is now a store-agnostic string key
 * (`CallbackEventKey`):
 *
 *   - Mongo-canonical (default, PROTRACTOR_OPS_PG_CANONICAL unset/0):
 *     the key is the inserted ObjectId's 24-char hex, and every update
 *     targets `_id` — byte-identical documents and query shapes to the
 *     pre-task behavior.
 *   - PG-canonical (flag =1): the key is an app-generated UUID stored in
 *     the `event_key` column; reads/writes go to Postgres with a
 *     non-fatal Mongo shadow write (WRITE_MONGO_PROTRACTOR_OPS) during
 *     the soak. Shadow docs carry `eventKey` so shadow updates can
 *     target the same logical event without an ObjectId.
 */
import { randomUUID } from "node:crypto";
import { ObjectId, type Collection, type Db, type Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isProtractorOpsPgCanonical,
  shouldShadowWriteMongoProtractorOps,
  shadowWriteMongoIntegrationOps,
} from "@/lib/db/integration-ops-write-mode";
import * as pg from "./pg/protractor-callback-events";

const COLLECTION = "protractor_callback_events";

/** Opaque per-event key: ObjectId hex (Mongo mode) or UUID (PG mode). */
export type CallbackEventKey = string;

async function collection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(COLLECTION);
}

/**
 * Mongo filter for a key. ObjectId-hex keys target `_id` (canonical
 * Mongo mode); any other shape (PG-mode UUID) targets the `eventKey`
 * field carried by shadow-written docs — so a mid-request flag flip
 * degrades to a no-op update instead of a crash.
 */
function mongoKeyFilter(key: CallbackEventKey): Document {
  return ObjectId.isValid(key) && String(new ObjectId(key)) === key
    ? { _id: new ObjectId(key) }
    : { eventKey: key };
}

/* ------------------------------------------------------------------ */
/* Inserts                                                             */
/* ------------------------------------------------------------------ */

export async function insertPostEvent(fields: {
  payload: unknown;
  workOrderId: string;
  status: string | null;
  connectionId: string;
  shopId: number | string | null | undefined;
}): Promise<CallbackEventKey> {
  const receivedAt = new Date();
  if (isProtractorOpsPgCanonical()) {
    const eventKey = randomUUID();
    const shopIdNum = fields.shopId == null ? null : Number(fields.shopId);
    await pg.insertPostEvent({
      eventKey,
      receivedAt,
      payload: fields.payload,
      workOrderId: fields.workOrderId,
      status: fields.status,
      connectionId: fields.connectionId,
      shopId: Number.isFinite(shopIdNum as number) ? (shopIdNum as number) : null,
    });
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.insertPost",
      async () => {
        const col = await collection();
        await col.insertOne({
          eventKey,
          receivedAt,
          payload: fields.payload,
          workOrderId: fields.workOrderId,
          status: fields.status,
          connectionId: fields.connectionId,
          shopId: fields.shopId,
          processed: false,
        });
      },
    );
    return eventKey;
  }
  const col = await collection();
  const res = await col.insertOne({
    receivedAt,
    payload: fields.payload,
    workOrderId: fields.workOrderId,
    status: fields.status,
    connectionId: fields.connectionId,
    shopId: fields.shopId,
    processed: false,
  });
  return res.insertedId.toHexString();
}

export async function insertGetEvent(fields: {
  connectionId: string;
  objectType: string;
  objectId: string;
  operation: string | null;
  shopId: number;
}): Promise<CallbackEventKey> {
  const receivedAt = new Date();
  if (isProtractorOpsPgCanonical()) {
    const eventKey = randomUUID();
    await pg.insertGetEvent({
      eventKey,
      receivedAt,
      connectionId: fields.connectionId,
      objectType: fields.objectType,
      objectId: fields.objectId,
      operation: fields.operation,
      shopId: fields.shopId,
    });
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.insertGet",
      async () => {
        const col = await collection();
        await col.insertOne({
          eventKey,
          receivedAt,
          method: "GET",
          connectionId: fields.connectionId,
          objectType: fields.objectType,
          objectId: fields.objectId,
          operation: fields.operation,
          shopId: fields.shopId,
          processed: false,
          attempts: 0,
          priority: 1,
        });
      },
    );
    return eventKey;
  }
  const col = await collection();
  const res = await col.insertOne({
    receivedAt,
    method: "GET",
    connectionId: fields.connectionId,
    objectType: fields.objectType,
    objectId: fields.objectId,
    operation: fields.operation,
    shopId: fields.shopId,
    processed: false,
    attempts: 0,
    priority: 1,
  });
  return res.insertedId.toHexString();
}

/* ------------------------------------------------------------------ */
/* Dedup / rate-limit reads                                            */
/* ------------------------------------------------------------------ */

export async function countRecentByConnection(
  connectionId: string,
  windowStart: Date,
): Promise<number> {
  if (isProtractorOpsPgCanonical()) {
    return pg.countRecentByConnection(connectionId, windowStart);
  }
  const col = await collection();
  return col.countDocuments({ connectionId, receivedAt: { $gte: windowStart } });
}

export async function hasRecentProcessedPost(
  workOrderId: string,
  status: string | null,
  since: Date,
): Promise<boolean> {
  if (isProtractorOpsPgCanonical()) {
    return pg.hasRecentProcessedPost(workOrderId, status, since);
  }
  const col = await collection();
  const doc = await col.findOne({
    workOrderId,
    status,
    processed: true,
    processedAt: { $gte: since },
  });
  return !!doc;
}

export async function findRecentProcessedGet(
  shopId: number,
  objectType: string,
  objectId: string,
  operation: string | null,
  since: Date,
): Promise<{ processedAt: Date } | null> {
  if (isProtractorOpsPgCanonical()) {
    return pg.findRecentProcessedGet(shopId, objectType, objectId, operation, since);
  }
  const col = await collection();
  const doc = await col.findOne({
    shopId,
    objectType,
    objectId,
    operation,
    processed: true,
    processedAt: { $gte: since },
  });
  return doc?.processedAt ? { processedAt: doc.processedAt as Date } : null;
}

/* ------------------------------------------------------------------ */
/* Status updates                                                      */
/* ------------------------------------------------------------------ */

export interface ProcessedFields {
  vin?: string;
  workOrderNumber?: string | number | null;
  noAction?: boolean;
  deletedFromDashboard?: boolean;
}

export async function markProcessed(
  key: CallbackEventKey,
  fields: ProcessedFields = {},
): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.markProcessedByKey(key, fields);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.markProcessed",
      () => markProcessedMongo(key, fields),
    );
    return;
  }
  await markProcessedMongo(key, fields);
}

async function markProcessedMongo(
  key: CallbackEventKey,
  fields: ProcessedFields,
): Promise<void> {
  const col = await collection();
  await col.updateOne(mongoKeyFilter(key), {
    $set: {
      processed: true,
      processedAt: new Date(),
      ...(fields.vin !== undefined ? { vin: fields.vin } : {}),
      ...(fields.workOrderNumber !== undefined
        ? { workOrderNumber: fields.workOrderNumber }
        : {}),
      ...(fields.noAction !== undefined ? { noAction: fields.noAction } : {}),
      ...(fields.deletedFromDashboard !== undefined
        ? { deletedFromDashboard: fields.deletedFromDashboard }
        : {}),
    },
  });
}

/** POST closed-WO path: stamp one unprocessed event for (workOrderId, status). */
export async function markOneProcessedByWorkOrderStatus(
  workOrderId: string,
  status: string | null,
): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.markOneProcessedByWorkOrderStatus(workOrderId, status);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.markOneByWoStatus",
      async () => {
        const col = await collection();
        await col.updateOne(
          { workOrderId, status, processed: false },
          { $set: { processed: true, processedAt: new Date() } },
        );
      },
    );
    return;
  }
  const col = await collection();
  await col.updateOne(
    { workOrderId, status, processed: false },
    { $set: { processed: true, processedAt: new Date() } },
  );
}

/** Queue-drain path: stamp one unprocessed event for (objectId, objectType). */
export async function markOneProcessedByObject(
  objectId: string,
  objectType: string,
  fields: { vin?: string; workOrderNumber?: string | number | null } = {},
): Promise<void> {
  const set = {
    processed: true,
    processedAt: new Date(),
    ...(fields.vin !== undefined ? { vin: fields.vin } : {}),
    ...(fields.workOrderNumber !== undefined
      ? { workOrderNumber: fields.workOrderNumber }
      : {}),
  };
  if (isProtractorOpsPgCanonical()) {
    await pg.markOneProcessedByObject(objectId, objectType, fields);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.markOneByObject",
      async () => {
        const col = await collection();
        await col.updateOne({ objectId, objectType, processed: false }, { $set: set });
      },
    );
    return;
  }
  const col = await collection();
  await col.updateOne({ objectId, objectType, processed: false }, { $set: set });
}

/** `$set lastAttemptAt [,lastError]` + `$inc attempts`. */
export async function recordAttempt(
  key: CallbackEventKey,
  lastError?: string,
): Promise<void> {
  const doMongo = async () => {
    const col = await collection();
    await col.updateOne(mongoKeyFilter(key), {
      $set: {
        lastAttemptAt: new Date(),
        ...(lastError !== undefined ? { lastError: lastError.slice(0, 500) } : {}),
      },
      $inc: { attempts: 1 },
    });
  };
  if (isProtractorOpsPgCanonical()) {
    await pg.recordAttempt(key, lastError);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.recordAttempt",
      doMongo,
    );
    return;
  }
  await doMongo();
}

/** `$set processingStartedAt` + `$inc attempts` (queue-drain start stamp). */
export async function recordProcessingStarted(key: CallbackEventKey): Promise<void> {
  const doMongo = async () => {
    const col = await collection();
    await col.updateOne(mongoKeyFilter(key), {
      $set: { processingStartedAt: new Date() },
      $inc: { attempts: 1 },
    });
  };
  if (isProtractorOpsPgCanonical()) {
    await pg.recordProcessingStarted(key);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.recordProcessingStarted",
      doMongo,
    );
    return;
  }
  await doMongo();
}

/** `$set lastError, lastErrorAt` (queue-drain failure stamp; no attempt inc). */
export async function recordError(key: CallbackEventKey, message: string): Promise<void> {
  const doMongo = async () => {
    const col = await collection();
    await col.updateOne(mongoKeyFilter(key), {
      $set: { lastError: message, lastErrorAt: new Date() },
    });
  };
  if (isProtractorOpsPgCanonical()) {
    await pg.recordError(key, message);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.recordError",
      doMongo,
    );
    return;
  }
  await doMongo();
}

/* ------------------------------------------------------------------ */
/* Queue / cron reads                                                  */
/* ------------------------------------------------------------------ */

export interface PendingGetEvent {
  key: CallbackEventKey;
  shopId: number;
  objectType: string | null;
  objectId: string | null;
  operation: string | null;
}

export async function findPendingGetEvents(
  limit: number,
  maxAttempts: number,
): Promise<PendingGetEvent[]> {
  if (isProtractorOpsPgCanonical()) {
    const rows = await pg.findPendingGetEvents(limit, maxAttempts);
    return rows.map((r) => ({
      key: r.eventKey,
      shopId: Number(r.shopId),
      objectType: r.objectType,
      objectId: r.objectId,
      operation: r.operation,
    }));
  }
  const col = await collection();
  const docs = await col
    .find({
      method: "GET",
      processed: false,
      $or: [{ attempts: { $exists: false } }, { attempts: { $lt: maxAttempts } }],
    })
    .sort({ priority: 1, receivedAt: 1 })
    .limit(limit)
    .toArray();
  return docs.map((d) => ({
    key: (d._id as ObjectId).toHexString(),
    shopId: d.shopId as number,
    objectType: (d.objectType as string) ?? null,
    objectId: (d.objectId as string) ?? null,
    operation: (d.operation as string) ?? null,
  }));
}

/**
 * Webhook-health: per-shop received counts since `since`.
 *
 * `dbOverride` exists solely for the webhook-health route's `__deps`
 * test seam (fake Mongo db); production callers pass nothing.
 */
export async function countsByShopSince(
  shopIds: number[],
  since: Date,
  dbOverride?: Db,
): Promise<Array<{ shopId: number; count: number }>> {
  if (isProtractorOpsPgCanonical()) {
    return pg.countsByShopSince(shopIds, since);
  }
  const col = dbOverride ? dbOverride.collection(COLLECTION) : await collection();
  const rows = await col
    .aggregate([
      { $match: { receivedAt: { $gte: since }, shopId: { $in: shopIds } } },
      { $group: { _id: "$shopId", count: { $sum: 1 } } },
    ])
    .toArray();
  return (rows as Array<{ _id: number; count: number }>).map((r) => ({
    shopId: Number(r._id),
    count: r.count,
  }));
}

/** Webhook-health processing-lag: GET events by receivedAt/processedAt window. */
export async function countGetSince(
  field: "receivedAt" | "processedAt",
  since: Date,
  dbOverride?: Db,
): Promise<number> {
  if (isProtractorOpsPgCanonical()) {
    return pg.countGetSince(field, since);
  }
  const col = dbOverride ? dbOverride.collection(COLLECTION) : await collection();
  return col.countDocuments({ method: "GET", [field]: { $gte: since } });
}

/** af-log-tail: (connectionId, shopId) pairs with most-recent receivedAt. */
export async function connectionShopPairs(): Promise<
  Array<{ connectionId: string; shopId: number; last: Date | null }>
> {
  if (isProtractorOpsPgCanonical()) {
    return pg.connectionShopPairs();
  }
  const col = await collection();
  const rows = await col
    .aggregate([
      { $match: { connectionId: { $exists: true, $ne: null }, shopId: { $exists: true, $ne: null } } },
      { $group: { _id: { cid: "$connectionId", shopId: "$shopId" }, last: { $max: "$receivedAt" } } },
    ])
    .toArray();
  return rows
    .map((row: any) => ({
      connectionId: row?._id?.cid,
      shopId: row?._id?.shopId,
      last: row?.last ? new Date(row.last) : null,
    }))
    .filter(
      (r: any): r is { connectionId: string; shopId: number; last: Date | null } =>
        typeof r.connectionId === "string" && typeof r.shopId === "number",
    );
}

/**
 * Mongo-only index ensure used by the webhook-health cron. No-op when
 * PG is canonical (PG indexes ship in drizzle/0024).
 */
export async function ensureHealthScanIndexes(dbOverride?: Db): Promise<void> {
  if (isProtractorOpsPgCanonical()) return;
  const col = dbOverride ? dbOverride.collection(COLLECTION) : await collection();
  await col.createIndex({ receivedAt: -1 }, { name: "receivedAt_-1" }).catch(() => {});
  await col
    .createIndex({ method: 1, receivedAt: -1 }, { name: "method_1_receivedAt_-1" })
    .catch(() => {});
  await col
    .createIndex({ method: 1, processedAt: -1 }, { name: "method_1_processedAt_-1" })
    .catch(() => {});
}
