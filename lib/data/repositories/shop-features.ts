// Repository for the `shop_features` collection.
import type { Collection } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "shop_features";

export interface ShopFeaturesDoc {
  shopId: number;
  enabledFeatures: string[];
  featureSettings: Record<string, Record<string, unknown>>;
  subscriptions: Array<{
    featureId: string;
    stripeSubscriptionId?: string;
    status: "active" | "trialing" | "canceled" | "past_due";
    currentPeriodEnd?: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

async function collection(): Promise<Collection<ShopFeaturesDoc>> {
  const db = await getDb();
  return db.collection<ShopFeaturesDoc>(COLLECTION);
}

export async function findByShopId<T extends ShopFeaturesDoc = ShopFeaturesDoc>(
  shopId: number,
): Promise<T | null> {
  const col = await collection();
  return (await col.findOne({ shopId })) as T | null;
}

export async function addEnabledFeature(shopId: number, featureId: string): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId },
    {
      $addToSet: { enabledFeatures: featureId },
      $set: { updatedAt: new Date() },
      $setOnInsert: {
        shopId,
        featureSettings: {},
        subscriptions: [],
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
}

export async function removeEnabledFeature(shopId: number, featureId: string): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId },
    {
      $pull: { enabledFeatures: featureId },
      $set: { updatedAt: new Date() },
    },
  );
}

export async function setEnabledFeatures(
  shopId: number,
  featureIds: string[],
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId },
    {
      $set: { enabledFeatures: featureIds, updatedAt: new Date() },
      $setOnInsert: {
        shopId,
        featureSettings: {},
        subscriptions: [],
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
}

export async function setFeatureSettings(
  shopId: number,
  featureId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId },
    {
      $set: {
        [`featureSettings.${featureId}`]: settings,
        updatedAt: new Date(),
      },
    },
  );
}

export async function ensureIndexes(): Promise<void> {
  const col = await collection();
  await col.createIndex({ shopId: 1 }, { unique: true });
}
