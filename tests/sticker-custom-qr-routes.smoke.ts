import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import QRCode from "qrcode";
import { writeFileSync } from "node:fs";

// In-memory stores only; deny-network-egress is required when invoking this test.
const Module = require("node:module");
process.env.NEXT_PUBLIC_BASE_URL = "https://offline.example.test";
const load = Module._load;
let session: any = { shopId: 42, role: "manager", email: "offline@example.test" };
const shop: any = { shopId: 42, stickerConfig: {} };
const media = new Map<string, any>();
let providerCalls = 0;
const writes: any[] = [];
const db: any = { collection(name: string) { return {
  findOne: async (q: any) => name === "shops" ? shop : name === "shop_media" ? media.get(q._id) || null : null,
  updateOne: async (q: any, u: any) => {
    writes.push({ name, q, u });
    if (name === "shop_media") media.set(q._id, { ...q, ...u.$set });
    if (name === "shops") for (const [key, value] of Object.entries(u.$set || {})) {
      if (key.startsWith("stickerConfig.")) shop.stickerConfig[key.slice(14)] = value;
    }
    return { matchedCount: 1, modifiedCount: 1 };
  },
  deleteOne: async (q: any) => { media.delete(q._id); },
  insertOne: async () => { assert.notEqual(name, "sticker_vehicle_references", "custom source must never create target references"); },
}; } };
Module._load = function(request: string, parent: any, ...args: any[]) {
  if (request === "@/lib/auth") return { getSession: async () => session };
  if (request === "@/lib/mongo") return { getDb: async () => db };
  if (request === "@/lib/auto-booking/scheduler") return {};
  if (request === "@/lib/hovercode") return { verifyHovercode: async () => {}, updateHovercodeDestination: async () => { providerCalls++; throw Error("unexpected provider"); } };
  if (request === "@google-cloud/storage") return { Storage: class {} };
  return load.call(this, request, parent, ...args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { providerCalls++; throw new Error("unexpected provider"); };
const req = (path: string, method = "GET", body?: any) => new NextRequest(`https://offline.example.test${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function main() {
  const upload = require("../app/api/sticker/custom-qr/route");
  const settings = require("../app/api/sticker/settings/route");
  const generate = require("../app/api/sticker/generate/route");
  const cache = require("../app/api/sticker/qr-cache/route");
  const direct = require("../app/api/sticker/qr/route");
  const png = await QRCode.toBuffer("https://offline.example.test/custom", { width: 300, margin: 4 });
  const body = { contentType: "image/png", base64Data: png.toString("base64") };
  session = null;
  assert.equal((await upload.POST(req("/", "POST", body))).status, 401);
  session = { shopId: 42, role: "technician" };
  assert.equal((await upload.POST(req("/", "POST", body))).status, 403);
  assert.equal((await upload.DELETE(req("/", "DELETE"))).status, 403);
  session.role = "manager";
  assert.equal((await upload.POST(req("/", "POST", { ...body, base64Data: "not image" }))).status, 400);
  assert.equal((await upload.POST(req("/", "POST", body))).status, 200);
  const identity = { hovercodeQRId: "unchanged", qrTargetUrl: "unchanged", cachedQrCodeDataUri: `data:image/png;base64,${png.toString("base64")}` };
  Object.assign(shop.stickerConfig, identity);
  assert.equal((await settings.PUT(req("/", "PUT", { qrSource: "custom", qrBackgroundMode: "match" }))).status, 200);
  assert.equal((await settings.PUT(req("/", "PUT", { qrSource: "url" }))).status, 400);
  for (const [k, v] of Object.entries(identity)) assert.equal(shop.stickerConfig[k], v);
  assert.equal((await (await settings.GET(req("/"))).json()).customQrAvailable, true);
  session.shopId = 43;
  assert.equal((await upload.GET(req("/"))).status, 404);
  session.shopId = 42;
  for (const handler of [cache.GET, direct.GET]) assert.equal((await handler(req("/?vin=1HGCM82633A004352"))).status, 200);
  assert.equal((await direct.POST(req("/", "POST", { vin: "1HGCM82633A004352" }))).status, 200);
  for (const format of ["png", "pdf"]) {
    const result = await generate.POST(req("/", "POST", { vin: "1HGCM82633A004352", format }));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("content-type"), `image/${format}` === "image/pdf" ? "application/pdf" : "image/png");
    if (format === "png") writeFileSync("/tmp/sticker-custom-preview.png", Buffer.from(await result.arrayBuffer()));
  }
  assert.equal((await upload.POST(req("/", "POST", body))).status, 200, "replace");
  assert.equal((await upload.DELETE(req("/", "DELETE"))).status, 200);
  assert.equal(shop.stickerConfig.qrSource, "custom");
  assert.equal((await cache.GET(req("/"))).status, 409);
  assert.equal((await generate.POST(req("/", "POST", {}))).status, 409);
  assert.equal((await generate.POST(req("/", "POST", { includeQR: false }))).status, 200);
  assert.equal(providerCalls, 0);
  // Restore a generated cache and verify no identity rewrite/provider calls.
  shop.stickerConfig.qrTargetUrl = "https://offline.example.test/api/sticker/redirect/42";
  assert.equal((await settings.PUT(req("/", "PUT", { qrSource: "generated" }))).status, 200);
  assert.equal((await generate.POST(req("/", "POST", {}))).status, 200);
  assert.equal(providerCalls, 0);
  assert.ok(!writes.some(w => Object.keys(w.u.$set || {}).some(k => k.includes("hovercodeQRId") || k.includes("qrTargetUrl"))));
  console.log("Custom QR route checks passed: authorization, tenant isolation, upload/replace/delete, settings, provider bypass, PNG/PDF, exclusion, missing media, restoration and cache preservation.");
}
main().finally(() => { Module._load = load; globalThis.fetch = originalFetch; }).catch(error => { console.error(error); process.exitCode = 1; });
