import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { stickerPersonalization } from "../lib/sticker-personalization";
import { stickerViscosity } from "../lib/sticker-viscosity";

const read = (file: string) => fs.readFileSync(file, "utf8");
const panelSource = read("mos-tools-extension/sidepanel.js");
const core: any = (globalThis as any).MosStickerPersonalization;
const config = { tagline: "Saved shop wording", personalizeThankYou: true };
const context = { provider: "tekmetric", shopId: "10", roId: "99", _tabId: 1, customerName: "Alex & 李 O’Neil" };
for (const name of ["Alex & 李 O’Neil", "A", "Fleet <A&B>", "Very Long ".repeat(30)]) {
  assert.equal(stickerPersonalization.tagline(config, { ...context, customerName: name }), `Thank you, ${name.trim()}`);
}
for (const name of [null, {}, "", "  ", "Unknown", "Customer name", "bad\nname", "x".repeat(501)]) {
  assert.equal(stickerPersonalization.tagline(config, { ...context, customerName: name }), config.tagline);
}
assert.equal(stickerPersonalization.tagline({}, context), "");
assert.equal(stickerPersonalization.tagline({ tagline: "Legacy" }, context), "Legacy");
assert.equal(stickerPersonalization.tagline(config, {}, " Custom "), "Custom");
assert.equal(stickerPersonalization.tagline(config, context, " "), `Thank you, ${context.customerName}`);
assert.equal(core.tagline(config, { ...context, stickerCustomerName: null }), config.tagline);
assert.equal(stickerPersonalization.tagline(config, { customerName: "VIN-only stranger" }), config.tagline);

// Execute the real panel draft code, including its input listener.
let input: any;
const field = { value: "", addEventListener: (_: string, cb: any) => { input = cb; } };
const panel: any = { MosStickerPersonalization: core, MosStickerViscosity: stickerViscosity, elements: { stickerTagline: field },
  document: { getElementById: (id: string) => id === "sticker-tagline" ? field : null, createElement: () => ({}) },
  stickerContextKey: (c: any) => JSON.stringify([c?.provider, c?.shopId, c?.swShopId]),
};
vm.createContext(panel);
vm.runInContext(panelSource.slice(panelSource.indexOf("let stickerConfig = null;"),
  panelSource.indexOf("const stickerContextKey =")), panel);
vm.runInContext(`stickerConfig = ${JSON.stringify(config)}; stickerConfigContextKey = stickerContextKey(${JSON.stringify(context)});`, panel);
panel.syncStickerDraft(context);
assert.equal(field.value, `Thank you, ${context.customerName}`);
input({ target: { value: "One print only" } });
panel.syncStickerDraft({ ...context, customerName: "Refreshed Name" });
assert.equal(field.value, "One print only");
panel.syncStickerDraft({ ...context, roId: "100", customerName: "Next Customer" });
assert.equal(field.value, "Thank you, Next Customer");
panel.syncStickerDraft({ ...context, shopId: "20" });
assert.equal(field.value, "");
panel.syncStickerDraft(context);
assert.equal(field.value, `Thank you, ${context.customerName}`);
input({ target: { value: "" } });
panel.syncStickerDraft(context);
assert.equal(field.value, "");
assert.equal(core.tagline(config, context, field.value), `Thank you, ${context.customerName}`);
vm.runInContext("stickerDraftEdited = false; syncStickerDraft();", panel);
assert.equal(field.value, `Thank you, ${context.customerName}`);

// Actual preference controller: no network awaits in route, no stale A/B/A
// responses, no duplicate in-flight requests, independent provider/location keys.
const calls: any[] = [];
const notifications: any[] = [];
const prefSandbox: any = { console, Date, Object, JSON,
  chrome: { runtime: { sendMessage: (m: any, cb: any) => { calls.push({ m, cb }); } } },
};
vm.createContext(prefSandbox);
vm.runInContext(read("mos-tools-extension/sticker-button-preference.js"), prefSandbox);
const pref = prefSandbox.MosStickerButtonPreference;
for (const provider of ["tekmetric", "shopware", "autoflow"]) {
  const c = { ...context, provider };
  pref.refresh(c);
  const request = calls.at(-1);
  pref.refresh(c);
  assert.equal(calls.at(-1), request);
  request.cb({ config: { openPrintTabFirst: true } });
  const before = calls.length;
  assert.equal(pref.route(c, (...a: any[]) => notifications.push(a)), true);
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).m.action, "OPEN_STICKER_PANEL");
  calls.at(-1).cb({ success: true });
  assert.deepEqual(calls.at(-1).m.context, c);
  const off = { ...c, shopId: "off" };
  pref.refresh(off);
  calls.at(-1).cb({ config: {} });
  assert.equal(pref.route(off, () => {}), false);
  assert.equal(pref.isCurrent({ mosPrintContext: c }, off), false);
}
pref.refresh(context); const a1 = calls.at(-1);
pref.refresh({ ...context, shopId: "B" }); const b = calls.at(-1);
pref.refresh(context); const a2 = calls.at(-1);
a2.cb({ config: { openPrintTabFirst: true } });
a1.cb({ config: { openPrintTabFirst: false } });
b.cb({ config: { openPrintTabFirst: false } });
assert.equal(pref.route(context, () => {}), true);
assert.equal(calls.at(-1).m.action, "OPEN_STICKER_PANEL");
const unknown = { ...context, shopId: "unknown" };
assert.equal(pref.route(unknown, () => {}), true);
assert.equal(calls.at(-1).m.action, "GET_STICKER_CONFIG");
// Explicit interval and Customize paths remain independent of the preference.
for (const provider of ["tekmetric", "shopware", "autoflow"]) {
  const source = read(`mos-tools-extension/adapters/${provider}-content.js`);
  assert.equal((source.match(/MosStickerButtonPreference\?\.route\(/g) || []).length, 1);
  assert.match(source, /overrideInterval/);
  assert.match(source, /action: 'OPEN_STICKER_PANEL'/);
  // Execute each real orange-button handler, not just the shared decision.
  const handlers: Record<string, any> = {};
  const sends: any[] = [];
  const c = { ...context, provider, shopId: `button-${provider}` };
  const adapter: any = {
    console, Object, detectContext: () => c, getVehicleDetails: () => ({}),
    showToast() {}, reportActionDropped() {}, showIntervalDropdown() {},
    printStickerFromContentScript() {}, MosStickerButtonPreference: pref,
    safeSendMessage: (m: any) => sends.push(m),
    chrome: { runtime: { getURL: (s: string) => s, sendMessage: (m: any) => sends.push(m) } },
    document: { createElement: () => ({ style: {}, addEventListener: (event: string, cb: any) => { handlers[event] = cb; } }) },
  };
  vm.createContext(adapter);
  const functionName = provider === "tekmetric" ? "handleImmediatePrint" : "createPrintButton";
  const start = source.indexOf(`function ${functionName}(`);
  vm.runInContext(source.slice(start, source.indexOf("\n}", start) + 2), adapter);
  if (provider !== "tekmetric") adapter.createPrintButton();
  const click = () => provider === "tekmetric" ? adapter.handleImmediatePrint()
    : handlers.click({ preventDefault() {}, stopPropagation() {} });
  pref.refresh(c);
  calls.at(-1).cb({ config: { openPrintTabFirst: true } });
  click();
  assert.equal(sends.length, 0);
  assert.equal(calls.at(-1).m.action, "OPEN_STICKER_PANEL");
  // Move to another shop with default-off settings; normal click still prints once.
  c.shopId += "-off";
  pref.refresh(c);
  calls.at(-1).cb({ config: {} });
  click();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].action, "PRINT_STICKER_IMMEDIATE");
}

// Real panel navigation is deferred through initialization and deduplicated.
async function navigationTests() {
  const makePanel = (windowId: number, tabId: number) => {
    const switched: string[] = [], acknowledgments: any[] = [];
    const nav: any = {
      chrome: { windows: { getCurrent: async () => ({ id: windowId }) },
        tabs: { query: async (query: any) => {
          assert.equal(query.windowId, windowId);
          return [{ id: tabId }];
        } } },
      updateContext(c: any) { nav.context = c; }, switchTab(t: string) { switched.push(t); },
      sendMessage(m: any) { acknowledgments.push(m); return Promise.resolve({}); },
    };
    vm.createContext(nav);
    vm.runInContext(panelSource.slice(panelSource.indexOf("let stickerNavigationReady = false;"),
      panelSource.indexOf("async function init()")), nav);
    return { nav, switched, acknowledgments };
  };
  const first = makePanel(10, 1), second = makePanel(20, 2);
  const message = { navigationId: 1, windowId: 10, context };
  await Promise.all([first.nav.applyStickerNavigation(message), second.nav.applyStickerNavigation(message)]);
  assert.equal(first.switched.length, 0);
  assert.equal(second.switched.length, 0);
  for (const panel of [first, second]) vm.runInContext("stickerNavigationReady = true;", panel.nav);
  // Cold queued broadcast + startup read, including duplicate simultaneous delivery.
  await Promise.all([first.nav.applyStickerNavigation(message), first.nav.applyStickerNavigation(message),
    second.nav.applyStickerNavigation(message)]);
  assert.deepEqual(first.switched, ["sticker"]);
  assert.equal(first.acknowledgments.length, 1);
  assert.equal(first.acknowledgments[0].windowId, 10);
  assert.equal(second.switched.length, 0);
  assert.equal(second.acknowledgments.length, 0);
  assert.equal(second.nav.context, undefined);
  // Warm broadcast to the other window must not switch or acknowledge in first.
  const other = { navigationId: 2, windowId: 20, context: { ...context, _tabId: 2, customerName: "Other window" } };
  await Promise.all([first.nav.applyStickerNavigation(other), second.nav.applyStickerNavigation(other)]);
  assert.equal(first.nav.context.customerName, context.customerName);
  assert.equal(second.nav.context.customerName, "Other window");
  assert.equal(second.acknowledgments.length, 1);
  assert.equal(first.switched.length, 1);
  // Even in the right window, a no-longer-active tab cannot navigate this panel.
  await first.nav.applyStickerNavigation({ ...message, navigationId: 3, context: { ...context, _tabId: 99 } });
  assert.equal(first.switched.length, 1);
}

// Real settings route, with only its external dependencies replaced.
let session: any = { shopId: 10, role: "owner", email: "fixture@example.invalid" };
const shops = new Map<number, any>([[10, { shopId: 10, stickerConfig: { tagline: "Keep me" } }],
  [20, { shopId: 20, stickerConfig: { tagline: "Other shop" } }]]);
let writes = 0;
const db = { collection: (name: string) => ({
  findOne: async (q: any) => name === "shops" ? structuredClone(shops.get(q.shopId)) : null,
  updateOne: async (q: any, u: any) => {
    writes++;
    const shop = shops.get(q.shopId);
    if (!shop) return { matchedCount: 0 };
    for (const [key, value] of Object.entries(u.$set)) shop.stickerConfig[key.replace("stickerConfig.", "")] = value;
    return { matchedCount: 1 };
  },
}) };
const route: any = { exports: {}, console, Date,
  require: (name: string) => {
    if (name === "next/server") return { NextResponse: { json: (data: any, init?: any) => Response.json(data, init) } };
    if (name === "@/lib/auth") return { getSession: async () => session };
    if (name === "@/lib/mongo") return { getDb: async () => db };
    if (name === "@/lib/featureResolver") return { getFeatureEntitlements: async () => ({ canUseFeature: () => false }) };
    if (name === "@/lib/sticker-qr-appearance") return { validQrPreferences: () => true };
    if (name === "@/lib/sticker-designer-types") return { validStickerLayout: () => true };
    if (name === "@/lib/hovercode") return { updateHovercodeDestination: () => { throw Error("Unexpected upstream call"); } };
    throw Error(`Unexpected import ${name}`);
  },
};
vm.createContext(route);
vm.runInContext(ts.transpileModule(read("app/api/sticker/settings/route.ts"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, route);
async function main() {
  await navigationTests();
  let rendered = "";
  let renderedOil: unknown;
  const extensionShop: any = { stickerConfig: { ...config }, shopId: 10 };
  const extension: any = { exports: {}, console, Date, Buffer, process: { env: {} },
    fixtureShop: extensionShop,
    require: (name: string) => {
      const dependencies: any = {
        "next/server": { NextResponse: { json: (data: any, init?: any) => Response.json(data, init) } },
        "@/lib/extension-route-wrapper": { withExtensionErrorMarker: (fn: any) => fn },
        "@/lib/sticker-personalization": { stickerPersonalization },
        "@/lib/sticker-viscosity": { stickerViscosity },
        "@/lib/mongo": { getDb: async () => db },
        "@/lib/extension-auth": { validateExtensionToken: async () => ({ authorized: true, user: { shopId: 10 } }) },
        "@/lib/extension-route-guard": { checkShopFeatureGate: async () => null },
        "@/lib/canvas-renderer": {
          renderStickerStandard: async (data: any) => { rendered = data.tagline; return Buffer.from("fixture"); },
          renderStickerDesigner: async (_layout: any, data: any) => { rendered = data.tagline; renderedOil = data.oilViscosity; return Buffer.from("fixture"); },
        },
        "@google-cloud/storage": { Storage: class {} },
        "@/lib/with-upstream-timeout": { withUpstreamTimeout: (p: any) => p },
        "@/lib/sticker-mileage": { parseMileageInput: Number, parseMonthsInput: Number, isAbsurdMileage: () => false },
        "@/lib/extension-basic-tools": { shouldRunStickerSideEffects: () => false },
        "@/lib/sticker-print-dimensions": { getStickerSizeInches: () => ({ width: 2, height: 2 }) },
        "@/lib/sticker-activity": { validatePrintIntent: () => true, readStickerSupply: async () => null },
        "./unit-resolver": { resolveStickerUseKilometers: () => false },
        "@/lib/appfueled-qr-destination": { AppFueledQrUnavailable: class extends Error {} },
      };
      return dependencies[name] || {};
    },
  };
  vm.createContext(extension);
  vm.runInContext(ts.transpileModule(read("app/api/extension/sticker/route-handler.ts"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText +
    "\nresolveMosShopId = async () => ({mosShopId:10,shop:fixtureShop,resolvedProvider:null});", extension);
  for (const designer of [false, true]) {
    extensionShop.stickerConfig.designerLayout = designer ? { elements: [], canvasWidth: 591, canvasHeight: 591 } : undefined;
    for (const manual of [undefined, "", "One-off text"]) {
      const response = await extension.exports.POST({ json: async () => ({
        currentMileage: 10000, excludeQR: true, workOrderId: "99", customerName: context.customerName, tagline: manual,
      }) });
      assert.equal(response.status, 200);
      assert.equal(rendered, manual || `Thank you, ${context.customerName}`);
      assert.equal(extensionShop.stickerConfig.tagline, config.tagline);
    }
  }
  for (const oilViscosity of [null, 42, {}, "x".repeat(25), "5W-30\n"]) {
    assert.equal((await extension.exports.POST({ json: async () => ({ oilViscosity }) })).status, 400);
  }
  for (const [oilViscosity, expected] of [["sae 5w30", "5W-30"], ["", ""], ["SAE 30", "SAE 30"]]) {
    assert.equal((await extension.exports.POST({ json: async () => ({
      currentMileage: 10000, excludeQR: true, oilViscosity,
    }) })).status, 200);
    assert.equal(renderedOil, expected);
    assert.equal(extensionShop.stickerConfig.oilViscosity, undefined);
  }
  const put = (body: any) => route.exports.PUT({ json: async () => body });
  const get = async () => (await route.exports.GET({})).json();
  assert.equal((await get()).config.personalizeThankYou, false);
  assert.equal((await get()).config.openPrintTabFirst, false);
  assert.equal((await put({ personalizeThankYou: true })).status, 200);
  assert.equal((await get()).config.openPrintTabFirst, false);
  assert.equal((await put({ openPrintTabFirst: true })).status, 200);
  assert.equal((await get()).config.personalizeThankYou, true);
  assert.equal((await get()).config.tagline, "Keep me");
  session.shopId = 20;
  assert.equal((await get()).config.personalizeThankYou, false);
  session.shopId = 10;
  for (const bad of ["true", null, 1, {}]) assert.equal((await put({ openPrintTabFirst: bad })).status, 400);
  assert.equal(writes, 2);
  session.role = "user";
  assert.equal((await put({ personalizeThankYou: false })).status, 403);
  session = null;
  assert.equal((await put({ personalizeThankYou: false })).status, 401);
  console.log("Sticker personalization: settings, precedence, drafts, context isolation, provider button routing and cold/warm navigation passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
