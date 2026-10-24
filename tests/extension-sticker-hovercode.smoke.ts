import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { createCanvas, loadImage } from "canvas";
import QRCode from "qrcode";
import { getExtensionStickerQr } from "../lib/extension-sticker-qr";
import { renderStickerStandard, renderStickerDesigner } from "../lib/canvas-renderer";
import { writeFileSync } from "node:fs";

// Entire handler + real canvas rendering; all stores and HTTP are fixtures.
process.env.NEXT_PUBLIC_BASE_URL = "https://stickers.example.test";
process.env.HOVERCODE_API_TOKEN = "offline-fixture";
process.env.HOVERCODE_WORKSPACE_ID = "offline-fixture";
const Module = require("node:module");
const originalLoad = Module._load;
const shop: any = { shopId: 42, name: "Fixture Garage", stickerConfig: {} };
const refs: any[] = [], writes: any[] = [], media: any[] = [], calls: any[] = [], rendered: any[] = [];
const generic = "https://stickers.example.test/api/sticker/redirect/42";
let mode = "ok";
let existingTarget = generic;
let png: Buffer;
let timeoutMs = 300;
let stalledSignal: AbortSignal | undefined;
const logs: string[] = [];
const info = console.info;
console.info = (...args: any[]) => { logs.push(JSON.stringify(args)); };
const db: any = { collection(name: string) { return {
  findOne: async (q: any) => name === "shops" ? shop :
    name === "shop_media" ? media.find(row => Object.entries(q).every(([k, v]) => row[k] === v)) || null : null,
  insertOne: async (row: any) => { assert.equal(name, "sticker_vehicle_references"); refs.push(row); },
  updateOne: async (query: any, update: any) => { writes.push({ query, update }); return { modifiedCount: 1 }; },
}; } };
const fakeFetch: typeof fetch = async (url: any, init?: any) => {
  calls.push({ url: String(url), init });
  if (mode === "timeout" || mode === "late") {
    stalledSignal = init.signal;
    if (mode === "late") {
      await new Promise(resolve => setTimeout(resolve, 70));
      return Response.json({ id: "late", png: "https://images.example.test/qr.png" });
    }
    return new Promise(() => {});
  }
  if (mode === "throw") throw new Error(`must-not-log-${url}`);
  if (String(url).endsWith("/create/")) {
    if (mode === "http") return new Response("secret provider body", { status: 503 });
    const payload = JSON.parse(init.body);
    return Response.json({
      id: "new-code", qr_data: mode === "wrong-response" ? "https://wrong.test" : payload.qr_data,
      ...(mode === "svg" ? { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="black"/></svg>' } : { png: "https://images.example.test/qr.png" }),
    });
  }
  if (String(url).startsWith("https://images.")) {
    if (mode === "body-timeout") return { ok: true, arrayBuffer: () => new Promise(() => {}) } as any;
    return new Response(new Uint8Array(mode === "bad-image" ? Buffer.from("not an image") : png));
  }
  return Response.json({ qr_data: existingTarget, png: "https://images.example.test/qr.png" });
};
const originalFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
Module._load = function(request: string, parent: any, ...rest: any[]) {
  if (request === "@/lib/mongo") return { getDb: async () => db };
  if (request === "@/lib/extension-auth") return {
    validateExtensionToken: async () => ({ authorized: true, user: { shopId: 42 }, principal: {} }),
    requireExtensionPrincipalScope: () => null,
  };
  if (request === "@/lib/extension-route-wrapper") return { withExtensionErrorMarker: (fn: any) => fn };
  if (request === "@/lib/extension-route-guard") return { checkShopFeatureGate: async () => null };
  if (request === "@/lib/extension-basic-tools") return { shouldRunStickerSideEffects: () => false };
  if (request === "@/lib/auto-booking/scheduler" || request === "@/lib/integrations/carfax" ||
      request === "@/lib/extension-shop-lookup") return {};
  if (request === "@/lib/extension-sticker-qr") return {
    getExtensionStickerQr: (...args: any[]) => getExtensionStickerQr(args[0], args[1], args[2], args[3], args[4], { ...args[5], timeoutMs }),
  };
  if (request === "@/lib/canvas-renderer") return {
    renderStickerStandard: async (...args: any[]) => {
      rendered.push(args[1].qrDataUrl);
      return (renderStickerStandard as any)(...args);
    },
    renderStickerDesigner: async (...args: any[]) => {
      rendered.push(args[1].qrDataUrl);
      return (renderStickerDesigner as any)(...args);
    },
  };
  if (request === "@google-cloud/storage") return { Storage: class {} };
  return originalLoad.call(this, request, parent, ...rest);
};

async function main() {
  // Synthetic shortlink QR with calendar-style center for a safe visual fixture.
  const canvas = createCanvas(300, 300), ctx = canvas.getContext("2d");
  ctx.drawImage(await loadImage(await QRCode.toDataURL("https://example.test/fixture", { width: 300, errorCorrectionLevel: "H" })), 0, 0);
  ctx.fillStyle = "white"; ctx.fillRect(120, 120, 60, 60);
  ctx.fillStyle = "#111"; ctx.fillRect(130, 130, 40, 8); ctx.strokeRect(130, 130, 40, 40);
  png = canvas.toBuffer("image/png");
  const expected = canvas.toDataURL();
  const route = require("../app/api/extension/sticker/route-handler");
  const print = async (body: any = {}) => {
    const response = await route.POST(new NextRequest("https://stickers.example.test/api/extension/sticker", {
      method: "POST", body: JSON.stringify({ currentMileage: 10000, ...body }),
    }));
    assert.equal(response.status, 200);
    return response.json();
  };
  const targets: string[] = [];
  for (const vin of ["1HGCM82633A004352", "1HGCM82633A004353"]) {
    const result = await print({ vin });
    assert.equal(rendered.at(-1), expected, "selected HoverCode reaches actual standard renderer");
    const payload = JSON.parse(calls.at(-2).init.body);
    targets.push(payload.qr_data);
    assert.equal(payload.logo_url, "https://stickers.example.test/appointment-logo.png");
    assert.equal(payload.pattern, "Squares"); assert.equal(payload.eye_style, "Rounded");
    assert.equal(payload.dynamic, true);
    assert.equal(new URL(payload.qr_data).pathname, "/api/sticker/redirect/42");
    assert.equal(new URL(payload.qr_data).searchParams.get("v"), refs.at(-1)._id);
    assert.equal(refs.at(-1).vin, vin);
    assert.equal(refs.at(-1).shopId, 42);
    writeFileSync("/tmp/extension-sticker-hovercode-preview.html", `<html><body style="font:16px sans-serif;padding:24px"><h1>Offline extension sticker fixture</h1><p>Synthetic HoverCode response; real extension handler and sticker renderer.</p><img width="295" src="${result.sticker.dataUrl}"></body></html>`);
  }
  assert.notEqual(targets[0], targets[1]);
  assert.equal(writes.length, 0, "vehicle results never enter generic cache");
  shop.stickerConfig = { designerLayout: { canvasWidth: 591, canvasHeight: 739, backgroundColor: "#fff", elements: [
    { id: "qr", type: "qrCode", x: 20, y: 20, width: 200, height: 200, visible: true },
  ] } };
  const designerResult = await print({ vin: "1HGCM82633A004352" });
  assert.equal(rendered.at(-1), expected, "selected HoverCode reaches actual designer renderer");
  const designerImage = await loadImage(designerResult.sticker.dataUrl);
  const designerCanvas = createCanvas(designerImage.width, designerImage.height);
  const designerContext = designerCanvas.getContext("2d");
  designerContext.drawImage(designerImage, 0, 0);
  assert.ok(designerContext.getImageData(40, 40, 400, 400).data.some((v, i) => i % 4 !== 3 && v < 50),
    "designer output actually contains the selected QR, not a blank image");
  shop.stickerConfig = { hovercodeQRId: "generic-code", qrTargetUrl: generic, cachedQrCodeDataUri: expected };
  for (const vin of [undefined, "", "INCOMPLETE", "   ", 123]) {
    const before = calls.length;
    await print({ vin });
    assert.equal(rendered.at(-1), expected);
    assert.equal(calls.length, before, "resolved generic target reuses config cache");
  }
  delete shop.stickerConfig.cachedQrCodeDataUri;
  media.push({ shopId: 43, type: "qr_code", hovercodeId: "generic-code", targetUrl: generic, dataUri: expected });
  media.push({ shopId: 42, type: "qr_code", hovercodeId: "generic-code", targetUrl: targets[0], dataUri: expected });
  existingTarget = targets[1];
  await print();
  assert.ok(calls.at(-2).url.endsWith("/create/"), "cross-shop/vehicle cache and wrong existing target rejected");
  const publication = writes.at(-1).update.$set;
  assert.equal(publication["stickerConfig.qrTargetUrl"], generic);
  assert.equal(publication["stickerConfig.hovercodeQRId"], "new-code");
  assert.equal(publication["stickerConfig.cachedQrCodeDataUri"], expected);
  media.push({ shopId: 42, type: "qr_code", hovercodeId: "generic-code", targetUrl: generic, dataUri: expected });
  let before = calls.length;
  await print({ vin: "BAD" });
  assert.equal(calls.length, before, "matching generic media reused");
  media.length = 0;
  existingTarget = generic;
  await print();
  assert.ok(calls.at(-2).url.endsWith("/generic-code/"), "existing matching HoverCode reused");
  shop.stickerConfig = { hovercodeQRId: "old-booking" };
  existingTarget = "https://booking.example.test";
  await print();
  assert.equal(writes.at(-1).update.$addToSet["stickerConfig.legacyHovercodeQRIds"], "old-booking");
  assert.ok(calls.every(call => !call.url.endsWith("/update/")), "no printed codes retargeted");
  const writesBeforeFailures = writes.length;
  shop.stickerConfig = {};
  for (mode of ["http", "throw", "bad-image", "wrong-response", "timeout", "body-timeout", "late"]) {
    timeoutMs = 20;
    const start = Date.now();
    await print();
    assert.ok(Date.now() - start < 1500, "provider/body deadline bounds request");
    assert.ok(rendered.at(-1)?.startsWith("data:image/png;base64,"));
    assert.notEqual(rendered.at(-1), expected, "unavailability uses local QR");
    if (mode === "timeout") assert.equal(stalledSignal?.aborted, true);
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(writes.length, writesBeforeFailures, "late/failed provider cannot publish");
  mode = "svg"; timeoutMs = 300;
  await print();
  assert.ok(logs.at(-1)?.includes("hovercode:created"), "SVG-only provider response supported");
  mode = "ok";
  before = calls.length;
  const refCount = refs.length;
  await print({ vin: "1HGCM82633A004352", excludeQR: true });
  assert.equal(rendered.at(-1), null);
  assert.equal(calls.length, before);
  assert.equal(refs.length, refCount);
  // Custom mode must bypass both provider and target creation, and never fall
  // back to a generated code after removal.
  shop.stickerConfig = { qrSource: "custom", qrBackgroundMode: "match", colors: { background: "#eeeeee" } };
  media.push({ _id: "sticker-custom-qr:42", shopId: 42, type: "sticker_custom_qr", dataUri: expected });
  await print({ vin: "1HGCM82633A004352" });
  assert.equal(calls.length, before);
  assert.equal(refs.length, refCount);
  media.splice(media.findIndex(row => row.type === "sticker_custom_qr"), 1);
  const missing = await route.POST(new NextRequest("https://stickers.example.test/api/extension/sticker", {
    method: "POST", body: JSON.stringify({ currentMileage: 10000 }),
  }));
  assert.equal(missing.status, 409);
  assert.match((await missing.json()).error, /Custom QR image is unavailable/);
  await print({ excludeQR: true });
  assert.equal(rendered.at(-1), null);
  assert.equal(calls.length, before);
  assert.ok(logs.some(log => log.includes("provider_http_503")));
  assert.ok(logs.some(log => log.includes("timeout")));
  assert.ok(logs.every(log => !log.includes("?v=") && !log.includes("secret provider") && !log.includes("must-not-log")));
  console.log("Extension HoverCode handler fixtures passed (no live services)");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  Module._load = originalLoad; globalThis.fetch = originalFetch; console.info = info;
});
