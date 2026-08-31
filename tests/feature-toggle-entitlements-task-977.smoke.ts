/**
 * Regression smoke for Task #977 — admin feature toggles must affect
 * entitlements.
 *
 * Run: `npx tsx tests/feature-toggle-entitlements-task-977.smoke.ts`
 *
 * The original bug: the /admin/features page wrote a store the
 * entitlement resolver never read, so toggles silently did nothing.
 * This locks in the unified behavior:
 *   1. enableFeature(shopId, id)  → getFeatureEntitlements(...).effectiveFeatures[id] === true
 *   2. disableFeature(shopId, id) → effectiveFeatures[id] === false
 *   3. setShopFeatures(shopId, [ids]) → explicit true/false override map
 *      (listed = true, unlisted = false) that entitlements honor
 *   4. legacy string[] `shops.enabledFeatures` values are normalized via
 *      normalizeShopFeatureOverrides — never corrupted into numeric keys
 *      on merge
 *   5. founder wildcard is unaffected by per-shop false overrides
 *
 * Runs entirely against in-memory fakes swapped in via the `__deps`
 * seam in lib/featureResolver.ts — NO live Mongo/PG (dev Mongo is prod).
 */

// Force the Mongo-canonical branch regardless of ambient env.
delete process.env.IDENTITY_PG_CANONICAL;
// Make sure lib/features' isDevEnvironment() shortcut can't mask the
// resolver path in the checks below (we only use entitlements directly).

import {
  getFeatureEntitlements,
  normalizeShopFeatureOverrides,
  FEATURE_KEYS,
  FOUNDER_PLAN,
  __deps,
  type FeatureKey,
} from "../lib/featureResolver";
import {
  enableFeature,
  disableFeature,
  setShopFeatures,
  getAllFeatureIds,
} from "../lib/features";

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

// ---------------------------------------------------------------------------
// In-memory fake Mongo: findOne/updateOne over a shops map so the
// enable/disable/set writers and the entitlement reader share state.
// ---------------------------------------------------------------------------
type ShopDoc = Record<string, unknown> & { shopId: number };
const shops = new Map<number, ShopDoc>();

function fakeDb() {
  return {
    collection: (name: string) => ({
      findOne: async (filter: { shopId?: number }) => {
        if (name === "shops" && typeof filter?.shopId === "number") {
          return shops.get(filter.shopId) ?? null;
        }
        return null;
      },
      updateOne: async (
        filter: { shopId?: number },
        update: { $set?: Record<string, unknown> },
      ) => {
        if (name === "shops" && typeof filter?.shopId === "number") {
          const doc = shops.get(filter.shopId);
          if (doc && update.$set) Object.assign(doc, update.$set);
        }
        return { acknowledged: true };
      },
      find: () => ({ toArray: async () => [] }),
    }),
  };
}

// Fake PG for getPlanFeaturesFromDatabase: zero rows → static fallback
// plan map (deterministic, no live platform_features read).
function fakePgDb() {
  return {
    select: (_cols?: unknown) => ({
      from: async (_table?: unknown) => [] as unknown[],
    }),
  };
}

const originalGetDb = __deps.getDb;
const originalGetPgDb = __deps.getPgDb;
__deps.getDb = (async () => fakeDb()) as unknown as typeof __deps.getDb;
__deps.getPgDb = (() => fakePgDb()) as unknown as typeof __deps.getPgDb;

async function eff(shopId: number): Promise<Record<string, boolean>> {
  const ent = await getFeatureEntitlements(shopId);
  return ent.effectiveFeatures as Record<string, boolean>;
}

async function main() {
  section("normalizeShopFeatureOverrides (pure)");
  {
    const fromArray = normalizeShopFeatureOverrides(["keytags", "oil_sticker", "bogus_key"]);
    ok(
      "legacy string[] → {key: true} map (valid keys only)",
      fromArray.keytags === true &&
        fromArray.oil_sticker === true &&
        !("bogus_key" in fromArray),
      JSON.stringify(fromArray),
    );
    ok(
      "no numeric keys leak from array input",
      Object.keys(fromArray).every((k) => Number.isNaN(Number(k))),
      JSON.stringify(Object.keys(fromArray)),
    );
    const obj = { maintenance: false, keytags: true };
    ok(
      "object input passes through",
      JSON.stringify(normalizeShopFeatureOverrides(obj)) === JSON.stringify(obj),
    );
    ok("null/undefined → {}", Object.keys(normalizeShopFeatureOverrides(null)).length === 0 &&
      Object.keys(normalizeShopFeatureOverrides(undefined)).length === 0);
  }

  section("billing status controls entitlement access");
  {
    shops.set(10, {
      shopId: 10,
      billing: { plan: "professional", paymentType: "invoice", status: "canceled" },
      enabledFeatures: { maintenance: true },
    });
    const invoice = await getFeatureEntitlements(10);
    ok("invoice + stale canceled resolves active", invoice.billing.status === "active");
    ok("invoice + stale canceled retains feature access", invoice.canUseFeature("maintenance"));

    shops.set(11, {
      shopId: 11,
      billing: { plan: "professional", paymentType: "stripe", status: "canceled" },
      enabledFeatures: { maintenance: true },
    });
    const canceledStripe = await getFeatureEntitlements(11);
    ok("genuine Stripe cancellation remains canceled", canceledStripe.billing.status === "canceled");
    ok("genuine Stripe cancellation blocks feature access", !canceledStripe.canUseFeature("maintenance"));

    for (const status of ["paused", "unpaid", "incomplete", "incomplete_expired"] as const) {
      shops.set(12, {
        shopId: 12,
        billing: { plan: "professional", paymentType: "stripe", status },
        enabledFeatures: { maintenance: true },
      });
      const terminalStripe = await getFeatureEntitlements(12);
      ok(`${status} Stripe state is preserved`, terminalStripe.billing.status === status);
      ok(`${status} Stripe state blocks feature access`, !terminalStripe.canUseFeature("maintenance"));
    }
  }

  section("enableFeature → entitlements flip on");
  {
    shops.set(1, {
      shopId: 1,
      billing: { plan: "trial", status: "trial" },
      // trial fallback plan does NOT include keytags → baseline off
      enabledFeatures: {},
    });
    const before = await eff(1);
    ok("baseline: keytags off on trial plan", before.keytags === false, JSON.stringify(before));
    await enableFeature(1, "keytags");
    const after = await eff(1);
    ok("enableFeature('keytags') → effectiveFeatures.keytags === true", after.keytags === true);
  }

  section("disableFeature → entitlements flip off");
  {
    shops.set(2, {
      shopId: 2,
      billing: { plan: "trial", status: "trial" },
      enabledFeatures: {},
    });
    const before = await eff(2);
    ok("baseline: maintenance on for trial plan", before.maintenance === true, JSON.stringify(before));
    await disableFeature(2, "maintenance");
    const after = await eff(2);
    ok(
      "disableFeature('maintenance') → effectiveFeatures.maintenance === false",
      after.maintenance === false,
    );
  }

  section("setShopFeatures → explicit true/false override map");
  {
    shops.set(3, {
      shopId: 3,
      billing: { plan: "trial", status: "trial" },
      enabledFeatures: {},
    });
    await setShopFeatures(3, ["keytags", "oil_sticker"]);
    const stored = shops.get(3)!.enabledFeatures as Record<string, unknown>;
    ok(
      "stored map has explicit true for listed features",
      stored.keytags === true && stored.oil_sticker === true,
      JSON.stringify(stored),
    );
    ok(
      "stored map has explicit false for every unlisted feature id",
      getAllFeatureIds()
        .filter((id) => id !== "keytags" && id !== "oil_sticker")
        .every((id) => stored[id] === false),
      JSON.stringify(stored),
    );
    const e = await eff(3);
    ok("entitlements: listed features on", e.keytags === true && e.oil_sticker === true);
    ok(
      "entitlements: unlisted features off (even plan-default 'maintenance')",
      e.maintenance === false,
      JSON.stringify(e),
    );
  }

  section("legacy string[] store: merge normalizes, no numeric-key corruption");
  {
    shops.set(4, {
      shopId: 4,
      billing: { plan: "trial", status: "trial" },
      // Very old shops stored a plain array of enabled ids.
      enabledFeatures: ["keytags", "oil_sticker"],
    });
    const before = await eff(4);
    ok(
      "array store read as overrides (keytags/oil_sticker on)",
      before.keytags === true && before.oil_sticker === true,
      JSON.stringify(before),
    );
    // A single-toggle merge on top of an array store must not spread the
    // array into numeric keys.
    await enableFeature(4, "job_lookup");
    const stored = shops.get(4)!.enabledFeatures as Record<string, unknown>;
    ok("post-merge store is an object, not an array", !Array.isArray(stored));
    ok(
      "no numeric keys after merging onto legacy array",
      Object.keys(stored).every((k) => Number.isNaN(Number(k))),
      JSON.stringify(Object.keys(stored)),
    );
    ok(
      "legacy enabled ids survived the merge",
      stored.keytags === true && stored.oil_sticker === true && stored.job_lookup === true,
      JSON.stringify(stored),
    );
    const after = await eff(4);
    ok(
      "entitlements after merge: legacy + new toggles all on",
      after.keytags === true && after.oil_sticker === true && after.job_lookup === true,
    );
  }

  section("founder wildcard unaffected by toggles");
  {
    shops.set(5, {
      shopId: 5,
      billing: { plan: FOUNDER_PLAN, status: "active" },
      enabledFeatures: {},
    });
    await disableFeature(5, "maintenance");
    await setShopFeatures(5, []); // explicit false for everything
    const e = await eff(5);
    ok(
      "founder shop: every feature key still on despite false overrides",
      FEATURE_KEYS.every((k: FeatureKey) => e[k] === true),
      JSON.stringify(e),
    );
  }
}

main()
  .then(() => {
    __deps.getDb = originalGetDb;
    __deps.getPgDb = originalGetPgDb;
    if (failed > 0) {
      console.error(`\n${failed} assertion(s) failed`);
      process.exit(1);
    }
    console.log("\nAll Task #977 feature-toggle entitlement assertions passed.");
  })
  .catch((err) => {
    __deps.getDb = originalGetDb;
    __deps.getPgDb = originalGetPgDb;
    console.error(err);
    process.exit(1);
  });
