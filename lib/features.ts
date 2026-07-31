// lib/features.ts
// Modular feature toggle system for à la carte feature management

import "@/lib/sms-adapters/protractor-adapter";
import * as repo from "@/lib/data/repositories/shop-features";
import {
  getFeatureEntitlements,
  updateShopFeatures,
  type FeatureKey,
} from "@/lib/featureResolver";

export type FeatureId = 
  | "maintenance"      // OEM schedules, recommendations, DVI insights
  | "job_lookup"       // Historical job search, parts intelligence, smart autocomplete
  | "common_failures"  // Common Failures Advisor - predictive repairs
  | "oil_sticker"      // Oil change sticker platform
  | "keytags"          // Key identification tags for vehicles in shop
  | "auto_booking"     // Auto booking for oil change appointments
  | "part_xref"        // Part cross-reference tool
  | "labor_rates"      // Labor rate rules auto-apply
  | "estimate_assist"; // AI estimate audits + smart job builder

export type FeatureConfig = {
  id: FeatureId;
  name: string;
  description: string;
  icon: string;
  stripeProductId?: string;
  stripePriceId?: string;
  pricePerMonth?: number;
  requiresSMS: boolean;
  smsProviders: ("protractor" | "tekmetric" | "autoflow" | "shopmonkey")[];
};

export const FEATURES: FeatureConfig[] = [
  {
    id: "maintenance",
    name: "Maintenance Recommendations",
    description: "AI-powered maintenance recommendations from OEM data, service history, and DVI findings",
    icon: "Wrench",
    requiresSMS: true,
    smsProviders: ["protractor", "tekmetric", "autoflow", "shopmonkey"],
  },
  {
    id: "job_lookup",
    name: "Job Lookup / History Writer",
    description: "Search historical jobs for parts, labor, and pricing. Add matching jobs to open work orders.",
    icon: "Search",
    requiresSMS: true,
    smsProviders: ["protractor", "tekmetric", "shopmonkey"],
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
    smsProviders: ["protractor", "tekmetric", "shopmonkey"],
  },
  {
    id: "part_xref",
    name: "Part Cross-Reference",
    description: "Find interchangeable parts across manufacturers based on vehicle compatibility",
    icon: "RefreshCw",
    requiresSMS: true,
    smsProviders: ["protractor", "tekmetric", "shopmonkey"],
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
  {
    id: "labor_rates",
    name: "Labor Rate Rules",
    description: "Automatically apply labor rates based on vehicle, customer, and job criteria",
    icon: "DollarSign",
    requiresSMS: true,
    smsProviders: ["tekmetric", "protractor", "shopmonkey"],
  },
  {
    id: "estimate_assist",
    name: "Estimate Assist",
    description: "AI-powered estimate audits and smart job building from synced work orders",
    icon: "FileSearch",
    requiresSMS: true,
    smsProviders: ["protractor", "tekmetric", "shopmonkey"],
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

/**
 * Legacy read of the standalone `shop_features` collection. Kept ONLY for
 * per-feature settings/subscriptions metadata — the enabled/disabled state
 * now lives in the resolver-backed `shops.enabledFeatures` store (see
 * `getFeatureEntitlements` / `updateShopFeatures` in lib/featureResolver).
 * Do not use this to decide whether a feature is on.
 */
export async function getShopFeatures(shopId: number): Promise<ShopFeatures | null> {
  return repo.findByShopId<ShopFeatures>(shopId);
}

/**
 * Resolver-backed feature check: merges per-shop overrides
 * (`shops.enabledFeatures`), enterprise settings, and plan defaults —
 * identical semantics to the entitlement checks used everywhere else.
 * Previously this read the standalone `shop_features` collection, which
 * the /platform-admin editor never wrote, so admin toggles didn't apply.
 */
export async function isFeatureEnabled(shopId: number, featureId: FeatureId): Promise<boolean> {
  if (isDevEnvironment()) {
    return true;
  }
  const entitlements = await getFeatureEntitlements(shopId);
  return entitlements.effectiveFeatures[featureId as FeatureKey] === true;
}

export async function getEnabledFeatures(shopId: number): Promise<FeatureId[]> {
  if (isDevEnvironment()) {
    return getAllFeatureIds();
  }
  const entitlements = await getFeatureEntitlements(shopId);
  return getAllFeatureIds().filter(
    id => entitlements.effectiveFeatures[id as FeatureKey] === true,
  );
}

export async function enableFeature(shopId: number, featureId: FeatureId): Promise<void> {
  await updateShopFeatures(shopId, { [featureId as FeatureKey]: true });
}

export async function disableFeature(shopId: number, featureId: FeatureId): Promise<void> {
  await updateShopFeatures(shopId, { [featureId as FeatureKey]: false });
}

/**
 * Set the full per-shop override map from an enabled-id array: listed
 * features become explicit `true` overrides, unlisted ones explicit
 * `false`. Writes the resolver-backed `shops.enabledFeatures` store.
 */
export async function setShopFeatures(shopId: number, featureIds: FeatureId[]): Promise<void> {
  const overrides: Partial<Record<FeatureKey, boolean>> = {};
  for (const id of getAllFeatureIds()) {
    overrides[id as FeatureKey] = featureIds.includes(id);
  }
  await updateShopFeatures(shopId, overrides);
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
  await repo.setFeatureSettings(shopId, featureId, settings);
}

export function getFeatureConfig(featureId: FeatureId): FeatureConfig | undefined {
  return FEATURES.find(f => f.id === featureId);
}

export async function ensureFeatureIndexes(): Promise<void> {
  await repo.ensureIndexes();
  console.log("[Features] Database indexes created");
}
