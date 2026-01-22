// lib/features.ts
// Modular feature toggle system for à la carte feature management

import { getDb } from "@/lib/mongo";
import "@/lib/sms-adapters/protractor-adapter";

export type FeatureId = 
  | "maintenance"      // OEM schedules, recommendations, DVI insights
  | "job_lookup"       // Historical job search, parts intelligence, smart autocomplete
  | "common_failures"  // Common Failures Advisor - predictive repairs
  | "oil_sticker"      // Oil change sticker platform
  | "keytags"          // Key identification tags for vehicles in shop
  | "auto_booking"     // Auto booking for oil change appointments
  | "part_xref";       // Part cross-reference tool

export type FeatureConfig = {
  id: FeatureId;
  name: string;
  description: string;
  icon: string;
  stripeProductId?: string;
  stripePriceId?: string;
  pricePerMonth?: number;
  requiresSMS: boolean;
  smsProviders: ("protractor" | "tekmetric" | "autoflow")[];
};

export const FEATURES: FeatureConfig[] = [
  {
    id: "maintenance",
    name: "Maintenance Recommendations",
    description: "AI-powered maintenance recommendations from OEM data, service history, and DVI findings",
    icon: "Wrench",
    requiresSMS: true,
    smsProviders: ["protractor", "tekmetric", "autoflow"],
  },
  {
    id: "job_lookup",
    name: "Job Lookup / History Writer",
    description: "Search historical jobs for parts, labor, and pricing. Add matching jobs to open work orders.",
    icon: "Search",
    requiresSMS: true,
    smsProviders: ["protractor", "tekmetric"],
  },
  {
    id: "oil_sticker",
    name: "Oil Sticker Platform",
    description: "Generate and manage oil change reminder stickers",
    icon: "Droplet",
    requiresSMS: false,
    smsProviders: [],
  },
  {
    id: "common_failures",
    name: "Common Failures Advisor",
    description: "Predict common repairs by vehicle, powertrain, and mileage using shop data and AI",
    icon: "AlertTriangle",
    requiresSMS: true,
    smsProviders: ["protractor", "tekmetric"],
  },
  {
    id: "part_xref",
    name: "Part Cross-Reference",
    description: "Find interchangeable parts across manufacturers based on vehicle compatibility",
    icon: "RefreshCw",
    requiresSMS: true,
    smsProviders: ["protractor", "tekmetric"],
  },
  {
    id: "keytags",
    name: "Keytags",
    description: "Print customer and vehicle info on Dymo labels for key identification while vehicles are in the shop",
    icon: "Tag",
    requiresSMS: false,
    smsProviders: [],
  },
  {
    id: "auto_booking",
    name: "Auto Booking",
    description: "Automated appointment booking for oil change reminders",
    icon: "Calendar",
    requiresSMS: false,
    smsProviders: [],
  },
];

export type ShopFeatures = {
  shopId: number;
  enabledFeatures: FeatureId[];
  featureSettings: Partial<Record<FeatureId, Record<string, any>>>;
  subscriptions: {
    featureId: FeatureId;
    stripeSubscriptionId?: string;
    status: "active" | "trialing" | "canceled" | "past_due";
    currentPeriodEnd?: Date;
  }[];
  createdAt: Date;
  updatedAt: Date;
};

export function isDevEnvironment(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  const replitDevDomain = process.env.REPLIT_DEV_DOMAIN;
  return nodeEnv === "development" || !!replitDevDomain;
}

export function getAllFeatureIds(): FeatureId[] {
  return FEATURES.map(f => f.id);
}

export async function getShopFeatures(shopId: number): Promise<ShopFeatures | null> {
  const db = await getDb();
  return db.collection<ShopFeatures>("shop_features").findOne({ shopId });
}

export async function isFeatureEnabled(shopId: number, featureId: FeatureId): Promise<boolean> {
  if (isDevEnvironment()) {
    return true;
  }
  const features = await getShopFeatures(shopId);
  if (!features) {
    return featureId === "maintenance";
  }
  return features.enabledFeatures.includes(featureId);
}

export async function getEnabledFeatures(shopId: number): Promise<FeatureId[]> {
  if (isDevEnvironment()) {
    return getAllFeatureIds();
  }
  const features = await getShopFeatures(shopId);
  if (!features) {
    return ["maintenance"];
  }
  return features.enabledFeatures;
}

export async function enableFeature(shopId: number, featureId: FeatureId): Promise<void> {
  const db = await getDb();
  await db.collection<ShopFeatures>("shop_features").updateOne(
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
    { upsert: true }
  );
}

export async function disableFeature(shopId: number, featureId: FeatureId): Promise<void> {
  const db = await getDb();
  await db.collection<ShopFeatures>("shop_features").updateOne(
    { shopId },
    {
      $pull: { enabledFeatures: featureId },
      $set: { updatedAt: new Date() },
    }
  );
}

export async function setShopFeatures(shopId: number, featureIds: FeatureId[]): Promise<void> {
  const db = await getDb();
  await db.collection<ShopFeatures>("shop_features").updateOne(
    { shopId },
    {
      $set: { 
        enabledFeatures: featureIds,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        shopId,
        featureSettings: {},
        subscriptions: [],
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
}

export async function getFeatureSettings<T = Record<string, any>>(
  shopId: number, 
  featureId: FeatureId
): Promise<T | null> {
  const features = await getShopFeatures(shopId);
  if (!features) return null;
  return (features.featureSettings[featureId] as T) || null;
}

export async function setFeatureSettings(
  shopId: number, 
  featureId: FeatureId, 
  settings: Record<string, any>
): Promise<void> {
  const db = await getDb();
  await db.collection<ShopFeatures>("shop_features").updateOne(
    { shopId },
    {
      $set: { 
        [`featureSettings.${featureId}`]: settings,
        updatedAt: new Date(),
      },
    }
  );
}

export function getFeatureConfig(featureId: FeatureId): FeatureConfig | undefined {
  return FEATURES.find(f => f.id === featureId);
}

export async function ensureFeatureIndexes(): Promise<void> {
  const db = await getDb();
  const collection = db.collection("shop_features");
  await collection.createIndex({ shopId: 1 }, { unique: true });
  console.log("[Features] Database indexes created");
}
