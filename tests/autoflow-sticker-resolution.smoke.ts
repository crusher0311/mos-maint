import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { __deps, findAutoflowStickerShop, findShopBySmsIdDetailed } from "../lib/extension-shop-lookup";
import { requireExtensionPrincipalScope, getAuthErrorStatus, buildAuthErrorBody } from "../lib/extension-auth";
import { makeFakeDb } from "./utils/fake-mongo";
import { createStickerQrTarget } from "../lib/sticker-qr-target";
import { getStickerRedirectUrl } from "../lib/sticker-utils";

process.env.NEXT_PUBLIC_BASE_URL = "https://fixture.test";

const source = fs.readFileSync("app/api/extension/sticker/route.ts", "utf8");
const owner = {
  shopId: 33, integrationProvider: "protractor",
  autoflowDomain: "fixture.autotext.me", autoflow: { shopNumbers: ["1360", 1361] },
  enabledFeatures: { oil_sticker: true },
  stickerConfig: { phone: "fixture-phone", tagline: "Owner branding", intervals: { synthetic: { mileage: 7200, months: 7 } } },
};

async function main() {
  let fake = makeFakeDb({ shops: [owner] });
  __deps.getDb = async () => fake.db as any;
  __deps.getMongoClient = async () => { throw new Error("no transactions allowed"); };
  // Reproduce the old session-dependent miss using the unchanged contracts.
  assert.equal((await findShopBySmsIdDetailed("1360", { providerHint: "autoflow", userShopIds: [33] })).status, "resolved");
  assert.equal((await findShopBySmsIdDetailed("1360", { providerHint: "autoflow", providerHintIsAuthoritative: true, userShopIds: [33] })).status, "not_found");
  let auth: any;
  let failDb = false;
  const sandbox: any = {
    console, Buffer, findShopBySmsIdDetailed, findAutoflowStickerShop,
    getDb: async () => fake.db,
    validateExtensionToken: async () => auth,
    requireExtensionPrincipalScope, getAuthErrorStatus, buildAuthErrorBody,
    NextResponse: { json: (body: any, options: any = {}) => ({ body, status: options.status || 200 }) },
    corsHeaders: {}, checkShopFeatureGate: async () => null,
    parseMileageInput: Number, parseMonthsInput: Number, isAbsurdMileage: () => false,
    resolveStickerUseKilometers: () => false,
    DEFAULT_INTERVALS: { synthetic: { mileage: 7500, months: 6 } },
    SIZE_DIMENSIONS: { "2x2.5": { width: 591, height: 739 } },
    SIZE_INCHES: { "2x2.5": { width: "1.97in", height: "2.46in" } },
    STICKER_LOGO_TIMEOUT_MS: 5000,
    withUpstreamTimeout: async (promise: Promise<any>) => promise,
    fetchLogoAsBase64: async (_url: string, _path: string, shopId: string) => `logo-${shopId}`,
    createStickerQrTarget,
    fallbackQRGeneration: async (url: string) => url,
    shouldRunStickerSideEffects: () => false,
    renderStickerStandard: async (config: any) => Buffer.from(JSON.stringify(config)),
  };
  __deps.getDb = async () => {
    if (failDb) throw new Error("temporary failure");
    return fake.db as any;
  };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(source.slice(source.indexOf("async function resolveMosShopId("), source.indexOf("// Task #510:")), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  const request = (id: string, custom = false, provider = "autoflow") => ({
    nextUrl: new URL(`https://fixture.test/api/extension/sticker?provider=${provider}&shopId=${id}`),
    json: async () => ({ provider, smsShopId: id, currentMileage: 50000, ...(custom ? { customMiles: 4000, customMonths: 4 } : {}) }),
  });
  for (const legacy of [true, false]) {
    auth = { authorized: true, user: { shopId: 33, shopIds: [33, 44] },
      principal: { isLegacy: legacy, shopId: 33, provider: "autoflow", assurance: "verified", capabilities: ["read", "shop_tool"] } };
    const malformedRequest = request("1360");
    const originalBody = await malformedRequest.json();
    malformedRequest.json = async () => ({ ...originalBody, vin: "INCOMPLETE" });
    let qrTarget = "";
    sandbox.fallbackQRGeneration = async (url: string) => { qrTarget = url; return url; };
    const malformedResponse = await sandbox._POST(malformedRequest);
    assert.equal(malformedResponse.status, 200, "extension prints incomplete VIN records");
    assert.equal(qrTarget, getStickerRedirectUrl(33), "extension uses generic target for malformed VIN");
    for (const id of ["fixture", "fixture.autotext.me", "1360", "1361"]) {
      const get = await sandbox._GET(request(id));
      assert.equal(get.status, 200);
      assert.equal(get.body.config.intervals.synthetic.mileage, 7200);
      for (const custom of [false, true]) {
        const post = await sandbox._POST(request(id, custom));
        assert.equal(post.status, 200);
        assert.equal(post.body.sticker.nextServiceMileage, custom ? 54000 : 57200);
        const image = JSON.parse(Buffer.from(post.body.sticker.dataUrl.split(",")[1], "base64").toString());
        assert.equal(image.logo, "logo-33");
        assert.equal(image.tagline, "Owner branding");
      }
    }
    for (const [extra, id, status] of [
      [[], "9999", 404],
      [[{ shopId: 99, autoflow: { shopNumbers: ["1360"] } }], "1360", 409],
      [[{ shopId: 99, autoflow: { shopId: "1360" } }], "1360", 403],
      [[{ shopId: 99, autoflowDomain: "fixture" }], "fixture", 409],
      [[{ shopId: 99, autoflow: { shopNumbers: ["8888"] } }], "8888", 403],
      [[{ shopId: 9999, tekmetric: { shopId: 9999 } }], "9999", 404],
    ] as const) {
      fake = makeFakeDb({ shops: [owner, ...extra] });
      for (const method of ["_GET", "_POST"]) assert.equal((await sandbox[method](request(id))).status, status);
      assert.ok(fake.ops.every(op => ["find", "findOne"].includes(op.op)));
    }
    fake = makeFakeDb({ shops: [owner] });
    failDb = true;
    for (const method of ["_GET", "_POST"]) assert.equal((await sandbox[method](request("1360"))).status, 503);
    failDb = false;
    if (!legacy) {
      for (const method of ["_GET", "_POST"]) {
        assert.equal((await sandbox[method](request("1360", false, "tekmetric"))).status, 403);
        auth.principal.shopId = 44;
        assert.equal((await sandbox[method](request("1360"))).status, 403);
        auth.principal.shopId = 33;
      }
    }
  }
  fake = makeFakeDb({ shops: [owner, { shopId: 44, autoflow: { shopNumbers: ["fixture", "1360"] } }] });
  assert.equal((await findAutoflowStickerShop("fixture", { userShopIds: [33, 44] }) as any).mosShopId, 33);
  assert.equal((await findAutoflowStickerShop("fixture", { userShopIds: [44] })).status, "access_denied");
  assert.equal((await findAutoflowStickerShop("1361", { userShopIds: [] })).status, "access_denied");
  assert.equal((await findAutoflowStickerShop("1361", { isPlatformAdmin: true }) as any).mosShopId, 33);
  for (const id of ["1360", "1361", "unknown"]) {
    assert.equal((await findShopBySmsIdDetailed(id, { providerHint: "autoflow", providerHintIsAuthoritative: true, isPlatformAdmin: true })).status, "not_found");
  }
  assert.equal((await findShopBySmsIdDetailed("fixture", { providerHint: "autoflow", providerHintIsAuthoritative: true, userShopIds: [33] })).status, "resolved");
  assert.ok(fake.ops.every(op => ["find", "findOne"].includes(op.op)));
  fake = makeFakeDb({ shops: [
    owner,
    { shopId: 44, autoflow: { shopId: "1360", shopNumbers: ["slug-only"] } },
  ] });
  assert.equal((await findAutoflowStickerShop("1360", { userShopIds: [33, 44] }) as any).mosShopId, 44);
  assert.equal((await findAutoflowStickerShop("slug-only", { userShopIds: [44] })).status, "not_found");
  assert.ok(fake.ops.every(op => ["find", "findOne"].includes(op.op)));
  console.log("✓ AutoFlow real lookup + GET/POST: legacy/first-class, branding, custom intervals, canonical precedence, isolation, scope, errors and read-only partner contract");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
