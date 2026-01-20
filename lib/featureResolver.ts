import { getDb } from "./mongo";

export type FeatureKey = "maintenance" | "job_lookup" | "oil_sticker" | "part_xref" | "keytags" | "dvi_tracking";

export type BillingStatus = "trial" | "active" | "past_due" | "canceled" | "enterprise" | "demo";

export type BillingPlan = "trial" | "starter" | "professional" | "enterprise" | "demo";

export interface FeatureSettings {
  maintenance: boolean;
  job_lookup: boolean;
  oil_sticker: boolean;
  part_xref: boolean;
  keytags: boolean;
  dvi_tracking: boolean;
}

export interface ShopBilling {
  plan: BillingPlan;
  status: BillingStatus;
  vinLimit: number;
  vinViewCount?: number;
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
  oil_sticker: false,
  part_xref: false,
  keytags: false,
  dvi_tracking: false,
};

const PLAN_FEATURES: Record<BillingPlan, FeatureSettings> = {
  trial: {
    maintenance: true,
    job_lookup: false,
    oil_sticker: false,
    part_xref: false,
    keytags: false,
    dvi_tracking: false,
  },
  starter: {
    maintenance: true,
    job_lookup: false,
    oil_sticker: true,
    part_xref: false,
    keytags: false,
    dvi_tracking: false,
  },
  professional: {
    maintenance: true,
    job_lookup: true,
    oil_sticker: true,
    part_xref: true,
    keytags: true,
    dvi_tracking: true,
  },
  enterprise: {
    maintenance: true,
    job_lookup: true,
    oil_sticker: true,
    part_xref: true,
    keytags: true,
    dvi_tracking: true,
  },
  demo: {
    maintenance: true,
    job_lookup: true,
    oil_sticker: true,
    part_xref: true,
    keytags: true,
    dvi_tracking: true,
  },
};

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
  
  const planFeatures = PLAN_FEATURES[plan] || PLAN_FEATURES.trial;
  
  const shopFeatures: Partial<FeatureSettings> = shop.enabledFeatures || {};
  
  const effectiveFeatures: FeatureSettings = {
    maintenance: shopFeatures.maintenance ?? enterpriseFeatures.maintenance ?? planFeatures.maintenance,
    job_lookup: shopFeatures.job_lookup ?? enterpriseFeatures.job_lookup ?? planFeatures.job_lookup,
    oil_sticker: shopFeatures.oil_sticker ?? enterpriseFeatures.oil_sticker ?? planFeatures.oil_sticker,
    part_xref: shopFeatures.part_xref ?? enterpriseFeatures.part_xref ?? planFeatures.part_xref,
    keytags: shopFeatures.keytags ?? enterpriseFeatures.keytags ?? planFeatures.keytags,
    dvi_tracking: shopFeatures.dvi_tracking ?? enterpriseFeatures.dvi_tracking ?? planFeatures.dvi_tracking,
  };
  
  const billing: ShopBilling = {
    plan,
    status,
    vinLimit,
    vinViewCount: 0,
  };
  
  const isBillingActive = () => {
    return status === "active" || status === "trial" || status === "enterprise" || status === "demo";
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

export function getAvailablePlans(): { id: BillingPlan; name: string; features: FeatureSettings }[] {
  return [
    { id: "trial", name: "Trial", features: PLAN_FEATURES.trial },
    { id: "starter", name: "Starter", features: PLAN_FEATURES.starter },
    { id: "professional", name: "Professional", features: PLAN_FEATURES.professional },
    { id: "enterprise", name: "Enterprise", features: PLAN_FEATURES.enterprise },
  ];
}

export function getFeatureList(): { key: FeatureKey; name: string; description: string }[] {
  return [
    { key: "maintenance", name: "Maintenance Tracking", description: "Track vehicle maintenance schedules and recommendations" },
    { key: "job_lookup", name: "Job Lookup", description: "Search historical jobs across your shop and enterprise" },
    { key: "oil_sticker", name: "Oil Sticker", description: "Generate oil change reminder stickers" },
    { key: "part_xref", name: "Part Cross-Reference", description: "Cross-reference parts across manufacturers" },
    { key: "dvi_tracking", name: "DVI Tracking", description: "Track digital vehicle inspections" },
  ];
}
