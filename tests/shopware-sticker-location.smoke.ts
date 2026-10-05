import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { __deps, findShopBySmsIdDetailed } from "../lib/extension-shop-lookup";
import { makeFakeDb } from "./utils/fake-mongo";
import { verifiedShopwareLocation } from "../lib/shopware-sticker-location";

const shops: Array<{
  shopId: number;
  shopware: { tenantId: string | number; swShopId: string | number; tenantSubdomain: string };
  stickerConfig: { logo: string };
}> = [
  { shopId: 136, shopware: { tenantId: 5700, swShopId: 6194, tenantSubdomain: "shared" }, stickerConfig: { logo: "state" } },
  { shopId: 174, shopware: { tenantId: "5700", swShopId: "6192", tenantSubdomain: "shared" }, stickerConfig: { logo: "hoover" } },
];
async function main() {
  const roContext = { locationId: null, repairOrderId: 12 };
  const locationContext = { locationId: 6194, repairOrderId: null };
  assert.equal(verifiedShopwareLocation({ id: 12, shop_id: 6194 }, 5700, roContext), 6194);
  assert.equal(verifiedShopwareLocation({ id: 6194, tenant_id: 5700 }, 5700, locationContext), 6194);
  for (const data of [null, {}, { id: 13, shop_id: 6194 }, { id: 12, shop_id: 6194, tenant_id: 999 }]) {
    assert.throws(() => verifiedShopwareLocation(data, 5700, roContext));
  }
  for (const data of [{ id: 6194 }, { id: 6194, tenant_id: 999 }, { id: 6192, tenant_id: 5700 }]) {
    assert.throws(() => verifiedShopwareLocation(data, 5700, locationContext));
  }
  const originalDb = __deps.getDb;
  const originalVerify = __deps.verifyShopwareLocation;
  let verified = 6194;
  let calls = 0;
  let fake = makeFakeDb({ shops });
  const reset = (rows = shops) => { fake = makeFakeDb({ shops: rows }); calls = 0; };
  __deps.getDb = async () => fake.db as any;
  __deps.verifyShopwareLocation = async (tenant, context) => {
    calls++;
    assert.equal(tenant, 5700);
    assert.ok(context.locationId || context.repairOrderId);
    return verified;
  };
  const lookup = (extra: any = {}, userShopIds = [136]) =>
    findShopBySmsIdDetailed("shared", {
      providerHint: "shopware", providerHintIsAuthoritative: true, userShopIds, ...extra,
    });
  try {
    assert.equal((await lookup()).status, "conflict", "old slug-only clients remain blocked");
    assert.equal(calls, 0);
    const state = await lookup({ shopwareLocationId: "6194", shopwareRepairOrderId: "12" });
    assert.equal(state.status, "resolved");
    if (state.status === "resolved") assert.equal(state.shopDoc.stickerConfig.logo, "state");
    verified = 6192;
    const hoover = await lookup({ shopwareRepairOrderId: "13" }, [174]);
    assert.equal(hoover.status, "resolved", "RO evidence derives active location without DOM hints");
    if (hoover.status === "resolved") assert.equal(hoover.shopDoc.stickerConfig.logo, "hoover");
    assert.equal((await lookup({ shopwareLocationId: 6192 })).status, "access_denied");
    assert.equal((await lookup({ shopwareLocationId: 6192 }, [])).status, "access_denied");
    assert.equal((await lookup({ shopwareLocationId: 6194, shopwareRepairOrderId: 13 })).status, "not_found", "RO/location mismatch fails closed");
    assert.ok(fake.ops.every(op => ["find", "findOne"].includes(op.op)));
    for (const id of ["6194junk", "0", -1, "", [], ["6194"], "9007199254740993"]) {
      reset();
      assert.equal((await lookup({ shopwareLocationId: id })).status, "not_found");
      assert.equal(calls, 0);
    }
    reset([...shops, { ...shops[0], shopId: 999, shopware: { ...shops[0].shopware, tenantSubdomain: "different-alias" } }]);
    verified = 6194;
    assert.equal((await lookup({ shopwareLocationId: 6194 })).status, "conflict", "global pair duplicate under other alias blocks");
    reset([...shops, { ...shops[0], shopId: 999, shopware: { ...shops[0].shopware, tenantId: 7777 } }]);
    assert.equal((await lookup({ shopwareLocationId: 6194 })).status, "conflict", "same slug claimed by different tenants blocks");
    assert.equal(calls, 0);
    reset();
    verified = 7777;
    assert.equal((await lookup({ shopwareRepairOrderId: 12 })).status, "not_found", "unknown pair cannot fall back to accessible shop");
    __deps.verifyShopwareLocation = async () => { throw new Error("provider unavailable"); };
    await assert.rejects(lookup({ shopwareLocationId: 6194 }), /provider unavailable/);
  } finally {
    __deps.getDb = originalDb;
    __deps.verifyShopwareLocation = originalVerify;
  }

  // Run the real context detector in isolation, including SPA location changes.
  const adapter = fs.readFileSync("mos-tools-extension/adapters/shopware-content.js", "utf8");
  const detector = adapter.slice(adapter.indexOf("function detectContext()"), adapter.indexOf("function updateContext()"));
  const sandbox: any = {
    URL, console: { log() {} },
    window: { location: { href: "https://shared.shop-ware.com/work_orders/12?shop_id=6194", hostname: "shared.shop-ware.com" } },
    document: { body: { innerText: "" }, querySelector: () => null, querySelectorAll: () => [] },
  };
  vm.createContext(sandbox);
  vm.runInContext(detector, sandbox);
  let ctx = sandbox.detectContext();
  assert.equal(ctx.shopId, "shared");
  assert.equal(ctx.swShopId, "6194");
  assert.equal(ctx.roId, "12");
  sandbox.window.location.href = "https://shared.shop-ware.com/work_orders/13?shop_id=6192";
  ctx = sandbox.detectContext();
  assert.equal(ctx.swShopId, "6192");
  assert.equal(ctx.roId, "13");
  sandbox.window.location.href = "https://shared.shop-ware.com/work_orders/14";
  ctx = sandbox.detectContext();
  assert.equal(ctx.swShopId, null, "never retain last location hint");
  assert.equal(ctx.roId, "14");

  // Execute the actual cache entry point to ensure same-tenant location reads
  // never consume the tenant-only SWR cache.
  const background = fs.readFileSync("mos-tools-extension/background.js", "utf8");
  let endpoint = "";
  Object.assign(sandbox, {
    URLSearchParams, STICKER_CONFIG_FETCH_DEADLINE_MS: 8000,
    handleMosApiRequest: async (url: string) => { endpoint = url; return {}; },
    _stickerConfigCacheImpl: { get() { throw new Error("unsafe tenant-only cache"); } },
  });
  vm.runInContext(background.slice(background.indexOf("function getStickerConfigCached("), background.indexOf("function invalidateStickerConfigCache(")), sandbox);
  await sandbox.getStickerConfigCached("shared", "shopware", { context: { swShopId: 6194, roId: 12 } });
  assert.match(endpoint, /swShopId=6194/);
  assert.match(endpoint, /swRoId=12/);
  await sandbox.getStickerConfigCached("shared", "shopware", { context: { swShopId: 6192, roId: 13 } });
  assert.match(endpoint, /swShopId=6192/);
  assert.match(endpoint, /swRoId=13/);
  await checkCustomizedPrintFlow();
  console.log("✓ Shop-Ware tenant/location ownership, access, RO evidence, active context and cache isolation");
}

async function checkCustomizedPrintFlow() {
  const background = fs.readFileSync("mos-tools-extension/background.js", "utf8");
  const panelSource = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8");
  const originalDb = __deps.getDb;
  const originalVerify = __deps.verifyShopwareLocation;
  const fake = makeFakeDb({ shops });
  __deps.getDb = async () => fake.db as any;
  __deps.verifyShopwareLocation = async (_tenant, { repairOrderId, locationId }) =>
    repairOrderId === 12 ? 6194 : repairOrderId === 13 ? 6192 : locationId!;
  const requests: any[] = [];
  const printed: string[] = [];
  const worker: any = {
    console, URL, AbortController, setTimeout, clearTimeout,
    _stateReady: Promise.resolve(), mosApiUrl: "https://mos.test",
    mosApiToken: "fixture-token", mosAuthSource: "explicit",
    MOS_FETCH_TIMEOUT_MS: 1000, currentSmsContext: null,
    ensureBootstrapBoundToActiveTab: async () => {},
    fetch: async (url: string, options: any) => {
      // Only the real wire body/query counts. Worker context metadata must not
      // mask missing identifiers in the serialized customized Print request.
      assert.equal(options.context, undefined);
      const query = new URL(url).searchParams;
      const body = options.method === "POST" ? JSON.parse(options.body) : null;
      const input = body || Object.fromEntries(query);
      requests.push({ method: body ? "POST" : "GET", swShopId: input.swShopId, swRoId: input.swRoId });
      const result = await findShopBySmsIdDetailed(input.smsShopId || input.shopId, {
        providerHint: input.provider, providerHintIsAuthoritative: true,
        userShopIds: [136, 174],
        shopwareLocationId: input.swShopId, shopwareRepairOrderId: input.swRoId,
      });
      assert.equal(result.status, "resolved", "wire request must disambiguate shared tenant");
      if (result.status !== "resolved") throw new Error("unresolved");
      return Response.json(body
        ? { success: true, sticker: { dataUrl: result.shopDoc.stickerConfig.logo } }
        : { enabled: true, config: result.shopDoc.stickerConfig });
    },
  };
  vm.createContext(worker);
  vm.runInContext(background.slice(background.indexOf("async function _doMosFetch("),
    background.indexOf("async function _handleMosApiRequestTimed(")), worker);
  // Authentication retry/telemetry are unrelated; use the actual request
  // wrapper and fetch transport, which strips non-wire context metadata.
  worker._handleMosApiRequestTimed = async (endpoint: string, options: any) =>
    (await worker._doMosFetch(endpoint, options, worker.mosApiToken)).json();
  const messageBranch = background.slice(background.indexOf('if (message.action === "MOS_API_REQUEST")'),
    background.indexOf("// -------------------- Sticker config cache"));
  vm.runInContext(`function onMessage(message, sender, sendResponse) { ${messageBranch} }`, worker);
  const element = (value = "") => ({ value, disabled: false, textContent: "", classList: { add() {}, remove() {} } });
  const panel: any = {
    console, currentContext: null, stickerConfig: null, stickerConfigRequest: 0,
    stickerConfigContextKey: null, stickerEnabled: null,
    elements: Object.fromEntries(["stickerError", "stickerSection", "stickerLoading", "stickerPrintBtn",
      "stickerMileage", "stickerInterval", "stickerUnit"].map(key => [key, element()])),
    sendMessage: (message: any) => new Promise(resolve => worker.onMessage(message, {}, resolve)),
    loadKeytagSection() {}, updatePrintDisabledMessage() {}, populateStickerIntervalOptions() {}, showNotification() {},
    printStickerImage: (sticker: any) => printed.push(sticker.dataUrl),
  };
  vm.createContext(panel);
  const keyStart = panelSource.indexOf("const stickerContextKey =");
  vm.runInContext(panelSource.slice(keyStart, panelSource.indexOf(";", keyStart) + 1), panel);
  vm.runInContext(panelSource.slice(panelSource.indexOf("async function loadStickerConfig()"),
    panelSource.indexOf("// Status enum drives")), panel);
  vm.runInContext(panelSource.slice(panelSource.indexOf("async function handleStickerPrint()"),
    panelSource.indexOf("function printStickerImage(")), panel);
  try {
    for (const [swShopId, roId, logo] of [["6194", "12", "state"], ["6192", "13", "hoover"], ["6194", "12", "state"]]) {
      panel.currentContext = { provider: "shopware", shopId: "shared", swShopId, roId, mileage: 10000 };
      await panel.loadStickerConfig();
      assert.equal(panel.stickerConfig?.logo, logo);
      panel.elements.stickerInterval.value = "synthetic";
      await panel.handleStickerPrint();
      assert.equal(printed.at(-1), logo);
      assert.deepEqual(requests.slice(-2), [
        { method: "GET", swShopId, swRoId: roId },
        { method: "POST", swShopId, swRoId: roId },
      ]);
    }
    assert.deepEqual(printed, ["state", "hoover", "state"]);
  } finally {
    __deps.getDb = originalDb;
    __deps.verifyShopwareLocation = originalVerify;
  }
  console.log("✓ actual Shop-Ware side-panel settings → customized POST → worker wire transport preserves A/B/A branding");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
