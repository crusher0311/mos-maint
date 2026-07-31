// Repository for the `shop_features` collection.
//
// METADATA-ONLY: this collection holds per-feature settings and Stripe
// subscription metadata. Per-shop feature enable/disable state lives in the
// resolver-backed `shops.enabledFeatures` store (see lib/featureResolver.ts).
// Do NOT add enable/disable/set helpers here or gate features on this
// collection's `enabledFeatures` field — it is a dead, legacy store.
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
