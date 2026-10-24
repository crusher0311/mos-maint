/** Isolated contracts, real route handlers, renderer loop and extension form.
 * No real stores/auth/providers may be imported by the route VM.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { DEFAULT_LAYOUT } from "../lib/keytag-designer-types";
import * as extras from "../lib/keytag-extra-fields";
import * as paper from "../lib/keytag-paper-sizes";
import * as mileage from "../lib/sticker-mileage";

function load(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const exports: any = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, Buffer, Uint8Array, console,
    require(name: string) { assert.ok(name in imports, `Disallowed import ${name}`); return imports[name]; },
    ...globals,
  });
  return exports;
}
const element = (type: string, id = type) => ({
  ...DEFAULT_LAYOUT.elements[0], id, type, label: type, showLabel: true,
});
const layout: any = { ...DEFAULT_LAYOUT, elements: [
  ...DEFAULT_LAYOUT.elements, element("vehicleColor"), element("licensePlate"),
  element("custom", "custom_stable"), { ...element("custom", "custom_hidden"), visible: false },
] };
const values = { vehicleColor: "Silver", licensePlate: "ABC 1234", custom_stable: "Bay 4",
  custom_hidden: "must not print", foreign: "wrong shop" };
const base = { customerName: "Customer", vehicleInfo: "2024 Test Car", roNumber: "101", mileage: 1000, extraValues: values };
let texts: string[] = [], dimensions: number[] = [];
const ctx = {
  scale() {}, fillRect() {}, fillText(text: string) { texts.push(text); },
  measureText(text: string) { return { width: text.length * 9 }; },
};
const renderer = load("lib/canvas-renderer.ts", {
  canvas: { createCanvas: (w: number, h: number) => {
    dimensions = [w, h];
    return { getContext: () => ctx, toBuffer: () => Buffer.from(JSON.stringify(texts)) };
  }, registerFont() {} },
  path: { default: { join: (...parts: string[]) => parts.join("/") } },
  "@/lib/sticker-designer-types": {}, "@/lib/sticker-text-painter": {},
  "@/lib/keytag-extra-fields": extras,
}, { process: { cwd: () => "/offline" } });
let shopId: number | null = 42;
const shops: Record<number, any> = { 42: { keytagConfig: { designerLayout: layout, showLogo: false } },
  43: { keytagConfig: { designerLayout: DEFAULT_LAYOUT } } };
const db = { collection(name: string) {
  assert.equal(name, "shops");
  return {
    findOne: async (q: any) => structuredClone(shops[q.shopId]),
    updateOne: async (q: any, update: any) => { shops[q.shopId].keytagConfig = structuredClone(update.$set.keytagConfig); },
  };
} };
const common = {
  "next/server": { NextResponse }, "@/lib/auth": { getSession: async () => shopId ? { shopId } : null },
  "@/lib/mongo": { getDb: async () => db }, "@/lib/keytag-extra-fields": extras,
  "@/lib/canvas-renderer": renderer, "@/lib/keytag-paper-sizes": paper,
};
let pdfSize: number[] = [];
const generate = load("app/api/keytag/generate/route.ts", {
  ...common, "@/lib/sticker-mileage": mileage,
  "@/lib/sticker-pdf": { pngBufferToSizedPdfBuffer: async (_png: Buffer, w: number, h: number) => {
    pdfSize = [w, h]; return Buffer.from("%PDF fixture");
  } },
});
const settings = load("app/api/keytag/settings/route.ts", common);
let denied = false;
const extension = load("app/api/extension/keytag/route.ts", {
  ...common,
  "@/lib/extension-route-wrapper": { withExtensionErrorMarker: (fn: unknown) => fn },
  "@/lib/extension-auth": {
    validateExtensionToken: async () => ({ authorized: !!shopId, user: { shopId } }),
    getAuthErrorStatus: () => 401, buildAuthErrorBody: () => ({ error: "Unauthorized" }),
  },
  "@/lib/extension-route-guard": { checkShopFeatureGate: async () =>
    denied ? NextResponse.json({ error: "Disabled" }, { status: 403 }) : null },
});
const queueRenderer = load("lib/print-queue/render.ts", {
  canvas: {}, "@/lib/canvas-renderer": renderer, "@/lib/keytag-paper-sizes": paper,
  "@/lib/print-queue/types": {}, "./types": {},
});
let queued: any;
const queue = load("app/api/extension/print/route.ts", {
  "next/server": { NextResponse },
  "@/lib/extension-route-wrapper": { withExtensionErrorMarker: (fn: unknown) => fn },
  "@/lib/sticker-activity": { validPrintAction: () => true },
  "@/lib/data/repositories/shops": { findShopByExactShopId: async (id: number) => structuredClone(shops[id]) },
  "@/lib/extension-route-guard": { guardExtensionShopRequest: async () => shopId && !denied ?
    { ok: true, mosShopId: shopId } : { ok: false, response: NextResponse.json({}, { status: 403 }) } },
  "@/lib/print-queue/repository": {
    enqueuePrintJob: async (job: any) => { queued = job; return "fixture-job"; },
    getPrinterConfig: async () => ({}), resolveJobOptions: () => ({}),
  },
  "@/lib/print-queue/render": { ...queueRenderer, toJpegBase64: async () => "fixture-jpeg" },
  "@/lib/print-queue/types": { PrintPayloadTooLargeError: class extends Error {} },
  "@/lib/print-queue/request-body": { readPrintJsonBody: (req: any) => req.json() },
  "@/lib/extension-basic-tools": { printRequestRequiresWrite: () => false },
});
const request = (body: any) => ({ json: async () => structuredClone(body) });
async function main() {
  assert.equal(extras.keytagExtraLayoutError(layout), null);
  assert.equal(extras.keytagExtraLayoutError(DEFAULT_LAYOUT), null);
  for (const invalid of [
    { ...layout, elements: [...layout.elements, element("vehicleColor", "duplicate")] },
    { ...layout, elements: [...layout.elements, element("custom", "custom_third"), element("custom", "custom_fourth")] },
    { ...layout, elements: [element("custom", "__proto__")] },
    { ...layout, elements: [{ ...element("custom", "custom_ok"), label: "x".repeat(33) }] },
    { ...layout, elements: [{ ...element("vehicleColor"), width: NaN }] },
  ]) assert.ok(extras.keytagExtraLayoutError(invalid));
  assert.deepEqual(extras.normalizeKeytagExtraValues(layout, { ...values, vehicleColor: " \nSilver\t ", licensePlate: 2 }),
    { vehicleColor: "Silver", custom_stable: "Bay 4" });
  assert.equal(extras.normalizeKeytagExtraValues(layout, { custom_stable: "x".repeat(100) }).custom_stable.length, 64);
  const renamed = structuredClone(layout);
  renamed.elements.find((el: any) => el.id === "custom_stable").label = "Parking";
  const config = { designerLayout: renamed, showLogo: true, customLegacySetting: "retain", colors: { text: "#111111" } };
  assert.equal((await settings.POST(request({ config }))).status, 200);
  const reloaded = (await (await settings.GET({})).json()).config;
  assert.equal(reloaded.customLegacySetting, "retain");
  assert.equal(reloaded.designerLayout.elements.find((el: any) => el.id === "custom_stable").label, "Parking");
  assert.equal(extras.normalizeKeytagExtraValues(reloaded.designerLayout, values).custom_stable, "Bay 4");
  assert.equal((await settings.POST(request({ config: { designerLayout: { elements: null } } }))).status, 400);
  for (const format of ["png", "pdf"]) {
    texts = [];
    const response = await generate.POST(request({ ...base, format }));
    assert.equal(response.status, 200);
    assert.ok(texts.includes("Silver") && texts.includes("ABC 1234") && texts.includes("Bay 4"));
    assert.ok(!texts.includes("must not print") && !texts.includes("wrong shop"));
    assert.deepEqual(dimensions, [2100, 676]);
    assert.equal(response.headers.get("X-Keytag-Width"), "3.500in");
    if (format === "pdf") assert.deepEqual(pdfSize, [3.5, 1.125]);
  }
  texts = [];
  assert.equal((await extension.POST(request(base))).status, 200);
  assert.ok(texts.includes("Bay 4"));
  texts = [];
  assert.equal((await queue.POST(request({ type: "keytag", keytag: base }))).status, 201);
  assert.ok(texts.includes("Bay 4"));
  assert.equal(queued.shopId, 42);
  for (const extraValues of [{}, null, { vehicleColor: "", licensePlate: " ", custom_stable: false }]) {
    texts = [];
    assert.equal((await generate.POST(request({ ...base, extraValues }))).status, 200);
    assert.ok(!texts.some(text => /Parking|vehicleColor|licensePlate|Bay 4/.test(text)), "no blank labels/placeholders");
  }
  // Preview layout wins over stored layout; static text stays static.
  texts = [];
  const preview = { ...DEFAULT_LAYOUT, elements: [element("text", "legacy-text")] };
  await generate.POST(request({ ...base, designerLayout: preview }));
  assert.ok(texts.includes("text"));
  assert.ok(!texts.includes("Silver"));
  // Route-specific required fields unchanged.
  assert.equal((await extension.POST(request({ ...base, roNumber: "" }))).status, 400);
  assert.equal((await queue.POST(request({ type: "keytag", keytag: { ...base, vehicleInfo: "" } }))).status, 400);
  shopId = 43;
  texts = [];
  await generate.POST(request(base));
  assert.ok(!texts.includes("Silver") && !texts.includes("Bay 4"));
  assert.equal((await (await settings.GET({})).json()).config.designerLayout.elements.length, DEFAULT_LAYOUT.elements.length);
  denied = true;
  assert.equal((await extension.POST(request(base))).status, 403);
  denied = false; shopId = null;
  assert.equal((await settings.POST(request({ config }))).status, 401);
  assert.equal((await generate.POST(request(base))).status, 401);

  const source = readFileSync("mos-tools-extension/sidepanel.js", "utf8");
  const dom = new JSDOM('<div id="keytag-extra-fields"></div>');
  let resolveFetch: (value: any) => void = () => {};
  const sandbox: any = { document: dom.window.document, currentContext: { shopId: 42, roId: "one", vin: "VIN", provider: "tekmetric", vehicleColor: "Silver" },
    sendMessage: async () => new Promise(resolve => { resolveFetch = resolve; }) };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf("// Values belong only"), source.indexOf("function makeRoKey")), sandbox);
  const first = vm.runInContext("loadKeytagExtras()", sandbox);
  resolveFetch({ config: { designerLayout: layout } }); await first;
  const input = dom.window.document.getElementById("keytag-extra-vehicleColor") as HTMLInputElement;
  assert.equal(input.value, "Silver");
  assert.equal(input.maxLength, 64);
  input.value = "Blue"; input.dispatchEvent(new dom.window.Event("input"));
  vm.runInContext("currentContext.vehicleColor = 'Red'; prefillKeytagExtras(); renderKeytagExtras()", sandbox);
  assert.equal((dom.window.document.getElementById(input.id) as HTMLInputElement).value, "Blue");
  const stale = vm.runInContext("loadKeytagExtras()", sandbox);
  vm.runInContext("currentContext = {shopId:43,roId:'two'}; resetKeytagExtras()", sandbox);
  resolveFetch({ config: { designerLayout: layout } }); await stale;
  assert.equal(dom.window.document.querySelectorAll("input").length, 0, "late response cannot populate another shop");
  const next = vm.runInContext("loadKeytagExtras()", sandbox);
  resolveFetch({ config: { designerLayout: layout } }); await next;
  assert.equal((dom.window.document.getElementById(input.id) as HTMLInputElement).value, "");
  dom.window.close();
  // Exercise the actual worker routing branch: explicit logins must resolve
  // the tab's location for BOTH settings and generation, not use the root shop.
  const workerSource = readFileSync("mos-tools-extension/background.js", "utf8");
  const workerStart = workerSource.indexOf("async function handleMosApiRequest(endpoint");
  const workerBranchEnd = workerSource.indexOf("  await ensureBootstrapBoundToActiveTab();", workerStart);
  assert.ok(workerStart >= 0 && workerBranchEnd > workerStart);
  let scopedCalls = 0;
  const worker: any = { _stateReady: Promise.resolve(), mosAuthSource: "explicit", URL,
    stickerLocationRequest: async (context: any) => {
      assert.equal(context.shopId, "200"); assert.equal(context._tabId, 12);
      scopedCalls++;
      return { request: async () => ({ config: { shop: "200" } }) };
    },
  };
  vm.createContext(worker);
  vm.runInContext(workerSource.slice(workerStart, workerBranchEnd) + '\nthrow new Error("Unexpected root credential path"); }', worker);
  for (const method of ["GET", "POST"]) {
    const opts = { context: { shopId: "200", provider: "tekmetric" }, sourceTabId: 12,
      ...(method === "POST" ? { method, body: JSON.stringify({ smsShopId: "200", provider: "tekmetric" }) } : {}) };
    worker.opts = opts;
    const result = await vm.runInContext("handleMosApiRequest('/api/extension/keytag?shopId=200&provider=tekmetric', opts)", worker);
    assert.equal(result.config.shop, "200");
  }
  assert.equal(scopedCalls, 2);
  console.log("Optional keytag contracts, routes, renderer and extension isolation passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
