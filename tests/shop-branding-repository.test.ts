import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const original = loader._load;
loader._load = function(id, ...args) {
  if (id === "@/lib/data/db") return { getDb: () => { throw new Error("Live Mongo forbidden"); } };
  if (id === "@/lib/db/wave4-write-mode") return { isIdentityPgCanonical: () => false };
  if (id === "./pg/identity") return {};
  return original.call(this, id, ...args);
};
const { readShopBranding, __shopBrandingDeps: deps, __sharedSettingsDeps: writeDeps, replaceSharedSettingsForShop } = require("../lib/data/repositories/shops");
loader._load = original;
test("canonical-aware reads isolate shops, tolerate mixed IDs and expose only branding", async () => {
  for (const canonical of [false, true]) {
    const shops = [
      { shopId: 10, branding: { logo: "a", displayName: "Alpha" }, credential: "not-public" },
      { shopId: "11", branding: { logo: "b", displayName: "Beta" }, credential: "not-public" },
    ];
    deps.isIdentityPgCanonical = () => canonical;
    deps.findPgShop = async (id: number | string) => {
      assert.equal(canonical, true);
      return shops.find(s => Number(s.shopId) === Number(id)) ?? null;
    };
    deps.getCollection = async () => {
      assert.equal(canonical, false);
      return { findOne: async (filter: any, options: any) => {
        assert.equal(options.maxTimeMS, 5000);
        assert.deepEqual(Object.keys(options.projection).sort(), ["branding", "locationIdentifier", "protractor", "tekmetric"]);
        return shops.find(s => filter.$or.some((q: any) => q.shopId === s.shopId)) ?? null;
      }};
    };
    for (const id of [10, "10", 11, "11"]) {
      const value = await readShopBranding(id);
      assert.equal(value.displayName, Number(id) === 10 ? "Alpha" : "Beta");
      assert.equal("credential" in value, false);
      assert.equal("shopId" in value, false);
    }
    assert.equal((await readShopBranding(999)).logo, null);
    shops[0].branding.logo = "changed";
    assert.equal((await readShopBranding(10)).logo, "changed");
    delete (shops[0].branding as any).logo;
    assert.equal((await readShopBranding(10)).logo, null);
  }
});
test("shared branding writes preserve individual fields in canonical and mixed-ID Mongo modes", async () => {
  for (const canonical of [false, true]) {
    let pgWrites = 0, mongoWrites = 0;
    writeDeps.isIdentityPgCanonical = () => canonical;
    writeDeps.updatePgShopFields = async (id: number, fields: unknown) => {
      assert.equal(id, 10);
      assert.deepEqual(fields, { "branding.logo": null });
      pgWrites++;
      return { matchedCount: 1, modifiedCount: 1 };
    };
    writeDeps.getCollection = async () => ({ updateOne: async (filter: unknown, update: any) => {
      assert.deepEqual(filter, { $or: [{ shopId: 10 }, { shopId: "10" }] });
      assert.equal(update.$set["branding.logo"], null);
      assert.equal("branding.displayName" in update.$set, false);
      mongoWrites++;
      return { matchedCount: 1, modifiedCount: 1 };
    }});
    await replaceSharedSettingsForShop(10, { "branding.logo": null });
    assert.equal(pgWrites, canonical ? 1 : 0);
    assert.equal(mongoWrites, 1);
  }
});
