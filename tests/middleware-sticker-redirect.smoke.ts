import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";

// Exercise the real middleware without cookies, bearer tokens or dev auto-login.
process.env.DEV_AUTO_LOGIN = "false";
const Module = require("node:module");
const originalLoad = Module._load;
let dbCalls = 0;
Module._load = function(request: string, parent: any, ...rest: any[]) {
  if (request === "@/lib/mongo") return { getDb: async () => {
    dbCalls++;
    throw new Error("Invalid-shop probes must never access a database");
  } };
  if (request === "@/lib/sticker-redirect") return { resolveStickerScan: async () => {
    throw new Error("Invalid-shop probes must never resolve destinations");
  } };
  if (request === "@/lib/featureResolver") return { getFeatureEntitlements: async () => {
    throw new Error("Invalid-shop probes must never resolve entitlements");
  } };
  return originalLoad.call(this, request, parent, ...rest);
};

const request = (path: string, method = "GET") =>
  new NextRequest(`https://stickers.example.test${path}`, { method });

async function main() {
  const redirect = require("../app/api/sticker/redirect/[shopId]/route");
  for (const method of ["GET", "HEAD"]) {
    for (const suffix of ["42", "42/", "42?v=abcdefghijklmnopqrstuvwx", "42/?v=abcdefghijklmnopqrstuvwx", "0", "42bad"]) {
      const req = request(`/api/sticker/redirect/${suffix}`, method);
      const res = await middleware(req);
      assert.equal(res.headers.get("x-middleware-next"), "1", `${method} ${suffix} reaches handler`);
      assert.equal(req.nextUrl.search, new URL(req.url).search, "query preserved");
    }
  }
  for (const shopId of ["0", "-1", "42bad", "9007199254740992"]) {
    const req = request(`/api/sticker/redirect/${shopId}?v=abcdefghijklmnopqrstuvwx`);
    assert.equal((await middleware(req)).headers.get("x-middleware-next"), "1");
    const res = await redirect.GET(req, { params: Promise.resolve({ shopId }) });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid shop ID" });
  }
  assert.equal(dbCalls, 0);

  const protectedPaths = [
    "/api/sticker/settings", "/api/sticker/generate", "/api/sticker/regenerate-qr",
    "/api/sticker/upload-logo", "/api/sticker/finalize-logo", "/api/sticker/logo/example",
    "/api/sticker/qr", "/api/sticker/qr-cache",
    "/api/sticker/redirect", "/api/sticker/redirect/",
    "/api/sticker/redirect/42/settings", "/api/sticker/redirect/42/extra/",
    "/api/sticker/redirect-other/42", "/api/stickers/redirect/42",
    "/api/shops", "/api/vehicles/example",
  ];
  for (const path of protectedPaths) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await middleware(request(`${path}?v=abcdefghijklmnopqrstuvwx`, method));
      assert.equal(res.status, 401, `${method} ${path} remains protected`);
      assert.equal(res.headers.get("x-middleware-next"), null);
    }
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const suffix of ["42", "42/?v=abcdefghijklmnopqrstuvwx"]) {
      assert.equal((await middleware(request(`/api/sticker/redirect/${suffix}`, method))).status, 401);
    }
  }
  console.log("Public sticker middleware regression passed (offline)");
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { Module._load = originalLoad; });
