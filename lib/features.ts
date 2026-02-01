import sql from "@/lib/db/postgres";
import "@/lib/sms-adapters/protractor-adapter";

export type FeatureId = 
  | "maintenance"
  | "job_lookup"
  | "common_failures"
  | "oil_sticker"
  | "keytags"
  | "auto_booking"
  | "part_xref";

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
  shopId: string;
  enabledFeatures: FeatureId[];
  featureSettings: Partial<Record<FeatureId, Record<string, unknown>>>;
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

export async function getShopFeatures(shopId: number | string): Promise<ShopFeatures | null> {
  const shopIdStr = String(shopId);
  const result = await sql`
    SELECT shop_id, enabled_features, feature_settings, subscriptions, 
           created_at, updated_at
    FROM shop_features
    WHERE shop_id = ${shopIdStr}
    LIMIT 1
  `;
  
  if (result.length === 0) return null;
  
  const row = result[0];
  return {
    shopId: row.shop_id,
    enabledFeatures: row.enabled_features || [],
    featureSettings: row.feature_settings || {},
    subscriptions: row.subscriptions || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function isFeatureEnabled(shopId: number | string, featureId: FeatureId): Promise<boolean> {
  if (isDevEnvironment()) {
    return true;
  }
  const features = await getShopFeatures(shopId);
  if (!features) {
    return featureId === "maintenance";
  }
  return features.enabledFeatures.includes(featureId);
}

export async function getEnabledFeatures(shopId: number | string): Promise<FeatureId[]> {
  if (isDevEnvironment()) {
    return getAllFeatureIds();
  }
  const features = await getShopFeatures(shopId);
  if (!features) {
    return ["maintenance"];
  }
  return features.enabledFeatures;
}

export async function enableFeature(shopId: number | string, featureId: FeatureId): Promise<void> {
  const shopIdStr = String(shopId);
  
  await sql`
    INSERT INTO shop_features (shop_id, enabled_features, feature_settings, subscriptions)
    VALUES (${shopIdStr}, ARRAY[${featureId}]::text[], '{}'::jsonb, '[]'::jsonb)
    ON CONFLICT (shop_id) DO UPDATE SET
      enabled_features = CASE 
        WHEN ${featureId} = ANY(shop_features.enabled_features) THEN shop_features.enabled_features
        ELSE array_append(shop_features.enabled_features, ${featureId})
      END,
      updated_at = NOW()
  `;
}

export async function disableFeature(shopId: number | string, featureId: FeatureId): Promise<void> {
  const shopIdStr = String(shopId);
  
  await sql`
    UPDATE shop_features 
    SET enabled_features = array_remove(enabled_features, ${featureId}), updated_at = NOW()
    WHERE shop_id = ${shopIdStr}
  `;
}

export async function setShopFeatures(shopId: number | string, featureIds: FeatureId[]): Promise<void> {
  const shopIdStr = String(shopId);
  
  await sql`
    INSERT INTO shop_features (shop_id, enabled_features, feature_settings, subscriptions)
    VALUES (${shopIdStr}, ${featureIds}::text[], '{}'::jsonb, '[]'::jsonb)
    ON CONFLICT (shop_id) DO UPDATE SET
      enabled_features = ${featureIds}::text[],
      updated_at = NOW()
  `;
}

export async function getFeatureSettings<T = Record<string, unknown>>(
  shopId: number | string, 
  featureId: FeatureId
): Promise<T | null> {
  const features = await getShopFeatures(shopId);
  if (!features) return null;
  return (features.featureSettings[featureId] as T) || null;
}

export async function setFeatureSettings(
  shopId: number | string, 
  featureId: FeatureId, 
  settings: Record<string, unknown>
): Promise<void> {
  const shopIdStr = String(shopId);
  
  await sql`
    UPDATE shop_features 
    SET feature_settings = jsonb_set(COALESCE(feature_settings, '{}'::jsonb), ${[featureId]}::text[], ${JSON.stringify(settings)}::jsonb),
        updated_at = NOW()
    WHERE shop_id = ${shopIdStr}
  `;
}

export function getFeatureConfig(featureId: FeatureId): FeatureConfig | undefined {
  return FEATURES.find(f => f.id === featureId);
}
