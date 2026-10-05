import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual shared GET/POST resolver without loading native canvas or
// any side-effecting renderer dependencies.
const source = fs.readFileSync("app/api/extension/sticker/route.ts", "utf8");
const resolver = source.slice(source.indexOf("async function resolveMosShopId("), source.indexOf("async function _GET("));
async function main() {
  let outcome: any;
  let lookupOptions: any;
  const sandbox: any = {
    console: { log() {}, warn() {} },
    findShopBySmsIdDetailed: async (_id: string, options: any) => {
      lookupOptions = options;
      assert.equal(options.providerHintIsAuthoritative, true);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(resolver, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  const db = { collection: () => { throw new Error("explicit context must not fall back to primary shop"); } };
  for (const provider of ["tekmetric", "autoflow", "shopware"]) {
    const auth = { principal: { provider }, user: { shopId: 10, shopIds: [10] } };
    for (const [status, http] of [["not_found", 404], ["access_denied", 403], ["conflict", 409]] as const) {
      outcome = { status, provider, identifier: "200" };
      const result = await sandbox.resolveMosShopId(db, auth, "200", provider);
      assert.equal(result.shop, null);
      assert.equal(result.lookupFailure.status, http);
      assert.match(result.lookupFailure.error, provider === "tekmetric" ? /Tekmetric/ : provider === "shopware" ? /Shop-Ware/ : /AutoFlow/);
      if (provider === "tekmetric") assert.doesNotMatch(result.lookupFailure.error, /AutoFlow/);
    }
    outcome = new Error("database unavailable");
    assert.equal((await sandbox.resolveMosShopId(db, auth, "200", provider)).lookupFailure.status, 503);
    outcome = { status: "resolved", mosShopId: 11, provider, shopDoc: { shopId: 11, stickerConfig: { logo: "B" } } };
    const resolved = await sandbox.resolveMosShopId(db, auth, "200", provider);
    assert.equal(resolved.shop.stickerConfig.logo, "B");
  }
  assert.equal((await sandbox.resolveMosShopId(db, { principal: { provider: "protractor" }, user: {} }, "200", "tekmetric")).lookupFailure.status, 403);
  assert.equal((source.match(/await resolveMosShopId\(/g) || []).length, 2);
  // Execute BOTH actual handler bodies through the early rejection, not just
  // their shared resolver. Native rendering/storage must never be reached.
  Object.assign(sandbox, {
    console: { log() {}, warn() {}, error() {} },
    validateExtensionToken: async () => ({
      authorized: true, principal: { provider: "shopware" },
      user: { shopId: 136, shopIds: [136] },
    }),
    getDb: async () => db,
    NextResponse: { json: (body: any, options: any) => ({ body, status: options.status }) },
    corsHeaders: {},
    parseMileageInput: (value: any) => Number(value),
    isAbsurdMileage: () => false,
    renderStickerStandard: () => { throw new Error("must not render a rejected shop"); },
  });
  const handlers = source.slice(source.indexOf("async function _GET("), source.indexOf("// Task #510:"));
  vm.runInContext(ts.transpileModule(handlers, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  for (const [status, http] of [["conflict", 409], ["access_denied", 403], ["not_found", 404]] as const) {
    outcome = { status, provider: "shopware", identifier: "allcare-services-llc" };
    const request = {
      nextUrl: new URL("https://example.test/api/extension/sticker?provider=shopware&shopId=allcare-services-llc&swShopId=6194&swRoId=12"),
      json: async () => ({ provider: "shopware", smsShopId: "allcare-services-llc", swShopId: "6194", swRoId: "12", currentMileage: 50000 }),
    };
    for (const method of ["_GET", "_POST"]) {
      const response = await sandbox[method](request);
      assert.equal(response.status, http, `${method} must preserve ${status}`);
      assert.match(response.body.error, /Shop-Ware/);
      assert.equal(lookupOptions.shopwareLocationId, "6194");
      assert.equal(lookupOptions.shopwareRepairOrderId, "12");
    }
  }
  console.log("✓ GET/POST shared resolver: correct branding source, provider-correct denied/unlinked/conflict/transient messages, no primary fallback");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
