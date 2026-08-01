// Repository for the `protractor_service_items` collection.
//
// Per-(shopId, serviceItemId) cache of the vehicle decoded from a
// Protractor service item (used as a cache during backfill so repeated
// service items don't re-hit the Protractor vehicle API).
//
// Task #999: reads/writes dispatch to Postgres when
// `PROTRACTOR_OPS_PG_CANONICAL=1`, with a Mongo shadow write during the
// soak window (`WRITE_MONGO_PROTRACTOR_OPS`). Default flag OFF keeps
// Mongo canonical — byte-identical to prior behavior.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isProtractorOpsPgCanonical,
  shouldShadowWriteMongoProtractorOps,
  shadowWriteMongoIntegrationOps,
} from "@/lib/db/integration-ops-write-mode";
import * as pg from "./pg/protractor-service-items";

const COLLECTION = "protractor_service_items";

export interface ProtractorServiceItemDoc extends Document {
  shopId: number;
  serviceItemId: string;
  vin: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  engine: string | null;
  fetchedAt: Date;
}

async function collection(): Promise<Collection<ProtractorServiceItemDoc>> {
  const db = await getDb();
  return db.collection<ProtractorServiceItemDoc>(COLLECTION);
}

export async function findServiceItem(
  shopId: number,
  serviceItemId: string,
): Promise<ProtractorServiceItemDoc | null> {
  if (isProtractorOpsPgCanonical()) {
    return pg.findServiceItem(shopId, serviceItemId);
  }
  return findServiceItemMongo(shopId, serviceItemId);
}

async function findServiceItemMongo(
  shopId: number,
  serviceItemId: string,
): Promise<ProtractorServiceItemDoc | null> {
  const col = await collection();
  return col.findOne({ shopId, serviceItemId });
}

export async function upsertServiceItem(
  shopId: number,
  serviceItemId: string,
  data: ProtractorServiceItemDoc,
): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.upsertServiceItem(shopId, serviceItemId, data);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.service_items.upsert",
      () => upsertServiceItemMongo(shopId, serviceItemId, data),
    );
    return;
  }
  await upsertServiceItemMongo(shopId, serviceItemId, data);
}

async function upsertServiceItemMongo(
  shopId: number,
  serviceItemId: string,
  data: ProtractorServiceItemDoc,
): Promise<void> {
  const col = await collection();
  await col.updateOne({ shopId, serviceItemId }, { $set: data }, { upsert: true });
}

// The settings route surfaces a per-shop service-item cache count.
export async function countServiceItemsByShop(shopId: number): Promise<number> {
  if (isProtractorOpsPgCanonical()) {
    return pg.countServiceItemsByShop(shopId);
  }
  const col = await collection();
  return col.countDocuments({ shopId });
}
