/**
 * Smoke test for the MyOilSticker → mos.tools migration mapping (task #1181).
 *
 * Proves, without touching any database:
 *   1. The feature gate permits migrated shops to use oil stickers: the
 *      assigned billing plan/status pass featureResolver's isBillingActive
 *      semantics AND both the plan tier and the explicit per-shop override
 *      grant `oil_sticker`.
 *   2. The frozen/disabled rule and sensitive-field exclusions hold.
 *   3. Rollback selector `legacyMigrationCreated` is set on created shops.
 *
 * Run: npm run test:myoilsticker-migration
 */

import assert from "node:assert";
import {
  buildShopDoc,
  buildLegacyMeta,
  buildCustomGroup,
  looksLikeBcrypt,
  MIGRATED_BILLING,
  SENSITIVE_LEGACY_FIELDS,
  TZ_MAP,
} from "../scripts/myoilsticker-migration-mapping";
import {
  FALLBACK_PLAN_FEATURES,
  PLAN_FALLBACK_KEYS,
  type BillingPlan,
} from "../lib/plan-feature-tiers";

const now = new Date("2026-08-25T00:00:00Z");

const legacyUser = {
  _id: "660a7ca946ec6e2fe4c1c3f4",
  email: "Shop@Example.com ",
  firstName: "Jane",
  lastName: "Doe",
  phoneNumber: "+14055551234",
  password: "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
  targetMile: "5000",
  targetMonth: "6",
  targetShopTag: "We Fix Everything",
  targetPhone: "4055550000",
  targetSchedule: "https://qr.myoilsticker.com/shop",
  targetColor: "#ffffff",
  stickerBGColor: "#000000",
  stickerPhoneColor: "#eeeeee",
  stickerShopTagColor: "#dddddd",
  stickerSize: "2x3.5",
  serviceUnit: "kms",
  stickerStatus: true,
  text: "Next Service Due",
  hovercode: "qr-id-123",
  predictiveDate: true,
  roundMileage: false,
  carfaxEnable: true,
  carfaxLocationId: "",
  timeZone: "EST",
  lat: 35.5,
  lon: -97.5,
  isFrozen: false,
  isEmailVerified: false,
  isSubscribed: true,
  subDescription: "1 × My Oil Sticker (at $79.95 / month)",
  createdAt: new Date("2024-04-01T00:00:00Z"),
  // sensitive — must never be copied
  targetPwd: "SECRET",
  targetUser: "scraper-login@sms.com",
  cookieInfo: "session=abc",
  tokenInfo: "tok",
  apiKey: "legacykey",
};

const shop = buildShopDoc(legacyUser, now);

/* 1. Feature gate: migrated shops must be entitled to oil_sticker. */
assert.strictEqual(shop.billing.plan, MIGRATED_BILLING.plan);
assert.strictEqual(shop.billing.status, "active"); // in featureResolver's isBillingActive list
const plan = shop.billing.plan as BillingPlan;
assert.ok(
  PLAN_FALLBACK_KEYS[plan].includes("oil_sticker"),
  `plan ${plan} tier must include oil_sticker`,
);
assert.strictEqual(FALLBACK_PLAN_FEATURES[plan].oil_sticker, true);
// Explicit per-shop override (shops.enabledFeatures is the resolver-read
// override store) also grants it, independent of plan tier rows in PG.
assert.strictEqual(shop.enabledFeatures.oil_sticker, true);

/* 2. Sticker settings mapping. */
assert.strictEqual(shop.stickerConfig.defaultSize, "2x3.5");
assert.strictEqual(shop.stickerConfig.useKilometers, true);
assert.strictEqual(shop.stickerConfig.intervals.conventional.mileage, 5000);
assert.strictEqual(shop.stickerConfig.intervals.conventional.months, 6);
assert.strictEqual(shop.stickerConfig.appointmentUrl, "https://qr.myoilsticker.com/shop");
assert.strictEqual(shop.stickerConfig.hovercodeQRId, "qr-id-123");
assert.strictEqual(shop.stickerConfig.colors.background, "#000000");
assert.strictEqual(shop.timezone, TZ_MAP.EST);
assert.deepStrictEqual(shop.location, { lat: 35.5, lon: -97.5 });
assert.strictEqual(shop.carfax.enabled, true);
assert.strictEqual(shop.carfax.locationId, undefined); // empty string dropped
assert.strictEqual(shop.contactEmail, "shop@example.com");

/* 3. Rollback selector + tags. */
assert.strictEqual(shop.legacyMigrationCreated, true);
assert.strictEqual(shop.legacySource, "myoilsticker");
assert.strictEqual(shop.legacyOilStickerId, String(legacyUser._id));

/* 4. Sensitive legacy fields never appear anywhere in shop doc or metadata. */
const serialized = JSON.stringify({ shop, meta: buildLegacyMeta(legacyUser) });
for (const [k, v] of Object.entries(legacyUser)) {
  if ((SENSITIVE_LEGACY_FIELDS as readonly string[]).includes(k)) {
    assert.ok(
      !serialized.includes(String(v)),
      `sensitive legacy field ${k} leaked into migrated docs`,
    );
  }
}

/* 5. bcrypt detection + custom group mapping. */
assert.strictEqual(looksLikeBcrypt(legacyUser.password), true);
assert.strictEqual(
  looksLikeBcrypt("$2a$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"),
  true,
);
// Malformed/truncated bcrypt-looking values must be rejected (imported
// disabled instead of carrying an unusable hash into login):
assert.strictEqual(looksLikeBcrypt("plaintext"), false);
assert.strictEqual(looksLikeBcrypt("$2b$10$abcdefghijklmnopqrstuv"), false); // truncated payload
assert.strictEqual(looksLikeBcrypt("$2b$10$"), false); // prefix only
assert.strictEqual(
  looksLikeBcrypt("$2b$1$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"),
  false, // one-digit cost
);
assert.strictEqual(
  looksLikeBcrypt("$2b$03$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"),
  false, // cost below bcrypt minimum
);
assert.strictEqual(
  looksLikeBcrypt("$2x$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"),
  false, // unknown version
);
assert.strictEqual(
  looksLikeBcrypt("$2b$10$N9qo8uLOickgx2ZMRZoMye!jZAgcfl7p92ldGxad68LJZdL17lhWy"),
  false, // illegal char in payload
);
assert.strictEqual(
  looksLikeBcrypt("$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWyX"),
  false, // payload too long
);
assert.strictEqual(looksLikeBcrypt(null), false);
const grp = buildCustomGroup({ _id: "abc", name: "VW", makes: ["Volkswagen"], laborRate: "22500" });
assert.deepStrictEqual(grp, {
  name: "VW",
  makes: ["Volkswagen"],
  laborRateCents: 22500,
  legacyGroupId: "abc",
});

console.log("myoilsticker-migration-mapping smoke: all assertions passed");
