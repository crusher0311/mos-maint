// Repository for the `protractor_deferred_work` collection.
//
// One row per (shopId, VIN) with the cached deferred-work item list and
// fetch metadata.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";

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
  const col = await collection();
  return col.findOne({ shopId, vin: vin.toUpperCase() });
}

export async function upsertDeferredWorkSnapshot(
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
