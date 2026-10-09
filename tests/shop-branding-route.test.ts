import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown };
const original = loader._load;
const writes: unknown[] = [];
loader._load = function(id, ...args) {
  if (id === "next/server") return { NextResponse: { json: (v: unknown, init?: ResponseInit) => Response.json(v, init) } };
  if (id === "@/lib/auth") return { requireSession: async () => ({ shopId: 10 }) };
  if (id === "@/lib/data/repositories/shops") return {
    readShopBranding: async (id: number) => {
      assert.equal(id, 10);
      return { logo: null, displayName: "Shop", locationIdentifier: "North", smsType: "tekmetric" };
    },
    replaceSharedSettingsForShop: async (id: number, fields: unknown) => {
      assert.equal(id, 10);
      writes.push(fields);
      return { matchedCount: 1 };
    },
  };
  return original.call(this, id, ...args);
};
const route = require("../app/api/settings/branding/route");
loader._load = original;
test("shared branding route uses canonical repository, session tenant and uncached reads", async () => {
  const response = await route.GET();
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await response.json(), { logo: null, shopName: "Shop", locationIdentifier: "North", smsType: "tekmetric", fallbackLogo: "/tekmetric-logo.png" });
  assert.equal((await route.POST(new Request("https://test/api/settings/branding", {
    method: "POST", body: JSON.stringify({ shopId: 999, displayName: "New", logo: null }),
  }))).status, 200);
  assert.deepEqual(writes[0], { "branding.displayName": "New", "branding.logo": null });
  assert.equal((await route.DELETE()).status, 200);
  assert.deepEqual(writes[1], { "branding.logo": null });
});
