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
  const sandbox: any = {
    console: { log() {}, warn() {} },
    findShopBySmsIdDetailed: async (_id: string, options: any) => {
      assert.equal(options.providerHintIsAuthoritative, true);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(resolver, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  const db = { collection: () => { throw new Error("explicit context must not fall back to primary shop"); } };
  for (const provider of ["tekmetric", "autoflow"]) {
    const auth = { principal: { provider }, user: { shopId: 10, shopIds: [10] } };
    for (const [status, http] of [["not_found", 404], ["access_denied", 403], ["conflict", 409]] as const) {
      outcome = { status, provider, identifier: "200" };
      const result = await sandbox.resolveMosShopId(db, auth, "200", provider);
      assert.equal(result.shop, null);
      assert.equal(result.lookupFailure.status, http);
      assert.match(result.lookupFailure.error, provider === "tekmetric" ? /Tekmetric/ : /AutoFlow/);
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
  console.log("✓ GET/POST shared resolver: correct branding source, provider-correct denied/unlinked/conflict/transient messages, no primary fallback");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
