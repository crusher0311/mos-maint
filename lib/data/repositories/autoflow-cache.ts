// Repository for the AutoFlow integration caches: `autoflow_dvi_items`,
// `autoflow_events`, and `af_open`.
//
// AutoFlow DVI items and webhook events are append-only Mongo
// collections; `af_open` is an open-ticket roll-up keyed by
// (shopId, roNumber). Each public helper dispatches on
// `isAutoflowCachePgCanonical()`: when OFF it runs the original Mongo
// body verbatim (Mongo canonical, zero behaviour change); when ON it
// reads from Postgres and replays writes into Mongo via
// `shadowWriteMongoIntegrationCache` for the soak window.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isAutoflowCachePgCanonical,
  shouldShadowWriteMongoAutoflowCache,
  shadowWriteMongoIntegrationCache,
} from "@/lib/db/integration-cache-write-mode";
import * as pg from "./pg/autoflow-cache";

const DVI_ITEMS_COLLECTION = "autoflow_dvi_items";
const EVENTS_COLLECTION = "autoflow_events";
const AF_OPEN_COLLECTION = "af_open";

export interface AutoflowDviItemCacheDoc extends Document {
  shopId?: number;
  dviId?: string;
  itemId?: string;
  vin?: string;
  label?: string;
  severity?: string;
  note?: string;
}

export interface AutoflowEventCacheDoc extends Document {
  shopId?: number;
  eventType?: string;
  vin?: string;
  vehicleVin?: string;
  createdAt?: Date;
  payload?: any;
  roNumber?: string;
  customerName?: string;
}

export interface AfOpenCacheDoc extends Document {
  shopId?: number;
  roNumber?: string;
  payload?: any;
  updatedAt?: Date;
}

/* -------------------------------------------------------------------------- */
/* dvi_items                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * DVI items for a VIN, `_id`-stripped, capped at 500 — mirrors the read
 * in `lib/evidence.ts`.
 */
export async function findDviItemsByVin(
  vin: string,
): Promise<AutoflowDviItemCacheDoc[]> {
  if (isAutoflowCachePgCanonical()) {
    return (await pg.findDviItemsByVin(vin)) as AutoflowDviItemCacheDoc[];
  }
  const db = await getDb();
  return db
    .collection<AutoflowDviItemCacheDoc>(DVI_ITEMS_COLLECTION)
    .find({ vin }, { projection: { _id: 0 } })
    .limit(500)
    .toArray();
}

export interface AutoflowDviItemInsertInput {
  shopId: number;
  dviId?: string | null;
  itemId?: string | null;
  vin?: string | null;
  label?: string | null;
  severity?: string | null;
  note?: string | null;
  [k: string]: unknown;
}

export async function insertDviItems(
  items: AutoflowDviItemInsertInput[],
): Promise<void> {
  if (isAutoflowCachePgCanonical()) {
    await pg.insertDviItems(items);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoAutoflowCache,
      "autoflow.dvi_items.insert",
      () => insertDviItemsMongo(items),
    );
    return;
  }
  await insertDviItemsMongo(items);
}

async function insertDviItemsMongo(
  items: AutoflowDviItemInsertInput[],
): Promise<void> {
  if (!items.length) return;
  const db = await getDb();
  await db
    .collection<AutoflowDviItemCacheDoc>(DVI_ITEMS_COLLECTION)
    .insertMany(items as AutoflowDviItemCacheDoc[]);
}

/* -------------------------------------------------------------------------- */
/* events                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Latest AutoFlow webhook event for a VIN (case-insensitive across the
 * three VIN locations) — mirrors the read in the vehicle plan page.
 */
export async function findLatestEventByVin(
  shopId: number,
  vin: string,
): Promise<AutoflowEventCacheDoc | null> {
  if (isAutoflowCachePgCanonical()) {
    return (await pg.findLatestEventByVin(
      shopId,
      vin,
    )) as AutoflowEventCacheDoc | null;
  }
  const db = await getDb();
  const vinRegex = new RegExp(`^${vin}$`, "i");
  return db.collection<AutoflowEventCacheDoc>(EVENTS_COLLECTION).findOne(
    {
      shopId,
      $or: [
        { vehicleVin: { $regex: vinRegex } },
        { vin: { $regex: vinRegex } },
        { "payload.vehicle.vin": { $regex: vinRegex } },
      ],
    } as any,
    { sort: { createdAt: -1 } },
  );
}

export interface AutoflowEventInsertInput {
  shopId?: number | null;
  eventType?: string | null;
  vin?: string | null;
  [k: string]: unknown;
}

export async function insertEvent(
  event: AutoflowEventInsertInput,
): Promise<void> {
  if (isAutoflowCachePgCanonical()) {
    await pg.insertEvent(event);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoAutoflowCache,
      "autoflow.events.insert",
      () => insertEventMongo(event),
    );
    return;
  }
  await insertEventMongo(event);
}

async function insertEventMongo(
  event: AutoflowEventInsertInput,
): Promise<void> {
  const db = await getDb();
  await db
    .collection<AutoflowEventCacheDoc>(EVENTS_COLLECTION)
    .insertOne(event as AutoflowEventCacheDoc);
}

/* -------------------------------------------------------------------------- */
/* af_open                                                                     */
/* -------------------------------------------------------------------------- */

export interface AfOpenUpsertInput {
  shopId: number;
  roNumber: string;
  payload: unknown;
}

export async function upsertAfOpen(input: AfOpenUpsertInput): Promise<void> {
  if (isAutoflowCachePgCanonical()) {
    await pg.upsertAfOpen(input);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoAutoflowCache,
      "autoflow.af_open.upsert",
      () => upsertAfOpenMongo(input),
    );
    return;
  }
  await upsertAfOpenMongo(input);
}

async function upsertAfOpenMongo(input: AfOpenUpsertInput): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db.collection<AfOpenCacheDoc>(AF_OPEN_COLLECTION).updateOne(
    { shopId: input.shopId, roNumber: input.roNumber },
    { $set: { payload: input.payload, updatedAt: now } },
    { upsert: true },
  );
}

export async function findAfOpen(
  shopId: number,
  roNumber: string,
): Promise<AfOpenCacheDoc | null> {
  if (isAutoflowCachePgCanonical()) {
    return (await pg.findAfOpen(shopId, roNumber)) as AfOpenCacheDoc | null;
  }
  const db = await getDb();
  return db
    .collection<AfOpenCacheDoc>(AF_OPEN_COLLECTION)
    .findOne({ shopId, roNumber });
}
