// lib/plan-feature-tiers.ts
//
// Pure, dependency-free definitions for feature keys and per-plan feature
// tiers. This module deliberately imports NOTHING (no Mongo, no Postgres,
// no Drizzle) so it can be safely bundled into client components such as
// the platform-admin shop management page, which needs to derive the
// feature set for a selected plan without hitting the database.
//
// `lib/featureResolver.ts` re-exports these symbols so existing server-side
// imports keep working unchanged.

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

export type BillingPlan =
  | "trial"
  | "starter"
  | "plus"
  | "elite"
  | "professional"
  | "enterprise"
  | "oil_sticker_legacy"
  | "demo"
  | "detect_dog_founder";

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

export function buildFeatures(
  enabledKeys: readonly FeatureKey[] | Set<FeatureKey>,
): FeatureSettings {
  const enabled = enabledKeys instanceof Set ? enabledKeys : new Set<FeatureKey>(enabledKeys);
  const out = {} as FeatureSettings;
  for (const k of FEATURE_KEYS) out[k] = enabled.has(k);
  return out;
}

export const PLAN_FALLBACK_KEYS: Record<BillingPlan, readonly FeatureKey[]> = {
  trial:              ["maintenance"],
  starter:            ["maintenance", "oil_sticker"],
  plus:               ["maintenance", "job_lookup", "common_failures", "oil_sticker", "concern_assistant", "estimate_assist", "dvi_prefill", "enhance_notes"],
  elite:              [...FEATURE_KEYS],
  professional:       [...FEATURE_KEYS],
  enterprise:         [...FEATURE_KEYS],
  demo:               [...FEATURE_KEYS],
  oil_sticker_legacy: ["oil_sticker", "auto_booking", "labor_rates"],
  // The founder plan is a wildcard — every current and future feature is
  // on. The fallback list is computed dynamically in featureResolver's
  // `getPlanFeaturesFromDatabase` / `getFeatureEntitlements`, but we
  // include all current keys here for callers that read this map directly.
  detect_dog_founder: [...FEATURE_KEYS],
};

export const FALLBACK_PLAN_FEATURES: Record<BillingPlan, FeatureSettings> = Object.fromEntries(
  (Object.keys(PLAN_FALLBACK_KEYS) as BillingPlan[]).map(plan => [plan, buildFeatures(PLAN_FALLBACK_KEYS[plan])])
) as Record<BillingPlan, FeatureSettings>;

/**
 * Deterministically derive the feature set for a given plan tier, suitable
 * for seeding UI checkboxes. Founder is a wildcard (all features on);
 * every other plan resolves through `PLAN_FALLBACK_KEYS` so selecting a
 * lower tier clears any leftover higher-tier features. Unknown plans fall
 * back to the trial tier.
 *
 * This is the static/UI counterpart to featureResolver's
 * `getPlanFeaturesFromDatabase`, which reads live tier membership from the
 * `platform_features` table at runtime.
 */
export function featuresForPlan(plan: string | null | undefined): FeatureSettings {
  if (isFounderPlan(plan)) return buildAllFeaturesEnabled();
  const keys = PLAN_FALLBACK_KEYS[(plan as BillingPlan)] ?? PLAN_FALLBACK_KEYS.trial;
  return buildFeatures(keys);
}
