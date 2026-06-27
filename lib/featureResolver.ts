import { getDb } from "./mongo";
import { getDb as getPgDb } from "./db/drizzle";
import { platformFeatures } from "./db/schema/platform-features";
import { eq } from "drizzle-orm";
import {
  isIdentityPgCanonical,
  shadowWriteMongoIdentity,
} from "./db/wave4-write-mode";
import {
  findShopByMosShopId as pgFindShop,
  findEnterpriseById as pgFindEnterprise,
  updateShopFields as pgUpdateShopFields,
  updateEnterpriseFeatureSettings as pgUpdateEnterpriseFeatures,
  type MongoShapedShop,
  type MongoShapedEnterprise,
} from "./data/repositories/pg/identity";

/**
 * Test seam: smoke tests can swap `__deps.getDb` / `__deps.getPgDb` to
 * inject in-memory stand-ins without touching production callers.
 * Mirrors the `__deps` pattern used by the cron route handlers under
 * `app/api/cron/`.
 *
 * task #344 (W3a, §5 row #5): runtime now reads `platform_features`
 * from Postgres. The admin UI in `app/api/platform-admin/features/**`
 * has always written PG; before this fix the runtime read Mongo, so
 * admin edits silently failed to take effect. The Mongo `getDb` is
 * still used by the shop / enterprise lookups in this file (those
 * collections move in Wave 4).
 */
export const __deps = { getDb, getPgDb };

// Feature keys, plan-tier definitions and the small pure helpers around
// them now live in a dependency-free module (`lib/plan-feature-tiers.ts`)
// so client components (e.g. the platform-admin shop page) can derive a
// plan's feature set without bundling Mongo/Postgres. They are re-exported
// here so existing server-side imports of these symbols keep working.
import {
  FEATURE_KEYS,
  buildFeatures,
  buildAllFeaturesEnabled,
  isFounderPlan,
  FOUNDER_PLAN,
  PLAN_FALLBACK_KEYS,
  FALLBACK_PLAN_FEATURES,
  featuresForPlan,
  type FeatureKey,
  type FeatureSettings,
  type BillingPlan,
} from "./plan-feature-tiers";

export {
  FEATURE_KEYS,
  buildFeatures,
  buildAllFeaturesEnabled,
  isFounderPlan,
  FOUNDER_PLAN,
  PLAN_FALLBACK_KEYS,
  FALLBACK_PLAN_FEATURES,
  featuresForPlan,
};
export type { FeatureKey, FeatureSettings, BillingPlan };

export type BillingStatus = "trial" | "active" | "past_due" | "suspended" | "canceled" | "enterprise" | "demo";

export interface ShopBilling {
  plan: BillingPlan;
  status: BillingStatus;
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

async function getPlanFeaturesFromDatabase(plan: BillingPlan): Promise<FeatureSettings> {
  // Founder plan is a wildcard — every current and future feature is on.
  // Read FEATURE_KEYS at call time so newly added features are picked up
  // automatically without anyone editing this file.
  if (isFounderPlan(plan)) {
    return buildAllFeaturesEnabled();
  }
  try {
    // task #344 (W3a, §5 row #5): read PG, not Mongo. Admin writes
    // already land in PG; this fixes the silent-no-op drift bug.
    const db = __deps.getPgDb();
    const rows = await db
      .select({
        slug: platformFeatures.slug,
        includedInTiers: platformFeatures.includedInTiers,
      })
      .from(platformFeatures)
      .where(eq(platformFeatures.status, "active"));

    if (!rows || rows.length === 0) {
      return FALLBACK_PLAN_FEATURES[plan] || FALLBACK_PLAN_FEATURES.trial;
    }

    const tierSlug = plan === "professional" ? "elite" : plan;
    const enabled = new Set<FeatureKey>();

    for (const pf of rows) {
      const includedInTiers = (pf.includedInTiers as string[] | null) || [];
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

/**
 * Thrown by getFeatureEntitlements({ throwIfMissing: true }) when the shop
 * row can't be loaded. Callers that serve the extension treat this as a
 * transient "couldn't load" signal (HTTP 503) rather than emitting an
 * all-features-off answer, which would wrongly lock paid features mid-shift.
 */
export class ShopEntitlementsUnavailableError extends Error {
  constructor(shopId: number) {
    super(`Feature entitlements unavailable for shop ${shopId}`);
    this.name = "ShopEntitlementsUnavailableError";
  }
}

export async function getFeatureEntitlements(
  shopId: number,
  opts: { throwIfMissing?: boolean } = {},
): Promise<FeatureEntitlements> {
  // W4 cutover (#346): PG-canonical shop + enterprise lookup when the
  // flag is on. Both branches return Mongo-shaped docs; PG uses the
  // typed `MongoShapedShop` / `MongoShapedEnterprise`.
  let shop: MongoShapedShop | null;
  let enterpriseFeatures: Partial<FeatureSettings> = {};
  if (isIdentityPgCanonical()) {
    shop = await pgFindShop(shopId);
    if (!shop) {
      if (opts.throwIfMissing) throw new ShopEntitlementsUnavailableError(shopId);
      return createDefaultEntitlements();
    }
    if (shop.enterpriseId) {
      const enterprise: MongoShapedEnterprise | null = await pgFindEnterprise(
        String(shop.enterpriseId),
      );
      if (enterprise?.featureSettings) {
        enterpriseFeatures = enterprise.featureSettings as Partial<FeatureSettings>;
      }
    }
  } else {
    const db = await __deps.getDb();
    shop = (await db.collection("shops").findOne({ shopId })) as unknown as
      | MongoShapedShop
      | null;
    if (!shop) {
      if (opts.throwIfMissing) throw new ShopEntitlementsUnavailableError(shopId);
      return createDefaultEntitlements();
    }
    if (shop.enterpriseId) {
      const enterprise = await db.collection("enterprise_accounts").findOne({
        _id: shop.enterpriseId
      });
      if (enterprise?.featureSettings) {
        enterpriseFeatures = enterprise.featureSettings;
      }
    }
  }

  const plan: BillingPlan = shop.billing?.plan || "trial";
  const status: BillingStatus = shop.billing?.status || "trial";

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
  // W4 cutover (#346): write PG first, optional Mongo shadow.
  if (isIdentityPgCanonical()) {
    const shop: MongoShapedShop | null = await pgFindShop(shopId);
    const existingFeatures = (shop?.enabledFeatures as Partial<FeatureSettings>) || {};
    const mergedFeatures = { ...existingFeatures, ...features };
    await pgUpdateShopFields(shopId, { enabledFeatures: mergedFeatures });
    await shadowWriteMongoIdentity("shops.enabledFeatures", async () => {
      const m = await __deps.getDb();
      await m.collection("shops").updateOne(
        { shopId },
        { $set: { enabledFeatures: mergedFeatures, updatedAt: new Date() } },
      );
    });
    return;
  }
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
  const updateFields: any = { updatedAt: new Date() };
  if (billing.plan !== undefined) updateFields["billing.plan"] = billing.plan;
  if (billing.status !== undefined) updateFields["billing.status"] = billing.status;

  if (isIdentityPgCanonical()) {
    await pgUpdateShopFields(shopId, updateFields);
    await shadowWriteMongoIdentity("shops.billing", async () => {
      const m = await __deps.getDb();
      await m.collection("shops").updateOne({ shopId }, { $set: updateFields });
    });
    return;
  }
  const db = await __deps.getDb();
  await db.collection("shops").updateOne(
    { shopId },
    { $set: updateFields }
  );
}

export async function updateEnterpriseFeatures(
  enterpriseId: string,
  features: Partial<FeatureSettings>
): Promise<void> {
  if (isIdentityPgCanonical()) {
    const enterprise: MongoShapedEnterprise | null = await pgFindEnterprise(enterpriseId);
    const existingFeatures = (enterprise?.featureSettings as Partial<FeatureSettings>) || {};
    const mergedFeatures = { ...existingFeatures, ...features };
    await pgUpdateEnterpriseFeatures(enterpriseId, mergedFeatures as Record<string, unknown>);
    await shadowWriteMongoIdentity("enterprise_accounts.featureSettings", async () => {
      const m = await __deps.getDb();
      const { ObjectId } = await import("mongodb");
      await m.collection("enterprise_accounts").updateOne(
        { _id: new ObjectId(enterpriseId) },
        { $set: { featureSettings: mergedFeatures, updatedAt: new Date() } },
      );
    });
    return;
  }
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
