import sql from "@/lib/db/postgres";

export type FeatureKey = "maintenance" | "job_lookup" | "common_failures" | "oil_sticker" | "keytags" | "auto_booking" | "part_xref";

export type BillingStatus = "trial" | "active" | "past_due" | "suspended" | "canceled" | "enterprise" | "demo";

export type BillingPlan = "trial" | "starter" | "plus" | "elite" | "professional" | "enterprise" | "demo";

export interface FeatureSettings {
  maintenance: boolean;
  job_lookup: boolean;
  common_failures: boolean;
  oil_sticker: boolean;
  keytags: boolean;
  auto_booking: boolean;
  part_xref: boolean;
}

export interface ShopBilling {
  plan: BillingPlan;
  status: BillingStatus;
  vinLimit: number;
  vinViewCount?: number;
  gracePeriodStartedAt?: Date | null;
  gracePeriodEndsAt?: Date | null;
  gracePeriodExtendedBy?: string | null;
  gracePeriodExtendedAt?: Date | null;
}

export interface FeatureEntitlements {
  features: FeatureSettings;
  billing: ShopBilling;
  effectiveFeatures: FeatureSettings;
  canUseFeature: (feature: FeatureKey) => boolean;
  isFeatureEnabled: (feature: FeatureKey) => boolean;
  isBillingActive: () => boolean;
}

const DEFAULT_FEATURES: FeatureSettings = {
  maintenance: true,
  job_lookup: false,
  common_failures: false,
  oil_sticker: false,
  keytags: false,
  auto_booking: false,
  part_xref: false,
};

const FEATURE_SLUG_TO_KEY: Record<string, FeatureKey> = {
  "maintenance": "maintenance",
  "maintenance-recommendations": "maintenance",
  "job-lookup": "job_lookup",
  "job_lookup": "job_lookup",
  "common-failures": "common_failures",
  "common_failures": "common_failures",
  "oil-sticker": "oil_sticker",
  "oil_sticker": "oil_sticker",
  "keytags": "keytags",
  "auto-booking": "auto_booking",
  "auto_booking": "auto_booking",
  "part-xref": "part_xref",
  "part_xref": "part_xref",
};

const FALLBACK_PLAN_FEATURES: Record<BillingPlan, FeatureSettings> = {
  trial: {
    maintenance: true,
    job_lookup: false,
    common_failures: false,
    oil_sticker: false,
    keytags: false,
    auto_booking: false,
    part_xref: false,
  },
  starter: {
    maintenance: true,
    job_lookup: false,
    common_failures: false,
    oil_sticker: true,
    keytags: false,
    auto_booking: false,
    part_xref: false,
  },
  plus: {
    maintenance: true,
    job_lookup: true,
    common_failures: true,
    oil_sticker: true,
    keytags: false,
    auto_booking: false,
    part_xref: false,
  },
  elite: {
    maintenance: true,
    job_lookup: true,
    common_failures: true,
    oil_sticker: true,
    keytags: true,
    auto_booking: true,
    part_xref: true,
  },
  professional: {
    maintenance: true,
    job_lookup: true,
    common_failures: true,
    oil_sticker: true,
    keytags: true,
    auto_booking: true,
    part_xref: true,
  },
  enterprise: {
    maintenance: true,
    job_lookup: true,
    common_failures: true,
    oil_sticker: true,
    keytags: true,
    auto_booking: true,
    part_xref: true,
  },
  demo: {
    maintenance: true,
    job_lookup: true,
    common_failures: true,
    oil_sticker: true,
    keytags: true,
    auto_booking: true,
    part_xref: true,
  },
};

async function getPlanFeaturesFromDatabase(plan: BillingPlan): Promise<FeatureSettings> {
  try {
    const platformFeatures = await sql`
      SELECT key, name, metadata FROM feature_flags 
      WHERE enabled_by_default = TRUE
    `;

    if (!platformFeatures || platformFeatures.length === 0) {
      return FALLBACK_PLAN_FEATURES[plan] || FALLBACK_PLAN_FEATURES.trial;
    }

    const tierSlug = plan === "professional" ? "elite" : plan;

    const features: FeatureSettings = {
      maintenance: false,
      job_lookup: false,
      common_failures: false,
      oil_sticker: false,
      keytags: false,
      auto_booking: false,
      part_xref: false,
    };

    for (const pf of platformFeatures) {
      const metadata = pf.metadata as Record<string, unknown> || {};
      const includedInTiers = (metadata.includedInTiers as string[]) || [];
      const featureKey = FEATURE_SLUG_TO_KEY[pf.key as string];
      
      if (featureKey && includedInTiers.includes(tierSlug)) {
        features[featureKey] = true;
      }
    }

    return features;
  } catch (error) {
    console.error("Error fetching plan features from database:", error);
    return FALLBACK_PLAN_FEATURES[plan] || FALLBACK_PLAN_FEATURES.trial;
  }
}

export async function getFeatureEntitlements(shopId: number): Promise<FeatureEntitlements> {
  const shops = await sql`
    SELECT id, shop_id, settings, billing, enterprise_id FROM shops 
    WHERE shop_id = ${String(shopId)} LIMIT 1
  `;
  
  const shop = shops[0];
  if (!shop) {
    return createDefaultEntitlements();
  }
  
  let enterpriseFeatures: Partial<FeatureSettings> = {};
  if (shop.enterprise_id) {
    const enterprises = await sql`
      SELECT settings FROM enterprises WHERE id = ${shop.enterprise_id} LIMIT 1
    `;
    const enterprise = enterprises[0];
    if (enterprise?.settings) {
      const settings = enterprise.settings as Record<string, unknown>;
      enterpriseFeatures = (settings.featureSettings as Partial<FeatureSettings>) || {};
    }
  }
  
  const billingData = (shop.billing as Record<string, unknown>) || {};
  const settingsData = (shop.settings as Record<string, unknown>) || {};
  
  const plan: BillingPlan = (billingData.plan as BillingPlan) || "trial";
  const status: BillingStatus = (billingData.status as BillingStatus) || "trial";
  const vinLimit = (settingsData.trialVinLimit as number) ?? (billingData.vinLimit as number) ?? 10;
  
  const planFeatures = await getPlanFeaturesFromDatabase(plan);
  
  const shopFeatures: Partial<FeatureSettings> = (settingsData.enabledFeatures as Partial<FeatureSettings>) || {};
  
  const effectiveFeatures: FeatureSettings = {
    maintenance: shopFeatures.maintenance ?? enterpriseFeatures.maintenance ?? planFeatures.maintenance,
    job_lookup: shopFeatures.job_lookup ?? enterpriseFeatures.job_lookup ?? planFeatures.job_lookup,
    common_failures: shopFeatures.common_failures ?? enterpriseFeatures.common_failures ?? planFeatures.common_failures,
    oil_sticker: shopFeatures.oil_sticker ?? enterpriseFeatures.oil_sticker ?? planFeatures.oil_sticker,
    keytags: shopFeatures.keytags ?? enterpriseFeatures.keytags ?? planFeatures.keytags,
    auto_booking: shopFeatures.auto_booking ?? enterpriseFeatures.auto_booking ?? planFeatures.auto_booking,
    part_xref: shopFeatures.part_xref ?? enterpriseFeatures.part_xref ?? planFeatures.part_xref,
  };
  
  const billing: ShopBilling = {
    plan,
    status,
    vinLimit,
    vinViewCount: 0,
    gracePeriodStartedAt: billingData.gracePeriodStartedAt ? new Date(billingData.gracePeriodStartedAt as string) : null,
    gracePeriodEndsAt: billingData.gracePeriodEndsAt ? new Date(billingData.gracePeriodEndsAt as string) : null,
    gracePeriodExtendedBy: (billingData.gracePeriodExtendedBy as string) || null,
    gracePeriodExtendedAt: billingData.gracePeriodExtendedAt ? new Date(billingData.gracePeriodExtendedAt as string) : null,
  };
  
  const isBillingActive = () => {
    return status === "active" || status === "trial" || status === "enterprise" || status === "demo" || status === "past_due";
  };
  
  const isFeatureEnabled = (feature: FeatureKey) => {
    return effectiveFeatures[feature] === true;
  };
  
  const canUseFeature = (feature: FeatureKey) => {
    return isBillingActive() && isFeatureEnabled(feature);
  };
  
  return {
    features: shopFeatures as FeatureSettings,
    billing,
    effectiveFeatures,
    canUseFeature,
    isFeatureEnabled,
    isBillingActive,
  };
}

function createDefaultEntitlements(): FeatureEntitlements {
  const billing: ShopBilling = {
    plan: "trial",
    status: "trial",
    vinLimit: 10,
  };
  
  return {
    features: DEFAULT_FEATURES,
    billing,
    effectiveFeatures: DEFAULT_FEATURES,
    canUseFeature: () => false,
    isFeatureEnabled: (feature: FeatureKey) => DEFAULT_FEATURES[feature],
    isBillingActive: () => false,
  };
}

export async function updateShopFeatures(
  shopId: number, 
  features: Partial<FeatureSettings>
): Promise<void> {
  const shops = await sql`
    SELECT settings FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
  `;
  
  const shop = shops[0];
  const settingsData = (shop?.settings as Record<string, unknown>) || {};
  const existingFeatures = (settingsData.enabledFeatures as Partial<FeatureSettings>) || {};
  
  const mergedFeatures = { ...existingFeatures, ...features };
  const newSettings = { ...settingsData, enabledFeatures: mergedFeatures };
  
  await sql`
    UPDATE shops SET settings = ${JSON.stringify(newSettings)}::jsonb, updated_at = NOW()
    WHERE shop_id = ${String(shopId)}
  `;
}

export async function updateShopBilling(
  shopId: number,
  billingUpdates: Partial<ShopBilling>
): Promise<void> {
  const shops = await sql`
    SELECT billing, settings FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
  `;
  
  const shop = shops[0];
  const existingBilling = (shop?.billing as Record<string, unknown>) || {};
  const existingSettings = (shop?.settings as Record<string, unknown>) || {};
  
  const newBilling = { ...existingBilling };
  if (billingUpdates.plan !== undefined) newBilling.plan = billingUpdates.plan;
  if (billingUpdates.status !== undefined) newBilling.status = billingUpdates.status;
  if (billingUpdates.vinLimit !== undefined) newBilling.vinLimit = billingUpdates.vinLimit;
  if (billingUpdates.gracePeriodStartedAt !== undefined) newBilling.gracePeriodStartedAt = billingUpdates.gracePeriodStartedAt;
  if (billingUpdates.gracePeriodEndsAt !== undefined) newBilling.gracePeriodEndsAt = billingUpdates.gracePeriodEndsAt;
  if (billingUpdates.gracePeriodExtendedBy !== undefined) newBilling.gracePeriodExtendedBy = billingUpdates.gracePeriodExtendedBy;
  if (billingUpdates.gracePeriodExtendedAt !== undefined) newBilling.gracePeriodExtendedAt = billingUpdates.gracePeriodExtendedAt;
  
  const newSettings = { ...existingSettings };
  if (billingUpdates.vinLimit !== undefined) newSettings.trialVinLimit = billingUpdates.vinLimit;
  
  await sql`
    UPDATE shops 
    SET billing = ${JSON.stringify(newBilling)}::jsonb, 
        settings = ${JSON.stringify(newSettings)}::jsonb,
        updated_at = NOW()
    WHERE shop_id = ${String(shopId)}
  `;
}

export async function updateEnterpriseFeatures(
  enterpriseId: string,
  features: Partial<FeatureSettings>
): Promise<void> {
  const enterprises = await sql`
    SELECT settings FROM enterprises WHERE id = ${enterpriseId}::uuid LIMIT 1
  `;
  
  const enterprise = enterprises[0];
  const existingSettings = (enterprise?.settings as Record<string, unknown>) || {};
  const existingFeatures = (existingSettings.featureSettings as Partial<FeatureSettings>) || {};
  
  const mergedFeatures = { ...existingFeatures, ...features };
  const newSettings = { ...existingSettings, featureSettings: mergedFeatures };
  
  await sql`
    UPDATE enterprises 
    SET settings = ${JSON.stringify(newSettings)}::jsonb, updated_at = NOW()
    WHERE id = ${enterpriseId}::uuid
  `;
}

export async function getAvailablePlans(): Promise<{ id: BillingPlan; name: string; features: FeatureSettings }[]> {
  const [trialFeatures, starterFeatures, plusFeatures, eliteFeatures, enterpriseFeatures] = await Promise.all([
    getPlanFeaturesFromDatabase("trial"),
    getPlanFeaturesFromDatabase("starter"),
    getPlanFeaturesFromDatabase("plus"),
    getPlanFeaturesFromDatabase("elite"),
    getPlanFeaturesFromDatabase("enterprise"),
  ]);
  
  return [
    { id: "trial", name: "Trial", features: trialFeatures },
    { id: "starter", name: "Starter", features: starterFeatures },
    { id: "plus", name: "Plus", features: plusFeatures },
    { id: "elite", name: "Elite", features: eliteFeatures },
    { id: "enterprise", name: "Enterprise", features: enterpriseFeatures },
  ];
}

export function getFeatureList(): { key: FeatureKey; name: string; description: string }[] {
  return [
    { key: "maintenance", name: "Maintenance Tracking", description: "Track vehicle maintenance schedules, DVI insights, and recommendations" },
    { key: "job_lookup", name: "Job Lookup", description: "Search historical jobs with smart autocomplete across your shop and enterprise" },
    { key: "common_failures", name: "Common Failures Advisor", description: "Predict common repairs by vehicle, powertrain, and mileage" },
    { key: "oil_sticker", name: "Oil Sticker", description: "Generate oil change reminder stickers" },
    { key: "keytags", name: "Keytags", description: "Print customer/vehicle info on Dymo labels for key identification" },
    { key: "auto_booking", name: "Auto Booking", description: "Automated appointment booking for oil change reminders" },
    { key: "part_xref", name: "Part Cross-Reference", description: "Cross-reference parts across manufacturers" },
  ];
}
