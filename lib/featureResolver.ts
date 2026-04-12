import { getDb } from "./mongo";

export type FeatureKey = "maintenance" | "job_lookup" | "common_failures" | "oil_sticker" | "keytags" | "auto_booking" | "part_xref" | "labor_rates" | "concern_assistant" | "estimate_assist";

export type BillingStatus = "trial" | "active" | "past_due" | "suspended" | "canceled" | "enterprise" | "demo";

export type BillingPlan = "trial" | "starter" | "plus" | "elite" | "professional" | "enterprise" | "oil_sticker_legacy" | "demo";

export interface FeatureSettings {
  maintenance: boolean;
  job_lookup: boolean;
  common_failures: boolean;
  oil_sticker: boolean;
  keytags: boolean;
  auto_booking: boolean;
  part_xref: boolean;
  labor_rates: boolean;
  concern_assistant: boolean;
  estimate_assist: boolean;
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
  labor_rates: false,
  concern_assistant: false,
  estimate_assist: false,
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
  "labor-rates": "labor_rates",
  "labor_rates": "labor_rates",
  "labor_rate_rules": "labor_rates",
  "concern-assistant": "concern_assistant",
  "concern_assistant": "concern_assistant",
  "estimate-assist": "estimate_assist",
  "estimate_assist": "estimate_assist",
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
    labor_rates: false,
    concern_assistant: false,
    estimate_assist: false,
  },
  starter: {
    maintenance: true,
    job_lookup: false,
    common_failures: false,
    oil_sticker: true,
    keytags: false,
    auto_booking: false,
    part_xref: false,
    labor_rates: false,
    concern_assistant: false,
    estimate_assist: false,
  },
  plus: {
    maintenance: true,
    job_lookup: true,
    common_failures: true,
    oil_sticker: true,
    keytags: false,
    auto_booking: false,
    part_xref: false,
    labor_rates: false,
    concern_assistant: true,
    estimate_assist: true,
  },
  elite: {
    maintenance: true,
    job_lookup: true,
    common_failures: true,
    oil_sticker: true,
    keytags: true,
    auto_booking: true,
    part_xref: true,
    labor_rates: true,
    concern_assistant: true,
    estimate_assist: true,
  },
  professional: {
    maintenance: true,
    job_lookup: true,
    common_failures: true,
    oil_sticker: true,
    keytags: true,
    auto_booking: true,
    part_xref: true,
    labor_rates: true,
    concern_assistant: true,
    estimate_assist: true,
  },
  oil_sticker_legacy: {
    maintenance: false,
    job_lookup: false,
    common_failures: false,
    oil_sticker: true,
    keytags: false,
    auto_booking: true,
    part_xref: false,
    labor_rates: true,
    concern_assistant: false,
    estimate_assist: false,
  },
  enterprise: {
    maintenance: true,
    job_lookup: true,
    common_failures: true,
    oil_sticker: true,
    keytags: true,
    auto_booking: true,
    part_xref: true,
    labor_rates: true,
    concern_assistant: true,
    estimate_assist: true,
  },
  demo: {
    maintenance: true,
    job_lookup: true,
    common_failures: true,
    oil_sticker: true,
    keytags: true,
    auto_booking: true,
    part_xref: true,
    labor_rates: true,
    concern_assistant: true,
    estimate_assist: true,
  },
};

async function getPlanFeaturesFromDatabase(plan: BillingPlan): Promise<FeatureSettings> {
  try {
    const db = await getDb();
    const platformFeatures = await db.collection("platform_features")
      .find({ status: "active" })
      .toArray();

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
      labor_rates: false,
      concern_assistant: false,
      estimate_assist: false,
    };

    for (const pf of platformFeatures) {
      const includedInTiers = pf.includedInTiers || [];
      const featureKey = FEATURE_SLUG_TO_KEY[pf.slug];
      
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
  const db = await getDb();
  
  const shop = await db.collection("shops").findOne({ shopId });
  
  if (!shop) {
    return createDefaultEntitlements();
  }
  
  let enterpriseFeatures: Partial<FeatureSettings> = {};
  if (shop.enterpriseId) {
    const enterprise = await db.collection("enterprise_accounts").findOne({ 
      _id: shop.enterpriseId 
    });
    if (enterprise?.featureSettings) {
      enterpriseFeatures = enterprise.featureSettings;
    }
  }
  
  const plan: BillingPlan = shop.billing?.plan || "trial";
  const status: BillingStatus = shop.billing?.status || "trial";
  const vinLimit = shop.trialVinLimit ?? shop.billing?.vinLimit ?? 10;
  
  const planFeatures = await getPlanFeaturesFromDatabase(plan);
  
  const shopFeatures: Partial<FeatureSettings> = shop.enabledFeatures || {};
  
  const effectiveFeatures: FeatureSettings = {
    maintenance: shopFeatures.maintenance ?? enterpriseFeatures.maintenance ?? planFeatures.maintenance,
    job_lookup: shopFeatures.job_lookup ?? enterpriseFeatures.job_lookup ?? planFeatures.job_lookup,
    common_failures: shopFeatures.common_failures ?? enterpriseFeatures.common_failures ?? planFeatures.common_failures,
    oil_sticker: shopFeatures.oil_sticker ?? enterpriseFeatures.oil_sticker ?? planFeatures.oil_sticker,
    keytags: shopFeatures.keytags ?? enterpriseFeatures.keytags ?? planFeatures.keytags,
    auto_booking: shopFeatures.auto_booking ?? enterpriseFeatures.auto_booking ?? planFeatures.auto_booking,
    part_xref: shopFeatures.part_xref ?? enterpriseFeatures.part_xref ?? planFeatures.part_xref,
    labor_rates: shopFeatures.labor_rates ?? enterpriseFeatures.labor_rates ?? planFeatures.labor_rates,
    concern_assistant: shopFeatures.concern_assistant ?? enterpriseFeatures.concern_assistant ?? planFeatures.concern_assistant,
    estimate_assist: shopFeatures.estimate_assist ?? enterpriseFeatures.estimate_assist ?? planFeatures.estimate_assist,
  };
  
  const billing: ShopBilling = {
    plan,
    status,
    vinLimit,
    vinViewCount: 0,
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
  const db = await getDb();
  
  const shop = await db.collection("shops").findOne({ shopId });
  const existingFeatures = shop?.enabledFeatures || {};
  
  const mergedFeatures = { ...existingFeatures, ...features };
  
  await db.collection("shops").updateOne(
    { shopId },
    { $set: { enabledFeatures: mergedFeatures, updatedAt: new Date() } }
  );
}

export async function updateShopBilling(
  shopId: number,
  billing: Partial<ShopBilling>
): Promise<void> {
  const db = await getDb();
  
  const updateFields: any = { updatedAt: new Date() };
  if (billing.plan !== undefined) updateFields["billing.plan"] = billing.plan;
  if (billing.status !== undefined) updateFields["billing.status"] = billing.status;
  if (billing.vinLimit !== undefined) updateFields.trialVinLimit = billing.vinLimit;
  
  await db.collection("shops").updateOne(
    { shopId },
    { $set: updateFields }
  );
}

export async function updateEnterpriseFeatures(
  enterpriseId: string,
  features: Partial<FeatureSettings>
): Promise<void> {
  const db = await getDb();
  const { ObjectId } = await import("mongodb");
  
  const enterprise = await db.collection("enterprise_accounts").findOne({ 
    _id: new ObjectId(enterpriseId) 
  });
  const existingFeatures = enterprise?.featureSettings || {};
  
  const mergedFeatures = { ...existingFeatures, ...features };
  
  await db.collection("enterprise_accounts").updateOne(
    { _id: new ObjectId(enterpriseId) },
    { $set: { featureSettings: mergedFeatures, updatedAt: new Date() } }
  );
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
    { key: "labor_rates", name: "Labor Rate Rules", description: "Auto-apply labor rates based on vehicle, customer, and job criteria" },
    { key: "concern_assistant", name: "Concern Assistant", description: "AI-powered customer concern intake with follow-up questions and RO injection" },
  ];
}
