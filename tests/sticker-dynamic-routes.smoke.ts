import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";

// Load actual route handlers with strictly in-memory dependencies.
const Module = require("node:module");
const originalLoad = Module._load;
process.env.NEXT_PUBLIC_BASE_URL = "https://stickers.example.test";
process.env.REPORT_SHARE_SECRET = "offline-route-test-only";
process.env.HOVERCODE_API_TOKEN = "offline";
process.env.HOVERCODE_WORKSPACE_ID = "offline";
process.env.DEV_AUTO_LOGIN = "false";
const vin = "1HGCM82633A004352";
const shop: any = { shopId: 42, name: "Fixture", websiteUrl: "https://site.example.test", stickerConfig: {
  appointmentUrl: "https://booking.example.test",
  scanDestination: "vhi",
  hovercodeQRId: "old-direct-code",
  cachedQrCodeDataUri: "data:image/png;base64,b2xk",
} };
let signedIn = true;
let entitled = true;
const references: any[] = [], scans: any[] = [], createdTargets: string[] = [], shopWrites: any[] = [];
const media: any[] = [];
const hoverTargets = new Map([["old-direct-code", "https://booking.example.test"]]);
const destinationUpdates: string[] = [];
const get = (obj: any, key: string): any => key.split(".").reduce((v, k) => v?.[k], obj);
const matches = (row: any, query: any) => Object.entries(query).every(([key, val]: any) =>
  key === "$or" ? val.some((q: any) => matches(row, q)) :
  val?.$in ? val.$in.includes(get(row, key)) : get(row, key) === val);
const db: any = { collection(name: string) {
  const rows = name === "shops" ? [shop] : name === "sticker_vehicle_references" ? references : name === "sticker_qr_scans" ? scans : name === "shop_media" ? media : [];
  return {
    findOne: async (q: any) => rows.find((row: any) => matches(row, q)) || null,
    insertOne: async (row: any) => { rows.push(row); return { insertedId: row._id }; },
    updateOne: async (q: any, update: any) => {
      if (name === "shops") shopWrites.push(update);
      const row = rows.find((r: any) => matches(r, q));
      if (row) for (const [key, val] of Object.entries(update.$addToSet || {})) {
        const parts = key.split("."); const last = parts.pop()!;
        const parent = parts.reduce((v, k) => v[k] ||= {}, row);
        parent[last] ||= [];
        if (!parent[last].includes(val)) parent[last].push(val);
      }
      if (row) for (const [key, val] of Object.entries(update.$set || {})) {
        const parts = key.split("."); const last = parts.pop()!;
        const parent = parts.reduce((v, k) => v[k] ||= {}, row);
        parent[last] = val;
      }
      return { modifiedCount: row ? 1 : 0 };
    },
    deleteOne: async () => ({ deletedCount: 0 }),
  };
} };
Module._load = function(request: string, parent: any, ...rest: any[]) {
  if (request === "@/lib/mongo") return { getDb: async () => db };
  if (request === "@/lib/auth") return { getSession: async () => signedIn ? { shopId: 42, role: "owner", email: "fixture@example.test" } : null };
  if (request === "@/lib/featureResolver") return { getFeatureEntitlements: async () => ({ canUseFeature: () => entitled }) };
  if (request === "@/lib/hovercode") return { verifyHovercode: async () => {}, updateHovercodeLogo: async () => ({ success: true }), updateHovercodeDestination: async (id: string, url: string) => {
    destinationUpdates.push(id);
    hoverTargets.set(id, url);
    return { success: true };
  } };
  if (request === "@/lib/auto-booking/scheduler") return { triggerAutoBookingFromSticker: async () => {} };
  if (request === "@/lib/canvas-renderer") return { renderStickerStandard: async () => Buffer.from("png"), renderStickerDesigner: async () => Buffer.from("png") };
  if (request === "@google-cloud/storage") return { Storage: class {} };
  return originalLoad.call(this, request, parent, ...rest);
};
globalThis.fetch = async (url: any, init?: any) => {
  const path = String(url);
  if (path.endsWith("/create/")) {
    const payload = JSON.parse(init.body);
    createdTargets.push(payload.qr_data);
    hoverTargets.set(`new-${createdTargets.length}`, payload.qr_data);
    return Response.json({ id: `new-${createdTargets.length}`, png: "https://images.example.test/qr.png" });
  }
  if (path === "https://images.example.test/qr.png") return new Response("png", { headers: { "Content-Type": "image/png" } });
  if (path === "https://shortlink.example.test/old-direct-code") return new Response(null, { status: 302, headers: { Location: hoverTargets.get("old-direct-code")! } });
  if (path.includes("/old-direct-code/")) return Response.json({ qr_data: "https://booking.example.test", png: "https://images.example.test/qr.png" });
  throw new Error(`Unexpected test fetch: ${path}`);
};
const post = (path: string, body: any) => new NextRequest(`https://stickers.example.test${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

async function main() {
  const generate = require("../app/api/sticker/generate/route");
  const redirect = require("../app/api/sticker/redirect/[shopId]/route");
  const legacy = require("../app/sticker/redirect/[shopId]/route");
  const regenerate = require("../app/api/sticker/regenerate-qr/route");
  const settings = require("../app/api/sticker/settings/route");
  const qr = require("../app/api/sticker/qr/route");
  const qrCache = require("../app/api/sticker/qr-cache/route");
  const params = { params: Promise.resolve({ shopId: "42" }) };
  for (const v of [vin, "1HGCM82633A004353"]) {
    const response = await generate.POST(post("/api/sticker/generate", { vin: v, currentMileage: 1000 }));
    assert.equal(response.status, 200);
  }
  assert.equal(shopWrites.length, 0, "vehicle QR cannot overwrite generic image/ID");
  assert.equal(references.length, 2);
  assert.notEqual(createdTargets[0], createdTargets[1]);
  assert.equal(shop.stickerConfig.hovercodeQRId, "old-direct-code");
  const scanRequest = new NextRequest(createdTargets[0]);
  assert.equal((await middleware(scanRequest)).headers.get("x-middleware-next"), "1");
  const scan = await redirect.GET(scanRequest, params);
  assert.equal(scan.status, 302);
  assert.match(scan.headers.get("location")!, new RegExp(`/report/${vin}\\?token=`));
  assert.equal(scan.headers.get("cache-control"), "private, no-store");
  assert.equal(scans.at(-1).destinationKind, "vhi");
  const genericRequest = new NextRequest("https://stickers.example.test/api/sticker/redirect/42");
  assert.equal((await middleware(genericRequest)).headers.get("x-middleware-next"), "1");
  assert.equal((await redirect.GET(genericRequest, params)).headers.get("location"), "https://booking.example.test/");
  entitled = false;
  const denied = await redirect.GET(new NextRequest(createdTargets[0]), params);
  assert.equal(denied.headers.get("location"), "https://booking.example.test/");
  entitled = true;
  const old = await legacy.GET(new NextRequest("https://stickers.example.test/sticker/redirect/42"), params);
  assert.equal(old.status, 302);
  assert.equal(old.headers.get("location"), "https://booking.example.test/");
  const invalid = await redirect.GET(new NextRequest("https://stickers.example.test/api/sticker/redirect/42bad"), { params: Promise.resolve({ shopId: "42bad" }) });
  assert.equal(invalid.status, 400);
  assert.equal((await generate.POST(post("/api/sticker/generate", {}))).status, 200);
  assert.equal(createdTargets.at(-1), "https://stickers.example.test/api/sticker/redirect/42");
  assert.equal(shop.stickerConfig.qrTargetUrl, createdTargets.at(-1));
  assert.deepEqual(shop.stickerConfig.legacyHovercodeQRIds, ["old-direct-code"]);
  const firstPartyId = shop.stickerConfig.hovercodeQRId;
  assert.equal((await settings.PUT(post("/api/sticker/settings", { appointmentUrl: "https://new-booking.example.test" }))).status, 200);
  const legacyScan = await fetch("https://shortlink.example.test/old-direct-code", { redirect: "manual" });
  assert.equal(legacyScan.status, 302);
  assert.equal(legacyScan.headers.get("location"), "https://new-booking.example.test", "printed legacy shortlink follows booking edits after replacement");
  assert.deepEqual(destinationUpdates, ["old-direct-code"], "first-party code is never retargeted by booking edits");
  assert.equal(hoverTargets.get(firstPartyId), "https://stickers.example.test/api/sticker/redirect/42");
  const count = createdTargets.length;
  assert.equal((await generate.POST(post("/api/sticker/generate", {}))).status, 200);
  assert.equal(createdTargets.length, count, "verified generic cache reused");
  const referencesBefore = references.length;
  assert.equal((await generate.POST(post("/api/sticker/generate", { vin: "INCOMPLETE" }))).status, 200);
  assert.equal(references.length, referencesBefore, "bad VIN prints with generic QR without issuing a reference");
  assert.equal(createdTargets.length, count, "bad VIN reuses generic shop cache");
  assert.equal((await regenerate.POST(post("/api/sticker/regenerate-qr", {}))).status, 200);
  assert.equal(createdTargets.at(-1), "https://stickers.example.test/api/sticker/redirect/42");
  const standalone = await qr.POST(post("/api/sticker/qr", { customUrl: "https://booking.example.test" }));
  assert.equal(standalone.status, 200);
  assert.equal((await standalone.json()).url, "https://stickers.example.test/api/sticker/redirect/42");
  assert.equal((await settings.PUT(post("/api/sticker/settings", { scanDestination: "website" }))).status, 200);
  assert.equal(shop.stickerConfig.scanDestination, "website");
  assert.equal((await settings.PUT(post("/api/sticker/settings", { scanDestination: "invalid" }))).status, 400);
  for (const method of ["GET", "POST"]) {
    shop.stickerConfig = {
      appointmentUrl: "https://booking.example.test", hovercodeQRId: "old-direct-code",
      qrLogoPatchedAt: new Date(), cachedQrCodeDataUri: "data:image/png;base64,b2xk",
    };
    const cacheResponse = await qrCache[method](method === "GET"
      ? new NextRequest("https://stickers.example.test/api/sticker/qr-cache")
      : post("/api/sticker/qr-cache", {}));
    assert.equal(cacheResponse.status, 200);
    assert.deepEqual(shop.stickerConfig.legacyHovercodeQRIds, ["old-direct-code"]);
    assert.equal(shop.stickerConfig.qrTargetUrl, "https://stickers.example.test/api/sticker/redirect/42");
    assert.equal(shop.stickerConfig.cachedQrCodeDataUri, `data:image/png;base64,${Buffer.from("png").toString("base64")}`, "replacement metadata cannot certify a stale raw-URL image");
    assert.equal((await settings.PUT(post("/api/sticker/settings", { appointmentUrl: `https://booking-${method.toLowerCase()}.example.test` }))).status, 200);
    const oldScan = await fetch("https://shortlink.example.test/old-direct-code", { redirect: "manual" });
    assert.equal(oldScan.headers.get("location"), `https://booking-${method.toLowerCase()}.example.test`);
  }
  signedIn = false;
  assert.equal((await generate.POST(post("/api/sticker/generate", { vin }))).status, 401);
  assert.equal((await qr.POST(post("/api/sticker/qr", { vin }))).status, 401);
  console.log("Dynamic sticker route smoke passed (offline)");
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { Module._load = originalLoad; });
