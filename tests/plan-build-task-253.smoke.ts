/**
 * Regression smoke for Task #253 — Detect Dog – Founder plan grants every
 * current and future feature.
 *
 * Run: `npx tsx tests/plan-build-task-253.smoke.ts`
 *
 * Locks in:
 *   1. `isFounderPlan` recognises only the `detect_dog_founder` plan.
 *   2. `buildAllFeaturesEnabled` reads `FEATURE_KEYS` at call time, so
 *      pushing a synthetic key in the test (simulating a developer
 *      adding a new feature) flips on without any other code change.
 *   3. `getFeatureEntitlements` for a founder shop returns every
 *      `FEATURE_KEYS` entry as enabled, even when:
 *        - the synthetic future key is not in `PLAN_FALLBACK_KEYS`
 *        - the shop has a per-shop override of `false` for some key
 *        - the enterprise has a per-enterprise override of `false`
 *   4. `getFeatureEntitlements` for a non-founder shop still honours the
 *      per-shop override (no regression).
 */

import {
  FEATURE_KEYS,
  FOUNDER_PLAN,
  isFounderPlan,
  buildAllFeaturesEnabled,
  getFeatureEntitlements,
  __deps,
  type FeatureKey,
} from "../lib/featureResolver";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

section("isFounderPlan");
ok("recognises detect_dog_founder", isFounderPlan("detect_dog_founder"));
ok("FOUNDER_PLAN constant matches", FOUNDER_PLAN === "detect_dog_founder");
ok("rejects trial", !isFounderPlan("trial"));
ok("rejects enterprise", !isFounderPlan("enterprise"));
ok("rejects null/undefined", !isFounderPlan(null) && !isFounderPlan(undefined));

async function main() {
section("buildAllFeaturesEnabled honours runtime FEATURE_KEYS");
const SYNTHETIC: string = "__future_test_feature__";
// Cast through unknown — FEATURE_KEYS is `as const` (readonly) at
// compile time but is a real Array at runtime. This simulates a future
// developer adding a new entry to the list.
const mutableKeys = FEATURE_KEYS as unknown as string[];
mutableKeys.push(SYNTHETIC);

try {
  const all = buildAllFeaturesEnabled() as Record<string, boolean>;
  ok(
    "synthetic future key is enabled",
    all[SYNTHETIC] === true,
    `got ${JSON.stringify(all[SYNTHETIC])}`,
  );
  ok(
    "all baseline keys still enabled",
    FEATURE_KEYS.every((k) => all[k] === true),
  );

  section("getFeatureEntitlements — founder shop");
  // Swap in a fake Mongo for the resolver's __deps.getDb seam.
  const originalGetDb = __deps.getDb;
  const founderShop = {
    shopId: 4242,
    name: "Founder Shop",
    enterpriseId: "ent-1",
    billing: { plan: FOUNDER_PLAN, status: "active", vinLimit: 999 },
    enabledFeatures: {
      // A stored "false" override on a real feature must NOT win for
      // founder shops — the wildcard always evaluates to true.
      maintenance: false,
      job_lookup: false,
    },
  };
  const founderEnterprise = {
    _id: "ent-1",
    // Enterprise-level "false" must also not win.
    featureSettings: { common_failures: false },
  };

  __deps.getDb = (async () => ({
    collection: (name: string) => ({
      findOne: async (_filter: unknown) => {
        if (name === "shops") return founderShop;
        if (name === "enterprise_accounts") return founderEnterprise;
        return null;
      },
      find: () => ({ toArray: async () => [] }),
    }),
  })) as unknown as typeof __deps.getDb;

  try {
    const ent = await getFeatureEntitlements(4242);
    const eff = ent.effectiveFeatures as Record<string, boolean>;

    ok("plan resolved as founder", ent.billing.plan === FOUNDER_PLAN);
    ok(
      "every FEATURE_KEYS entry is on (incl. synthetic)",
      FEATURE_KEYS.every((k) => eff[k] === true),
      `eff = ${JSON.stringify(eff)}`,
    );
    ok(
      "synthetic future key is on for founder shop",
      eff[SYNTHETIC] === true,
    );
    ok(
      "per-shop false override on `maintenance` is ignored",
      eff.maintenance === true,
    );
    ok(
      "per-shop false override on `job_lookup` is ignored",
      eff.job_lookup === true,
    );
    ok(
      "per-enterprise false override on `common_failures` is ignored",
      eff.common_failures === true,
    );
    ok(
      "isFeatureEnabled() reports true for synthetic future key",
      ent.isFeatureEnabled(SYNTHETIC as FeatureKey) === true,
    );

    section("getFeatureEntitlements — non-founder shop still honours overrides");
    const trialShop = {
      shopId: 99,
      name: "Trial Shop",
      billing: { plan: "trial", status: "trial", vinLimit: 10 },
      // On the trial plan `maintenance` is on by default; overriding to
      // false must still take effect to prove we didn't accidentally
      // wildcard everything.
      enabledFeatures: { maintenance: false },
    };
    __deps.getDb = (async () => ({
      collection: (name: string) => ({
        findOne: async (_filter: unknown) => {
          if (name === "shops") return trialShop;
          return null;
        },
        find: () => ({ toArray: async () => [] }),
      }),
    })) as unknown as typeof __deps.getDb;

    const trialEnt = await getFeatureEntitlements(99);
    ok("non-founder shop plan resolved as trial", trialEnt.billing.plan === "trial");
    ok(
      "non-founder per-shop false override still wins",
      trialEnt.effectiveFeatures.maintenance === false,
    );
  } finally {
    __deps.getDb = originalGetDb;
  }
} finally {
  // Restore FEATURE_KEYS so other tests/imports that reuse this module
  // don't see the synthetic key.
  const idx = mutableKeys.indexOf(SYNTHETIC);
  if (idx >= 0) mutableKeys.splice(idx, 1);
}

}

main().then(() => {
  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll Task #253 founder-plan assertions passed.");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
