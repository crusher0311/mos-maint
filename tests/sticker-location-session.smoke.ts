import assert from "node:assert/strict";
import { createStickerLocationRequest } from "../mos-tools-extension/lib/sticker-location-session.js";

async function main() {
  let identity = { token: "explicit-root", apiUrl: "https://mos.test", epoch: 1 };
  const tabs = new Map([[1, "100"], [2, "200"]]);
  let revision = 0;
  let delay: (() => Promise<void>) | null = null;
  let status = 200;
  let switches = 0;
  const printed: string[] = [];
  const deps = {
    identity: () => identity,
    revision: () => revision,
    getTab: async (id: number) => ({ url: `https://shop.tekmetric.com/admin/shop/${tabs.get(id)}/repair-orders/88` }),
    fetch: async (url: string, options: any) => {
      if (url.endsWith("/switch-location")) {
        switches++;
        if (delay) await delay();
        const { smsShopId } = JSON.parse(options.body);
        assert.equal(options.headers.Authorization, "Bearer explicit-root");
        return Response.json(status === 200
          ? { token: `scope-${smsShopId}`, provider: "tekmetric", smsShopId }
          : { error: "Location unavailable", code: "LOCATION_LOOKUP_FAILED" }, { status });
      }
      const sms = options.headers.Authorization.replace("Bearer scope-", "");
      assert.equal(new URL(url).searchParams.get("shopId"), sms);
      if (delay) await delay();
      printed.push(sms);
      return Response.json({ success: true, config: { logo: `logo-${sms}` }, sticker: { dataUrl: `image-${sms}` } });
    },
  };
  const context = (tab: number) => ({ provider: "tekmetric", _tabId: tab, shopId: tabs.get(tab), roId: "88" });
  const print = async (tab: number) => {
    const ctx = context(tab);
    const scope = await createStickerLocationRequest(ctx, deps);
    return scope.request(`/api/extension/sticker?shopId=${ctx.shopId}&provider=tekmetric`);
  };
  for (const shop of ["100", "200", "100"]) {
    tabs.set(1, shop);
    const result = await print(1);
    assert.equal(result.config.logo, `logo-${shop}`);
    assert.equal(result.sticker.mosPrintContext.shopId, shop);
  }
  assert.deepEqual(printed, ["100", "200", "100"]);
  const [a, b] = await Promise.all([print(1), print(2)]);
  assert.equal(a.sticker.dataUrl, "image-100");
  assert.equal(b.sticker.dataUrl, "image-200");
  assert.equal(identity.token, "explicit-root");
  // Re-instantiating after a worker restart exchanges the restored explicit
  // root again: no persisted child token or settings are reused.
  await print(2);
  assert.equal(switches, 6);
  const before = printed.length;
  delay = async () => { revision++; };
  await assert.rejects(print(1), /page changed/);
  assert.equal(printed.length, before);
  delay = null;
  const stale = await createStickerLocationRequest(context(1), deps);
  tabs.set(1, "200");
  await assert.rejects(stale.request("/api/extension/sticker?shopId=100"), /location changed/);
  tabs.set(1, "100");
  const signedOut = await createStickerLocationRequest(context(1), deps);
  identity = { ...identity, epoch: 2 };
  await assert.rejects(signedOut.request("/api/extension/sticker?shopId=100"), /login changed/);
  for (const code of [403, 404, 409, 503]) {
    status = code;
    await assert.rejects(print(1), /Location unavailable/);
  }
  console.log("✓ A/B/A branding, concurrent tabs, restart, stale transitions, logout and failed exchanges");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
