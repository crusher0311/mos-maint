import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ENTERPRISE_SETTING_CATEGORIES,
  PROTECTED_STICKER_FIELDS,
  buildEnterpriseSettingsReplacement,
  canManageEnterpriseSettingSelection,
  canManageEnterpriseSettings,
  parseEnterpriseSettingCategories,
  snapshotEnterpriseSettings,
} from "../lib/enterprise-settings-catalog";
import {
  __sharedSettingsDeps,
  replaceSharedSettingsForShop,
} from "../lib/data/repositories/shops";
import {
  __enterpriseAccessDeps,
  updateEnterpriseUserRole,
} from "../lib/enterprise-access";

async function run() {
  assert.equal(canManageEnterpriseSettings({ role: "owner" }), true);
  assert.equal(canManageEnterpriseSettings({ role: "admin" }), true);
  assert.equal(canManageEnterpriseSettings({ role: "manager" }), false);
  assert.equal(
    canManageEnterpriseSettingSelection(
      { role: "enterprise_admin" },
      ["branding"],
    ),
    true,
  );
  assert.equal(
    canManageEnterpriseSettingSelection(
      { role: "enterprise_admin" },
      ["laborRates"],
    ),
    false,
  );
  assert.equal(
    canManageEnterpriseSettingSelection(
      { role: "user", isImpersonation: true },
      ["laborRates"],
    ),
    false,
  );
  assert.equal(
    canManageEnterpriseSettingSelection({ role: "admin" }, ["laborRates"]),
    true,
  );
  assert.deepEqual(parseEnterpriseSettingCategories(undefined), [
    ...ENTERPRISE_SETTING_CATEGORIES,
  ]);
  assert.deepEqual(parseEnterpriseSettingCategories("all"), [
    ...ENTERPRISE_SETTING_CATEGORIES,
  ]);
  assert.throws(() => parseEnterpriseSettingCategories(["branding", "unknown"]));

  const copyRouteSource = readFileSync(
    new URL("../app/api/enterprise/copy-settings/route.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    (copyRouteSource.match(/canManageEnterpriseSettingSelection\(ctx\.session, categories\)/g) || []).length,
    2,
    "copy route must enforce category permissions in both GET and POST",
  );

  const source = {
    branding: { logo: "" },
    maintenance: { dueSoonMiles: 0, dueSoonDays: null, intervals: {} },
    cannedJobMappings: {},
    manualCannedJobs: [],
    hiddenCannedJobIds: [],
    laborRateRules: [],
    stickerConfig: {
      tagline: "",
      showQRCode: false,
      phone: "source phone",
      appointmentUrl: "https://source.invalid",
      hovercodeQRId: "source-generated",
    },
  };
  const snapshot = snapshotEnterpriseSettings(source, [
    ...ENTERPRISE_SETTING_CATEGORIES,
  ]);
  const replacement = buildEnterpriseSettingsReplacement(snapshot, [
    ...ENTERPRISE_SETTING_CATEGORIES,
  ]);

  // Falsy/empty source values are snapshots, not reasons to skip a write.
  assert.equal(replacement["branding.logo"], "");
  assert.equal(replacement["maintenance.dueSoonMiles"], 0);
  assert.deepEqual(replacement["maintenance.intervals"], {});
  assert.equal(replacement["maintenance.intervalApplyMode"], null);
  assert.deepEqual(replacement["maintenance.chemicalProviders"], []);
  assert.deepEqual(replacement.cannedJobMappings, {});
  assert.deepEqual(replacement.manualCannedJobs, []);
  assert.deepEqual(replacement.laborRateRules, []);
  assert.equal(replacement["stickerConfig.tagline"], "");
  assert.equal(replacement["stickerConfig.showQRCode"], false);
  assert.equal(replacement["stickerConfig.enabled"], null);

  // Contact, appointment, and generated QR state never enter a write map.
  for (const field of PROTECTED_STICKER_FIELDS) {
    assert.equal(`stickerConfig.${field}` in replacement, false);
  }

  const original = { ...__sharedSettingsDeps };
  try {
    let mongoQuery: any;
    let mongoSet: any;
    __sharedSettingsDeps.isIdentityPgCanonical = () => false;
    __sharedSettingsDeps.getCollection = async () =>
      ({
        async updateOne(query: any, update: any) {
          mongoQuery = query;
          mongoSet = update.$set;
          return { matchedCount: 1, modifiedCount: 1 };
        },
      }) as any;
    await replaceSharedSettingsForShop(42, replacement);
    assert.deepEqual(mongoQuery.$or, [{ shopId: 42 }, { shopId: "42" }]);
    assert.deepEqual(mongoSet["maintenance.intervals"], {});

    let canonicalWrite: any;
    let canonicalMongoWrite: any;
    __sharedSettingsDeps.isIdentityPgCanonical = () => true;
    __sharedSettingsDeps.updatePgShopFields = async (shopId, fields) => {
      canonicalWrite = { shopId, fields };
      return { matchedCount: 1, modifiedCount: 1 };
    };
    __sharedSettingsDeps.getCollection = async () =>
      ({
        async updateOne(query: any, update: any) {
          canonicalMongoWrite = { query, fields: update.$set };
          return { matchedCount: 1, modifiedCount: 1 };
        },
      }) as any;
    await replaceSharedSettingsForShop(43, replacement);
    assert.equal(canonicalWrite.shopId, 43);
    assert.equal(canonicalWrite.fields["stickerConfig.phone"], undefined);
    assert.deepEqual(canonicalMongoWrite.query.$or, [
      { shopId: 43 },
      { shopId: "43" },
    ]);
    assert.equal(canonicalMongoWrite.fields["stickerConfig.phone"], undefined);

    __sharedSettingsDeps.getCollection = async () =>
      ({
        async updateOne() {
          return { matchedCount: 0, modifiedCount: 0 };
        },
      }) as any;
    await assert.rejects(
      () => replaceSharedSettingsForShop(44, replacement),
      /Mongo settings shadow not found/,
    );
  } finally {
    Object.assign(__sharedSettingsDeps, original);
  }

  // Role changes are enterprise-scoped and synchronize every duplicate user
  // document rather than updating only one location's copy.
  const accessDeps = { ...__enterpriseAccessDeps };
  try {
    const duplicateDocs = [
      { _id: { toString: () => "user-a" }, email: "person@example.com", role: "user", shopId: 42 },
      { _id: { toString: () => "user-b" }, email: "PERSON@example.com", role: "user", shopId: "43" },
    ];
    let updatedIds: unknown[] = [];
    let mongoRole: unknown;
    const pgUpdates: string[] = [];
    const fakeDb = {
      collection(name: string) {
        assert.equal(name, "users");
        return {
          find() {
            return { toArray: async () => duplicateDocs };
          },
          async updateMany(query: any, update: any) {
            updatedIds = query._id.$in;
            mongoRole = update.$set.role;
            return { matchedCount: 2, modifiedCount: 2 };
          },
        };
      },
    };
    __enterpriseAccessDeps.dualWritePgIdentity = (async (_label: string, fn: () => Promise<unknown>) => fn()) as any;
    __enterpriseAccessDeps.updateUserFields = (async (id: string) => {
      pgUpdates.push(id);
    }) as any;

    const roleResult = await updateEnterpriseUserRole(fakeDb as any, {
      enterpriseShopIds: [42, 43],
      email: "Person@example.com",
      role: "admin",
      updatedBy: "owner@example.com",
    });
    assert.equal(roleResult.ok, true);
    assert.equal(roleResult.matchedCount, 2);
    assert.equal(mongoRole, "admin");
    assert.equal(updatedIds.length, 2);
    assert.deepEqual(pgUpdates, ["user-a", "user-b"]);

    duplicateDocs[0].role = "owner";
    const ownerResult = await updateEnterpriseUserRole(fakeDb as any, {
      enterpriseShopIds: [42, 43],
      email: "Person@example.com",
      role: "user",
      updatedBy: "owner@example.com",
    });
    assert.equal(ownerResult.ok, false);
  } finally {
    Object.assign(__enterpriseAccessDeps, accessDeps);
  }

  console.log("enterprise settings task 1235 smoke checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});