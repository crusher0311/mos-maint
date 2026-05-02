import { getDb } from "./mongo";

/**
 * Test seam: smoke tests can swap `__deps.getDb` to inject an in-memory
 * Mongo stand-in without touching production callers. Mirrors the
 * `__deps` pattern used by the cron route handlers under `app/api/cron/`.
 */
export const __deps = { getDb };

export const FEATURE_KEYS = [
  "maintenance",
  "job_lookup",
  "common_failures",
  "oil_sticker",
  "keytags",
  "auto_booking",
  "part_xref",
  "labor_rates",
  "concern_assistant",
  "estimate_assist",
  "dvi_prefill",
  "enhance_notes",
] as const;

export type FeatureKey = typeof FEATURE_KEYS[number];

export type FeatureSettings = Record<FeatureKey, boolean>;

export type BillingStatus = "trial" | "active" | "past_due" | "suspended" | "canceled" | "enterprise" | "demo";

export type BillingPlan = "trial" | "starter" | "plus" | "elite" | "professional" | "enterprise" | "oil_sticker_legacy" | "demo" | "detect_dog_founder";

export const FOUNDER_PLAN: BillingPlan = "detect_dog_founder";

export function isFounderPlan(plan: string | null | undefined): boolean {
  return plan === FOUNDER_PLAN;
}

/**
 * Build a FeatureSettings object that has every key in FEATURE_KEYS set
 * to `true`. Reads `FEATURE_KEYS` at call time so newly added features
 * are picked up automatically (the whole point of the founder wildcard).
 */
export function buildAllFeaturesEnabled(): FeatureSettings {
  const out = {} as FeatureSettings;
  for (const k of FEATURE_KEYS) out[k] = true;
  return out;
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

export const FEATURE_METADATA: Record<FeatureKey, { name: string; description: string }> = {
  maintenance:        { name: "Maintenance Tracking",       description: "Track vehicle maintenance schedules, DVI insights, and recommendations" },
  job_lookup:         { name: "Job Lookup",                  description: "Search historical jobs with smart autocomplete across your shop and enterprise" },
  common_failures:    { name: "Common Failures Advisor",     description: "Predict common repairs by vehicle, powertrain, and mileage" },
  oil_sticker:        { name: "Oil Sticker",                 description: "Generate oil change reminder stickers" },
  keytags:            { name: "Keytags",                     description: "Print customer/vehicle info on Dymo labels for key identification" },
  auto_booking:       { name: "Auto Booking",                description: "Automated appointment booking for oil change reminders" },
  part_xref:          { name: "Part Cross-Reference",        description: "Cross-reference parts across manufacturers" },
  labor_rates:        { name: "Labor Rate Rules",            description: "Auto-apply labor rates based on vehicle, customer, and job criteria" },
  concern_assistant:  { name: "Concern Assistant",           description: "AI-powered customer concern intake with follow-up questions and RO injection" },
  estimate_assist:    { name: "Estimate Assist",             description: "AI-powered estimate language and audit suggestions" },
  dvi_prefill:        { name: "DVI Pre-fill",                description: "Auto-fill Tekmetric DVI ratings from VHI maintenance data" },
  enhance_notes:      { name: "Enhance Notes",               description: "Rewrite technician findings into customer-facing language with AI" },
};

function buildFeatures(enabledKeys: readonly FeatureKey[] | Set<FeatureKey>): FeatureSettings {
  const enabled = enabledKeys instanceof Set ? enabledKeys : new Set<FeatureKey>(enabledKeys);
  const out = {} as FeatureSettings;
  for (const k of FEATURE_KEYS) out[k] = enabled.has(k);
  return out;
}

const DEFAULT_FEATURES: FeatureSettings = buildFeatures(["maintenance"]);

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
  "dvi-prefill": "dvi_prefill",
  "dvi_prefill": "dvi_prefill",
  "enhance-notes": "enhance_notes",
  "enhance_notes": "enhance_notes",
};

const PLAN_FALLBACK_KEYS: Record<BillingPlan, readonly FeatureKey[]> = {
  trial:              ["maintenance"],
  starter:            ["maintenance", "oil_sticker"],
  plus:               ["maintenance", "job_lookup", "common_failures", "oil_sticker", "concern_assistant", "estimate_assist", "dvi_prefill", "enhance_notes"],
  elite:              [...FEATURE_KEYS],
  professional:       [...FEATURE_KEYS],
  enterprise:         [...FEATURE_KEYS],
  demo:               [...FEATURE_KEYS],
  oil_sticker_legacy: ["oil_sticker", "auto_booking", "labor_rates"],
  // The founder plan is a wildcard — every current and future feature is
  // on. The fallback list is computed dynamically below in
  // `getPlanFeaturesFromDatabase` / `getFeatureEntitlements`, but we
  // include all current keys here for callers that read this map directly.
  detect_dog_founder: [...FEATURE_KEYS],
};

const FALLBACK_PLAN_FEATURES: Record<BillingPlan, FeatureSettings> = Object.fromEntries(
  (Object.keys(PLAN_FALLBACK_KEYS) as BillingPlan[]).map(plan => [plan, buildFeatures(PLAN_FALLBACK_KEYS[plan])])
) as Record<BillingPlan, FeatureSettings>;

async function getPlanFeaturesFromDatabase(plan: BillingPlan): Promise<FeatureSettings> {
  // Founder plan is a wildcard — every current and future feature is on.
  // Read FEATURE_KEYS at call time so newly added features are picked up
  // automatically without anyone editing this file.
  if (isFounderPlan(plan)) {
    return buildAllFeaturesEnabled();
  }
  try {
    const db = await __deps.getDb();
    const platformFeatures = await db.collection("platform_features")
      .find({ status: "active" })
      .toArray();

    if (!platformFeatures || platformFeatures.length === 0) {
      return FALLBACK_PLAN_FEATURES[plan] || FALLBACK_PLAN_FEATURES.trial;
    }

    const tierSlug = plan === "professional" ? "elite" : plan;
    const enabled = new Set<FeatureKey>();

    for (const pf of platformFeatures) {
      const includedInTiers = pf.includedInTiers || [];
      const featureKey = FEATURE_SLUG_TO_KEY[pf.slug];
      if (featureKey && includedInTiers.includes(tierSlug)) {
        enabled.add(featureKey);
      }
    }

    return buildFeatures(enabled);
  } catch (error) {
    console.error("Error fetching plan features from database:", error);
    return FALLBACK_PLAN_FEATURES[plan] || FALLBACK_PLAN_FEATURES.trial;
  }
}

export async function getFeatureEntitlements(shopId: number): Promise<FeatureEntitlements> {
  const db = await __deps.getDb();

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

  const shopFeatures: Partial<FeatureSettings> = shop.enabledFeatures || {};

  // Founder plan is a wildcard: every current AND future feature key is
  // on, regardless of per-shop or per-enterprise overrides. Read
  // FEATURE_KEYS at call time so newly added entries take effect on the
  // very next request without touching this file or PLAN_FALLBACK_KEYS.
  let effectiveFeatures: FeatureSettings;
  if (isFounderPlan(plan)) {
    effectiveFeatures = buildAllFeaturesEnabled();
  } else {
    const planFeatures = await getPlanFeaturesFromDatabase(plan);
    effectiveFeatures = {} as FeatureSettings;
    for (const key of FEATURE_KEYS) {
      effectiveFeatures[key] =
        shopFeatures[key] ?? enterpriseFeatures[key] ?? planFeatures[key] ?? false;
    }
  }

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

export function pickValidFeatures(input: Record<string, unknown>): Partial<FeatureSettings> {
  const out: Partial<FeatureSettings> = {};
  if (!input) return out;
  for (const key of FEATURE_KEYS) {
    if (!(key in input)) continue;
    const v = input[key];
    if (typeof v === "boolean") {
      out[key] = v;
    } else if (v === null) {
      // Preserve prior semantics: null clears the shop/enterprise override
      // and lets the entitlement resolver fall back to enterprise/plan.
      (out as Record<string, unknown>)[key] = null;
    }
  }
  return out;
}

export async function updateShopFeatures(
  shopId: number,
  features: Partial<FeatureSettings>
): Promise<void> {
  const db = await __deps.getDb();

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
  const db = await __deps.getDb();

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
  const db = await __deps.getDb();
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
  return FEATURE_KEYS.map(key => ({ key, ...FEATURE_METADATA[key] }));
}
