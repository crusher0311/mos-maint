import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { __deps as guardDeps, guardExtensionShopRequest } from "../lib/extension-route-guard";
import { __deps as lookupDeps, findShopBySmsId } from "../lib/extension-shop-lookup";
import { makeFakeDb } from "./utils/fake-mongo";

async function main() {
  const shops = [
    { shopId: 136, shopware: { tenantId: 5700, swShopId: 6194, tenantSubdomain: "shared" }, stickerConfig: { logo: "state" } },
    { shopId: 174, shopware: { tenantId: 5700, swShopId: 6192, tenantSubdomain: "shared" }, stickerConfig: { logo: "hoover" } },
  ];
  let fake = makeFakeDb({ shops });
  lookupDeps.getDb = async () => fake.db as any;
  let unavailable = false;
  lookupDeps.verifyShopwareLocation = async (_tenant, context) => {
    if (unavailable) throw new Error("timeout");
    return context.repairOrderId ? (context.repairOrderId === 12 ? 6194 : 6192) : context.locationId!;
  };
  let principal: any = { isLegacy: true, assurance: "verified", capabilities: ["read"] };
  let access = [136, 174];
  let enabled = true;
  guardDeps.validateExtensionToken = async () => ({
    authorized: true, principal, user: { shopIds: access, extensionPrincipal: principal },
  } as any);
  guardDeps.getFeatureEntitlements = async () => ({ canUseFeature: () => enabled } as any);
  const routeModule: any = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("app/api/extension/vehicle-history/route.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: routeModule.exports, module: routeModule,
    require: (name: string) => {
      if (name === "next/server") return { NextRequest, NextResponse };
      if (name === "@/lib/extension-route-guard") return { guardExtensionShopRequest };
      if (name === "@/lib/vehicle-history/service") return {
        readEnterpriseVehicleHistory: async (scope: any, vin: string) => ({
          enabled: true, currentShopId: scope.currentShopId, vin, locations: [], events: [],
          logo: shops.find(shop => shop.shopId === scope.currentShopId)?.stickerConfig.logo,
        }),
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const route = async (endpoint: string) => {
    const request = new NextRequest(`https://fixture.invalid${endpoint}`);
    const response = await routeModule.exports.GET(request);
    const body = await response.json();
    return { status: response.status, ...body, shopId: body.currentShopId };
  };
  const base = "/api/extension/vehicle-history?shopId=shared&provider=shopware";
  assert.equal(await findShopBySmsId("shared", { providerHint: "shopware", providerHintIsAuthoritative: true, userShopIds: access }), null,
    "original wrapper collapses the shared tenant conflict to not-found");
  assert.equal((await route(base)).code, "SHOPWARE_LOCATION_REQUIRED");
  assert.equal((await route(`${base}&swShopId=junk`)).status, 400);
  assert.equal((await route(`${base}&roId=12`)).shopId, 136);
  assert.equal((await route(`${base}&swShopId=6194&roId=13`)).status, 404);
  access = [136];
  assert.equal((await route(`${base}&swShopId=6192`)).status, 403);
  access = [136, 174];
  unavailable = true;
  assert.equal((await route(`${base}&swShopId=6194`)).code, "SHOPWARE_VERIFICATION_UNAVAILABLE");
  unavailable = false;
  fake = makeFakeDb({ shops: [...shops, { ...shops[0], shopId: 999 }] });
  assert.equal((await route(`${base}&swShopId=6194`)).status, 409);
  fake = makeFakeDb({ shops });
  enabled = false;
  assert.equal((await route(`${base}&swShopId=6194`)).code, "feature_disabled");
  enabled = true;
  principal = { provider: "shopware", shopId: 136, assurance: "verified", capabilities: ["read"] };
  assert.equal((await route(`${base}&swShopId=6192`)).status, 403);
  principal = { provider: "tekmetric", shopId: 136, assurance: "verified", capabilities: ["read"] };
  assert.equal((await route(`${base}&swShopId=6194`)).code, "PROVIDER_FORBIDDEN");
  principal = { isLegacy: true, assurance: "basic", capabilities: [] };
  assert.equal((await route(`${base}&swShopId=6194`)).code, "CAPABILITY_REQUIRED");
  principal = { isLegacy: true, assurance: "verified", capabilities: ["read"] };
  fake = makeFakeDb({ shops: [{ shopId: 136, tekmetric: { shopId: 42 } }] });
  principal = { provider: "tekmetric", shopId: 136, assurance: "verified", capabilities: ["read"] };
  assert.equal((await route("/api/extension/vehicle-history?shopId=42&provider=tekmetric")).shopId, 136);
  fake = makeFakeDb({ shops });
  principal = { isLegacy: true, assurance: "verified", capabilities: ["read"] };

  // Execute actual panel serialization and worker transport, then the real guard
  // and detailed resolver. No live stores, provider requests, or mapping writes.
  const background = fs.readFileSync("mos-tools-extension/background.js", "utf8");
  const workerFunction = background.slice(background.indexOf("async function handleMosApiRequest("), background.indexOf("async function _handleMosApiRequestTimed("));
  let context: any = { provider: "shopware", shopId: "shared", swShopId: "6194", roId: "12", vin: "1HGCM82633A004352", _tabId: 7 };
  const contexts = new Map([[7, context]]);
  const revisions = new Map([[7, 0]]);
  const wire: string[] = [];
  let release: (() => void) | null = null;
  let pause = false;
  const worker: any = {
    URL, Date, console, _stateReady: Promise.resolve(), authEpoch: 1,
    mosApiToken: "fixture", stickerTabRevisions: revisions, smsContextsByTab: contexts,
    ensureBootstrapBoundToActiveTab: async () => {},
    _handleMosApiRequestTimed: async (endpoint: string) => {
      wire.push(endpoint);
      const result = await route(endpoint);
      if (pause) await new Promise<void>(resolve => { release = resolve; });
      return result;
    },
  };
  vm.createContext(worker);
  vm.runInContext(workerFunction, worker);
  const switchTo = (id: string, roId = "12") => {
    context = { ...context, swShopId: id, roId };
    contexts.set(7, context);
    revisions.set(7, revisions.get(7)! + 1);
  };
  assert.equal((await worker.handleMosApiRequest(base, { context })).logo, "state");
  switchTo("6192", "13");
  assert.equal((await worker.handleMosApiRequest(base, { context })).logo, "hoover");
  switchTo("6194");
  assert.equal((await worker.handleMosApiRequest(base, { context })).logo, "state");
  assert.equal(new URL(wire[0], "https://fixture.invalid").searchParams.get("swShopId"), "6194");
  assert.equal(new URL(wire[1], "https://fixture.invalid").searchParams.get("roId"), "13");
  await assert.rejects(worker.handleMosApiRequest(`${base}&swShopId=6192`, { context }), /mismatch/);
  pause = true;
  const pending = worker.handleMosApiRequest(base, { context });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  switchTo("6192"); // location-only transition, same RO
  (release as unknown as () => void)();
  await assert.rejects(pending, /location changed/);
  pause = false;

  const panelSource = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8");
  const historyFunction = panelSource.slice(panelSource.indexOf("async function fetchVehicleHistory()"), panelSource.indexOf("function syncVehicleHistoryRefresh()"));
  const keyFunction = panelSource.slice(panelSource.indexOf("function vehicleHistoryContextKey("), panelSource.indexOf("function vehicleHistoryEligible("));
  const panel: any = {
    URLSearchParams, currentContext: context, vehicleHistorySequence: 0,
    vehicleHistoryEligible: () => true, renderVehicleHistory: () => {}, clearVehicleHistory: () => {},
    sendMessage: async (message: any) => {
      const params = new URL(message.endpoint, "https://fixture.invalid").searchParams;
      assert.equal(params.get("swShopId"), context.swShopId);
      assert.equal(params.get("roId"), context.roId);
      return worker.handleMosApiRequest(message.endpoint, { context: JSON.parse(JSON.stringify(message.context)) });
    },
  };
  vm.createContext(panel);
  vm.runInContext(keyFunction + historyFunction, panel);
  const beforePanel = wire.length;
  await panel.fetchVehicleHistory();
  assert.equal(wire.length, beforePanel + 1, "panel assertions must reach actual network serialization");
  assert.notEqual(panel.vehicleHistoryContextKey(context), panel.vehicleHistoryContextKey({ ...context, swShopId: "6194" }));
  // Actual content-script feature message -> actual worker message handler.
  // Deliberately disabled controls must survive serialization, not fail open
  // because this second request entrypoint forgot the location hints.
  const handlerStart = background.indexOf('  if (message.action === "GET_SHOP_FEATURES")');
  const handlerEnd = background.indexOf('  // ------ UNDO SNAPSHOTS', handlerStart);
  Object.assign(worker, {
    AbortController, setTimeout, clearTimeout, activeTabId: 7, mosApiUrl: "https://fixture.invalid",
    mosAuthSource: "explicit", currentSmsContext: context,
    chrome: { storage: { local: { get: (_keys: any, callback: any) => callback({ mosUser: { role: "viewer" } }) } } },
  });
  vm.runInContext(`async function featureMessage(message) {
    return new Promise(resolve => {
      const sender = {tab:{id:7}};
      const sendResponse = resolve;
      ${background.slice(handlerStart, handlerEnd)}
    });
  }`, worker);
  worker._handleMosApiRequestTimed = async (endpoint: string) => {
    wire.push(endpoint);
    const resolution = await route(endpoint);
    assert.equal(resolution.status, 200);
    return { ...resolution, features: { oil_sticker: false }, floatingButtonEnabled: false,
      buttonVisibility: { shopware: { oil_sticker: false } } };
  };
  switchTo("6194", "12");
  let callback: any;
  let message: any;
  const removedButtons: string[] = [];
  const intervals: Array<() => void> = [];
  const navigationListeners: Record<string, () => void> = {};
  const contentSource = fs.readFileSync("mos-tools-extension/adapters/shopware-content.js", "utf8");
  const content: any = {
    Date, console: { log() {} }, detectContext: () => context, injectFAB: () => {},
    lastContext: null, contextCheckInterval: null,
    setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; },
    window: { location: { href: "https://shared.shop-ware.com/work_orders/12" },
      addEventListener: (name: string, fn: () => void) => { navigationListeners[name] = fn; } },
    document: { getElementById: (id: string) => ({ remove() { removedButtons.push(id); } }) },
    printButtonInjected: true, injectPrintButton: () => { throw new Error("disabled print button injected"); },
    chrome: { runtime: { lastError: null, sendMessage: (m: any, cb: any) => {
      if (m.action === "GET_SHOP_FEATURES") { message = JSON.parse(JSON.stringify(m)); callback = cb; }
      return Promise.resolve();
    } } },
  };
  vm.createContext(content);
  vm.runInContext(contentSource.slice(contentSource.indexOf("let cachedFloatingEnabled ="), contentSource.indexOf("function checkAndInjectButton()")), content);
  vm.runInContext(contentSource.slice(contentSource.indexOf("function updateContext()"), contentSource.indexOf("// ==================== HELPERS")), content);
  vm.runInContext(contentSource.slice(contentSource.indexOf("function checkAndInjectButton()"), contentSource.indexOf("// ==================== ADD SERVICE TO RO")), content);
  vm.runInContext(contentSource.slice(contentSource.indexOf("function init()"), contentSource.indexOf("function initSnifferRelay()")), content);
  vm.runInContext("init()", content);
  assert.equal(message.context.swShopId, "6194");
  callback(await worker.featureMessage(message));
  assert.equal(vm.runInContext("cachedFloatingEnabled", content), false);
  assert.equal(vm.runInContext("cachedSwButtonVis.oil_sticker", content), false);
  vm.runInContext("checkAndInjectButton()", content);
  assert.ok(removedButtons.includes("mos-fab-sw"), "disabled launcher removed");
  assert.ok(removedButtons.includes("mos-print-btn-sw"), "disabled print button removed");
  switchTo("6192", "13");
  content.window.location.href = "https://shared.shop-ware.com/work_orders/13";
  intervals[0](); // actual URL watcher, no direct refresh call
  assert.equal(message.context.swShopId, "6192");
  const oldCallback = callback;
  switchTo("6194", "12");
  navigationListeners.popstate();
  assert.equal(message.context.swShopId, "6194");
  oldCallback({ success: true, floatingButtonEnabled: true });
  assert.equal(vm.runInContext("cachedFloatingEnabled", content), false, "late sibling settings cannot apply");
  switchTo("6192", "12"); // selector-only navigation, unchanged URL and RO
  intervals[1]();
  assert.equal(message.context.swShopId, "6192");
  assert.ok(fake.ops.every(op => ["find", "findOne"].includes(op.op)), "resolution performs no writes");
  console.log("Shop-Ware general-tool serialization, isolation, authorization and failure outcomes passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
