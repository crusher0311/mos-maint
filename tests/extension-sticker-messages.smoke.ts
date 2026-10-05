import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createStickerLocationRequest } from "../mos-tools-extension/lib/sticker-location-session.js";
import { NextRequest } from "next/server";
import { switchLocation, __deps as locationDeps } from "../lib/extension-location-session";

const source = fs.readFileSync("mos-tools-extension/background.js", "utf8");
const panelSource = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8");
async function main() {
  const shops = new Map([[1, "100"], [2, "200"]]);
  const prints: string[] = [];
  let oldSession: "modern" | "legacy" | null = null;
  let issues = 0;
  locationDeps.issueExtensionSession = (async () => { issues++; throw new Error("same-shop must not issue"); }) as any;
  locationDeps.findShopBySmsIdDetailed = (async () => ({
    status: "resolved", mosShopId: 10, provider: "tekmetric",
  })) as any;
  let panelMessage: (message: any) => Promise<void> = async () => {};
  let panelLoading = Promise.resolve();
  let switchFailure: string | null = null;
  let afterPost: (() => void) | null = null;
  const forwarded: any[] = [];
  const worker = () => {
    let listener: any;
    let restore: () => void;
    const sandbox: any = {
      console, URL, AbortSignal, AbortController,
      setTimeout: (fn: () => void, ms: number) => ms === 500 ? (fn(), 0) : setTimeout(fn, ms),
      clearTimeout,
      createStickerLocationRequest,
      createStickerConfigCache: () => ({ get: () => { throw new Error("must not use global sticker cache"); } }),
      mosApiToken: null, mosApiUrl: null, mosAuthSource: null, authEpoch: 1,
      stickerTabRevisions: new Map(),
      _stateReady: new Promise<void>(resolve => { restore = resolve; }),
      fetch: async (url: string, options: any) => {
        if (url.endsWith("/switch-location")) {
          if (switchFailure) return Response.json({ error: switchFailure }, { status: 403 });
          assert.equal(options.headers.Authorization, "Bearer root");
          const { smsShopId } = JSON.parse(options.body);
          if (oldSession) {
            assert.equal(smsShopId, "100");
            return switchLocation(new NextRequest(url, options), {
              authorized: true, error: null, user: { shopId: 10 },
              accountUser: { _id: "advisor", shopId: 10, shopIds: [10], role: "user" },
              legacyTokenHasExpiry: true,
              principal: { sessionId: "old", userId: "advisor", assurance: "verified",
                capabilities: ["read", "shop_tool"], expiresAt: new Date("2099-01-01"),
                ...(oldSession === "legacy" ? { isLegacy: true } : { shopId: 10, provider: "tekmetric" as const }) },
            });
          }
          return Response.json({ token: `scope-${smsShopId}`, provider: "tekmetric", smsShopId });
        }
        const tokenShop = oldSession ? "100" : options.headers.Authorization.replace("Bearer scope-", "");
        if (oldSession) assert.equal(options.headers.Authorization, "Bearer root");
        if (options.method === "POST") {
          const body = JSON.parse(options.body);
          assert.equal(body.smsShopId, tokenShop);
          prints.push(tokenShop);
          afterPost?.();
          return Response.json({ success: true, sticker: { dataUrl: `logo-${tokenShop}` } });
        }
        assert.equal(new URL(url).searchParams.get("shopId"), tokenShop);
        return Response.json({ enabled: true, config: { defaultOilType: "synthetic", logo: `logo-${tokenShop}` } });
      },
      chrome: {
        runtime: {
          onMessage: { addListener: (fn: any) => { listener = fn; } },
          sendMessage: (message: any) => { panelLoading = panelMessage(message); return panelLoading; },
        },
        sidePanel: { open: async () => {} },
        tabs: {
          get: async (id: number) => ({ url: `https://shop.tekmetric.com/shop/${shops.get(id)}/repair-orders/88` }),
          sendMessage: (id: number, message: any, callback: any) => { forwarded.push({ id, message }); callback({ success: true }); },
        },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(source.slice(source.indexOf("// ------ STICKER PRINTING ------"), source.indexOf("// ------ LABOR RATE RULES ------")), sandbox);
    vm.runInContext(source.slice(source.indexOf("async function handleMosApiRequest("), source.indexOf("async function _handleMosApiRequestTimed(")), sandbox);
    vm.runInContext(source.slice(source.indexOf("chrome.runtime.onMessage.addListener("), source.indexOf("// ------ API SNIFFER HELPERS ------")), sandbox);
    return {
      send: (message: any, tab?: number) => new Promise<any>(resolve => listener(message, tab == null ? {} : { tab: { id: tab } }, resolve)),
      restore: () => {
        sandbox.mosApiToken = "root";
        sandbox.mosApiUrl = "https://mos.test";
        sandbox.mosAuthSource = "explicit";
        restore!();
      },
    };
  };
  let w = worker();
  const ctx = (tab: number) => ({ provider: "tekmetric", shopId: shops.get(tab), roId: "88", mileage: 10000, vehicle: { make: "Toyota" } });
  // Message arrives before storage restoration after worker startup.
  const pending = w.send({ action: "PRINT_STICKER_IMMEDIATE", context: ctx(1) }, 1);
  assert.equal(prints.length, 0);
  w.restore();
  assert.equal((await pending).sticker.dataUrl, "logo-100");
  for (const shop of ["200", "100"]) {
    shops.set(1, shop);
    const result = await w.send({ action: "PRINT_STICKER_IMMEDIATE", context: ctx(1), overrideInterval: { miles: 5000, months: 6 } }, 1);
    assert.equal(result.sticker.dataUrl, `logo-${shop}`);
  }
  const config = await w.send({ action: "GET_STICKER_CONFIG", shopId: "200", provider: "tekmetric" }, 2);
  assert.equal(config.config.logo, "logo-200");
  const both = await Promise.all([1, 2].map(tab => w.send({ action: "PRINT_STICKER_IMMEDIATE", context: ctx(tab) }, tab)));
  assert.deepEqual(both.map(x => x.sticker.dataUrl), ["logo-100", "logo-200"]);
  const denied = await w.send({ action: "PRINT_STICKER_IMMEDIATE", context: { ...ctx(1), shopId: "200" } }, 1);
  assert.equal(denied.success, false);
  assert.match(denied.error, /location changed/);
  w = worker();
  w.restore();
  assert.equal((await w.send({ action: "PRINT_STICKER_IMMEDIATE", context: ctx(2) }, 2)).sticker.dataUrl, "logo-200");
  console.log("✓ actual worker message handlers: restored login, A/B/A, custom interval, settings, two tabs and restart");

  // Replay the actual panel loader/print functions and SWITCH branch, not a
  // synthetic call that supplies _tabId itself (the original regression).
  const element = (value = "") => {
    const classes = new Set<string>();
    return { value, disabled: false, textContent: "", classList: {
      add: (s: string) => classes.add(s), remove: (s: string) => classes.delete(s),
      contains: (s: string) => classes.has(s),
    } };
  };
  const elements: any = Object.fromEntries([
    "stickerError", "stickerSection", "stickerLoading", "stickerPrintBtn",
    "stickerMileage", "stickerInterval", "stickerUnit",
  ].map(name => [name, element()]));
  elements.stickerMileage.value = "10000";
  elements.stickerInterval.value = "synthetic";
  elements.stickerUnit.value = "mi";
  const panel: any = {
    console, elements, currentContext: null, stickerConfig: null,
    stickerConfigContextKey: null, stickerConfigRequest: 0,
    stickerEnabled: null,
    stickerContextKey: (c: any) => `${c?._tabId}:${c?.provider}:${c?.shopId}`,
    sendMessage: (message: any) => w.send(message),
    loadKeytagSection() {}, updatePrintDisabledMessage() {}, populateStickerIntervalOptions() {},
    showNotification() {},
    chrome: { runtime: { sendMessage: (message: any, cb: any) => { w.send(message).then(cb); } } },
    printStickerViaWindow: () => { throw new Error("bound print must never use popup fallback"); },
    updateContext: (c: any) => { panel.currentContext = c; },
    switchTab: () => { panelLoading = panel.loadStickerConfig(); },
  };
  vm.createContext(panel);
  vm.runInContext(panelSource.slice(panelSource.indexOf("async function loadStickerConfig()"), panelSource.indexOf("// Status enum drives")), panel);
  vm.runInContext(panelSource.slice(panelSource.indexOf("async function handleStickerPrint()"), panelSource.indexOf("function printStickerViaWindow(")), panel);
  const switchBranch = panelSource.slice(panelSource.indexOf("if (message.action === 'SWITCH_TO_STICKER_TAB')"), panelSource.indexOf("if (message.action === 'SWITCH_TO_CREATE_RO')"));
  panelMessage = async message => {
    panel.message = message;
    vm.runInContext(switchBranch, panel);
    await panelLoading;
  };
  for (const shop of ["100", "200", "100"]) {
    shops.set(1, shop);
    await w.send({ action: "OPEN_STICKER_PANEL", context: ctx(1) }, 1);
    await panelLoading;
    assert.equal(panel.currentContext._tabId, 1);
    assert.equal(elements.stickerPrintBtn.disabled, false);
    await panel.handleStickerPrint();
    await Promise.resolve();
    assert.equal(forwarded.at(-1).id, 1);
    assert.equal(forwarded.at(-1).message.sticker.dataUrl, `logo-${shop}`);
  }
  for (const failure of [
    "Sign in to MOS once to enable Tekmetric location switching.",
    "This Tekmetric location has conflicting MOS mappings. Ask a platform admin to repair them.",
    "Tekmetric location access could not be checked. Please try again.",
  ]) {
    switchFailure = failure;
    await panel.loadStickerConfig();
    assert.equal(elements.stickerPrintBtn.disabled, true);
    assert.equal(elements.stickerError.classList.contains("hidden"), false);
    assert.equal(elements.stickerError.textContent, failure);
  }
  switchFailure = null;
  for (const kind of ["modern", "legacy"] as const) {
    oldSession = kind;
    w = worker();
    const immediate = w.send({ action: "PRINT_STICKER_IMMEDIATE", context: ctx(1) }, 1);
    w.restore();
    assert.equal((await immediate).sticker.dataUrl, "logo-100");
    await w.send({ action: "OPEN_STICKER_PANEL", context: ctx(1) }, 1);
    await panelLoading;
    assert.equal(elements.stickerPrintBtn.disabled, false);
    await panel.handleStickerPrint();
    await Promise.resolve();
    assert.equal(forwarded.at(-1).id, 1);
    assert.equal(forwarded.at(-1).message.sticker.dataUrl, "logo-100");
    assert.equal(issues, 0);
  }
  oldSession = null;
  await panel.loadStickerConfig();
  const forwardsBefore = forwarded.length;
  afterPost = () => { shops.set(1, "200"); };
  await panel.handleStickerPrint();
  assert.equal(forwarded.length, forwardsBefore);
  assert.match(elements.stickerError.textContent, /location changed/);
  assert.equal(elements.stickerError.classList.contains("hidden"), false);
  console.log("✓ Customize → OPEN → SWITCH → settings → POST → originating-tab print; visible recovery errors and navigation race");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
