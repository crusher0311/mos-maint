import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeFakeDb } from "./utils/fake-mongo";
import * as lookup from "../lib/extension-shop-lookup";
import * as switching from "../lib/extension-location-session";
import { createStickerLocationRequest } from "../mos-tools-extension/lib/sticker-location-session.js";
import { checkShopmonkeyPrintTarget } from "../lib/shopmonkey-print-target";

async function main() {
  const a = "aaaaaaaaaaaaaaaaaaaaaaaa", b = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const company = "cccccccccccccccccccccccc";
  const shops = [
    { shopId: 10, shopmonkey: { locationId: a, companyId: company } },
    { shopId: 11, shopmonkey: { locationId: b, companyId: company } },
  ];
  lookup.__deps.getDb = async () => makeFakeDb({ shops }).db as any;
  lookup.__deps.discoverShopmonkeyIds = async () => { throw new Error("Discovery forbidden"); };
  const opts = { providerHint: "shopmonkey", providerHintIsAuthoritative: true, userShopIds: [10] };
  assert.equal((await lookup.findShopBySmsIdDetailed(a, opts)).status, "resolved");
  assert.equal((await lookup.findShopBySmsIdDetailed(b, opts)).status, "access_denied");
  assert.equal((await lookup.findShopBySmsIdDetailed(company, opts)).status, "conflict");
  assert.equal((await lookup.findShopBySmsIdDetailed("missing", opts)).status, "not_found");
  let issued: any;
  switching.__deps.issueExtensionSession = (async (input: any) => {
    issued = input;
    return { token: "child", principal: { expiresAt: input.expiresAt } };
  }) as any;
  const auth: any = {
    authorized: true, accountUser: { _id: "user", active: true, shopId: 10, shopIds: [10, 11] },
    principal: { userId: "user", shopId: 5, provider: "tekmetric", assurance: "verified",
      authenticationMethod: "password", capabilities: ["read"], expiresAt: new Date(Date.now() + 600000) },
  };
  const change = (id: string) => switching.switchLocation(new NextRequest("https://mos.test/switch", {
    method: "POST", headers: { authorization: "Bearer root", "content-type": "application/json" },
    body: JSON.stringify({ provider: "shopmonkey", smsShopId: id }),
  }), auth);
  assert.equal((await change(a)).status, 200);
  assert.equal(issued.provider, "shopmonkey");
  assert.equal(issued.shopId, 10);
  assert.equal(issued.canWrite, false);
  assert.ok(issued.parentTokenHash);
  assert.ok(issued.expiresAt.getTime() <= Date.now() + 300000);
  assert.equal((await change(company)).status, 409);
  assert.equal((await change("")).status, 400);
  auth.accountUser.shopIds = [10];
  assert.equal((await change(b)).status, 403);
  auth.principal.authenticationMethod = undefined;
  assert.equal((await change(a)).status, 403);
  auth.principal.provider = "shopmonkey"; auth.principal.shopId = 10;
  auth.user = { shopId: 10 };
  assert.equal(await checkShopmonkeyPrintTarget(auth, "shopmonkey", a), null);
  assert.equal((await checkShopmonkeyPrintTarget(auth, "shopmonkey", b))?.status, 403);
  assert.equal((await checkShopmonkeyPrintTarget(auth, "shopmonkey", ""))?.status, 400);
  assert.equal((await (await change(a)).json()).reused, true);
  auth.principal.assurance = "basic";
  assert.equal((await change(a)).status, 403);

  let live: any = { provider: "shopmonkey", shopId: a, locationId: a, companyId: company, roId: "order-a", _tabId: 1 };
  let other = { ...live, shopId: b, locationId: b, roId: "order-b", _tabId: 2 };
  let afterFetch = () => {};
  const deps = {
    identity: () => ({ token: "root", epoch: 1, apiUrl: "https://mos.test" }),
    getTab: async (tab: number) => ({ url: `https://app.shopmonkey.cloud/orders/${tab === 1 ? 'order-a' : 'order-b'}` }),
    getContext: async (tab: number) => tab === 1 ? live : other,
    fetch: async (url: string, options: any) => {
      if (url.endsWith("switch-location")) {
        const body = JSON.parse(options.body);
        afterFetch();
        return Response.json({ token: body.smsShopId, ...body });
      }
      afterFetch();
      return Response.json({ config: { logo: options.headers.Authorization }, sticker: {}, image: "keytag" });
    },
  };
  const [one, two] = await Promise.all([
    createStickerLocationRequest(live, deps), createStickerLocationRequest(other, deps),
  ]);
  assert.equal((await one.request("/sticker")).config.logo, `Bearer ${a}`);
  assert.equal((await two.request("/keytag")).mosPrintContext.shopId, b);
  afterFetch = () => { live = { ...live, roId: "new-order" }; };
  await assert.rejects(one.request("/sticker"), /changed/);
  console.log("✓ Shopmonkey canonical location, company ambiguity, cross-provider authority, old sessions, concurrent tabs and late responses");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
