import assert from "node:assert/strict";
import { evaluateBillingEligibility } from "../lib/billing-helpers";
import { getFeatureEntitlements, __deps, FEATURE_KEYS } from "../lib/featureResolver";
import { planForSubscription, planForSubscriptionUpdate } from "../lib/subscription-plan";
import { checkShopFeatureGate, __deps as gateDeps } from "../lib/extension-route-guard";
import { writeShopBillingState, __deps as writeDeps } from "../lib/shop-billing-store";

const deadline = "2030-01-01T00:00:00.000Z";
const at = Date.parse(deadline);
let shop: any;
let addons: any[] = [];
let platformRows: any[] = [];
const originalNow = Date.now;
Date.now = () => at - 1;
__deps.getPgDb = (() => ({ select: () => ({ from: async () => platformRows }) })) as any;
__deps.getDb = (async () => ({ collection: (name: string) => ({
  findOne: async () => name === "shops" ? shop : name === "shop_features" ? { subscriptions: addons } : null,
}) })) as any;
__deps.pgFindShop = (async () => shop) as any;
__deps.findShopFeaturesByShopId = (async () => ({ subscriptions: addons })) as any;

async function main() {
  for (const canonical of ["0", "1"]) {
    process.env.IDENTITY_PG_CANONICAL = canonical;
    // Real catalog rows use Detect Dog tier names, never legacy "pro".
    platformRows = FEATURE_KEYS.map(slug => ({
      slug, status: "active", includedInTiers: ["starter", "plus", "elite", "enterprise"],
    }));
    for (const plan of ["pro", planForSubscription(
      { items: { data: [{ price: { id: "legacy_pro_price" } }] } },
      { mosProPriceId: "legacy_pro_price" },
    )]) {
      shop = {
        shopId: 1, billing: { plan, status: "active" },
        enabledFeatures: Object.fromEntries(FEATURE_KEYS.map(k => [k, true])),
      };
      const pro = await getFeatureEntitlements(1);
      for (const feature of ["maintenance", "job_lookup", "common_failures", "oil_sticker", "keytags", "auto_booking", "part_xref"] as const) {
        assert.equal(pro.canUseFeature(feature), true, `existing/checkout Pro retains ${feature}`);
      }
      assert.equal(pro.canUseFeature("auto_dvi"), false, "catalog tags cannot widen legacy contract");
      platformRows.find(row => row.slug === "keytags").status = "inactive";
      assert.equal((await getFeatureEntitlements(1)).canUseFeature("keytags"), false, "intentional global disable wins");
      platformRows.find(row => row.slug === "keytags").status = "active";
    }
    shop = {
      shopId: 1, billing: { plan: "oil_sticker_legacy", status: "active", stripeSubscriptionId: "sub_custom" },
      enabledFeatures: Object.fromEntries(FEATURE_KEYS.map(k => [k, true])),
    };
    for (const feature of ["oil_sticker", "auto_booking", "labor_rates"] as const) {
      assert.equal((await getFeatureEntitlements(1)).canUseFeature(feature), true, `legacy contract retains ${feature}`);
      platformRows.find(row => row.slug === feature).status = "inactive";
      assert.equal((await getFeatureEntitlements(1)).canUseFeature(feature), false, "inactive catalog row still denies");
      platformRows.find(row => row.slug === feature).status = "active";
    }
    assert.equal((await getFeatureEntitlements(1)).canUseFeature("maintenance"), false);
    const customSubscription = { id: "sub_custom", items: { data: [{ price: { id: "old_custom_price" } }] } };
    assert.equal(planForSubscription(customSubscription, {}), null, "unknown new purchases are not granted a plan");
    shop.billing.plan = planForSubscriptionUpdate(customSubscription, {}, shop.billing);
    assert.equal(shop.billing.plan, "oil_sticker_legacy");
    assert.equal((await getFeatureEntitlements(1)).canUseFeature("oil_sticker"), true);
    for (const status of ["trial", "trialing", "incomplete", "incomplete_expired"]) {
      assert.equal(planForSubscriptionUpdate(customSubscription, {}, { ...shop.billing, status }), "unrecognized");
    }
    assert.equal(planForSubscriptionUpdate({ ...customSubscription, id: "different" }, {}, shop.billing), "unrecognized");
    assert.equal(planForSubscriptionUpdate(customSubscription, {}, { ...shop.billing, subscriptionAccessConfirmed: false }), "unrecognized");
    assert.equal(planForSubscriptionUpdate(
      { ...customSubscription, items: { data: [{ price: { id: "starter_price" } }] } },
      { starterPriceId: "starter_price" }, shop.billing,
    ), "starter", "a known downgrade replaces the legacy contract");
    platformRows = [];
    for (const status of ["trial", "trialing"]) {
      for (const dates of [{ trial: { endsAt: deadline } }, { trialEndsAt: deadline }]) {
        shop = { shopId: 1, billing: { plan: "elite", status }, enabledFeatures: Object.fromEntries(FEATURE_KEYS.map(k => [k, true])), ...dates };
        Date.now = () => at - 1;
        const before = await getFeatureEntitlements(1);
        assert.equal(before.canUseFeature("auto_dvi"), true);
        for (const now of [at, at + 1]) {
          Date.now = () => now;
          assert.equal(before.canUseFeature("auto_dvi"), false, "retained server result expires");
          const expired = await getFeatureEntitlements(1);
          assert.ok(Object.values(expired.effectiveFeatures).every(v => !v));
          assert.equal(expired.eligibility?.reason, "trial_expired");
          assert.equal(expired.configuredFeatures?.auto_dvi, true);
        }
      }
    }
    for (const trial of [undefined, { endsAt: null }, { endsAt: "bad" }]) {
      shop = { billing: { status: "trial", plan: "elite" }, trial, enabledFeatures: { auto_dvi: true } };
      assert.equal((await getFeatureEntitlements(1)).canUseFeature("auto_dvi"), false);
    }
    shop = { billing: { status: "active", plan: "starter" }, enabledFeatures: { keytags: true, oil_sticker: true, maintenance: true } };
    let ent = await getFeatureEntitlements(1);
    assert.equal(ent.canUseFeature("keytags"), false);
    assert.equal(ent.canUseFeature("oil_sticker"), true);
    shop.billing.plan = "elite";
    assert.equal((await getFeatureEntitlements(1)).canUseFeature("keytags"), true);
    shop.billing.plan = "starter";
    assert.equal((await getFeatureEntitlements(1)).canUseFeature("keytags"), false);
    gateDeps.getFeatureEntitlements = getFeatureEntitlements;
    assert.equal((await checkShopFeatureGate(1, ["keytags"]))?.status, 403);
    assert.equal(await checkShopFeatureGate(1, ["oil_sticker"]), null);
    addons = [{ featureId: "keytags", status: "active", stripeSubscriptionId: "sub_fixture" }];
    assert.equal((await getFeatureEntitlements(1)).canUseFeature("keytags"), true);
    addons = [];
    for (const status of ["incomplete", "unpaid", "canceled"]) {
      shop.billing.status = status;
      assert.equal((await getFeatureEntitlements(1)).canUseFeature("oil_sticker"), false);
    }
    shop.billing = { status: "canceled", paymentType: "invoice", plan: "starter" };
    assert.equal((await getFeatureEntitlements(1)).canUseFeature("keytags"), true);
    shop.billing = { status: "active", plan: "detect_dog_founder" };
    assert.equal((await getFeatureEntitlements(1)).canUseFeature("auto_dvi"), true);
    assert.equal((await getFeatureEntitlements(1)).canUseFeature("shop_workflow"), false);
    shop = null;
    await assert.rejects(() => getFeatureEntitlements(1, { throwIfMissing: true }));
  }
  const writes: string[] = [];
  writeDeps.updateShopFields = (async (_id: any, fields: any) => {
    assert.equal(fields["trial.endsAt"], deadline);
    writes.push("pg");
    return { matchedCount: 1, modifiedCount: 1 };
  }) as any;
  writeDeps.shadowWriteMongoIdentity = async (_label, write) => { await write(); };
  const db = { collection: () => ({ updateOne: async () => { writes.push("mongo"); return {}; } }) };
  await writeShopBillingState(db, 1, { $set: { "trial.endsAt": deadline } });
  assert.deepEqual(writes, ["pg", "mongo"]);
  writes.length = 0;
  process.env.IDENTITY_PG_CANONICAL = "0";
  await writeShopBillingState(db, 1, { $set: { "trial.endsAt": deadline } });
  assert.deepEqual(writes, ["mongo"]);
  gateDeps.getFeatureEntitlements = async () => { throw new Error("offline lookup failure"); };
  assert.equal((await checkShopFeatureGate(1, ["maintenance"]))?.status, 503);
  assert.equal(evaluateBillingEligibility({ billing: { status: "trial", stripeSubscriptionId: "stale" }, trial: { endsAt: null }, trialEndsAt: deadline }, at - 1).allowed, false);
  assert.equal(evaluateBillingEligibility({ billing: { status: "past_due", subscriptionAccessConfirmed: false } }).allowed, false);
  assert.equal(planForSubscription({ items: { data: [{ price: { id: "price_low" } }] } }, { starterPriceId: "price_low" }), "starter");
  Date.now = originalNow;
  console.log("Trial expiration regressions passed (both canonical stores).");
}
main().catch(error => { Date.now = originalNow; console.error(error); process.exitCode = 1; });
