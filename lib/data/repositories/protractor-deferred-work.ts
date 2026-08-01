// Repository for the `protractor_deferred_work` collection.
//
// One row per (shopId, VIN) with the cached deferred-work item list and
// fetch metadata.
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
import * as pg from "./pg/protractor-deferred-work";

const COLLECTION = "protractor_deferred_work";

export interface ProtractorDeferredWorkDoc extends Document {
  shopId: number;
  vin: string;
  items: any[];
  fetchedAt: Date;
  source?: string;
  createdAt?: Date;
}

async function collection(): Promise<Collection<ProtractorDeferredWorkDoc>> {
  const db = await getDb();
  return db.collection<ProtractorDeferredWorkDoc>(COLLECTION);
}

export async function findDeferredWorkByShopAndVin(
  shopId: number,
  vin: string,
): Promise<ProtractorDeferredWorkDoc | null> {
  if (isProtractorOpsPgCanonical()) {
    return pg.findDeferredWorkByShopAndVin(shopId, vin);
  }
  return findDeferredWorkByShopAndVinMongo(shopId, vin);
}

async function findDeferredWorkByShopAndVinMongo(
  shopId: number,
  vin: string,
): Promise<ProtractorDeferredWorkDoc | null> {
  const col = await collection();
  return col.findOne({ shopId, vin: vin.toUpperCase() });
}

export async function upsertDeferredWorkSnapshot(
  shopId: number,
  vin: string,
  items: unknown[],
  now: Date,
): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.upsertDeferredWorkSnapshot(shopId, vin, items, now);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.deferred_work.upsert",
      () => upsertDeferredWorkSnapshotMongo(shopId, vin, items, now),
    );
    return;
  }
  await upsertDeferredWorkSnapshotMongo(shopId, vin, items, now);
}

async function upsertDeferredWorkSnapshotMongo(
  shopId: number,
  vin: string,
  items: unknown[],
  now: Date,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId, vin: vin.toUpperCase() },
    {
      $set: {
        shopId,
        vin: vin.toUpperCase(),
        items,
        fetchedAt: now,
        source: "protractor",
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

// Disconnect / reconnect cleanup wipes a shop's cached deferred-work rows.
export async function deleteDeferredWorkByShop(shopId: number): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.deleteDeferredWorkByShop(shopId);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.deferred_work.deleteByShop",
      () => deleteDeferredWorkByShopMongo(shopId),
    );
    return;
  }
  await deleteDeferredWorkByShopMongo(shopId);
}

async function deleteDeferredWorkByShopMongo(shopId: number): Promise<void> {
  const col = await collection();
  await col.deleteMany({ shopId });
}

// Canned-job discovery scans every cached deferred-work snapshot for a shop.
export async function findDeferredWorkByShop(
  shopId: number,
): Promise<ProtractorDeferredWorkDoc[]> {
  if (isProtractorOpsPgCanonical()) return pg.findDeferredWorkByShop(shopId);
  const col = await collection();
  return col.find({ shopId }).toArray();
}

export async function countDeferredWorkByShop(shopId: number): Promise<number> {
  if (isProtractorOpsPgCanonical()) return pg.countDeferredWorkByShop(shopId);
  const col = await collection();
  return col.countDocuments({ shopId });
}
