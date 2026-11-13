const assert = require("node:assert/strict");
const Module = require("node:module");
const original = Module._load;
let reads = 0;
Module._load = function (id, ...args) {
  if (id === "@/lib/data/repositories/shops") return {
    findShopByShopId: async shopId => { reads++; assert.equal(shopId, 17); return { name: "Fixture shop" }; },
  };
  return original.call(this, id, ...args);
};
(async () => {
  const { NextRequest } = require("next/server");
  const { __deps } = require("../lib/external-api/middleware.ts");
  let valid = true, permission = true, partner = false;
  __deps.validateApiKey = async () => ({ valid, apiKey: valid ? { shopId: 17, isPartner: partner, keyHash: "fixture", rateLimit: 60 } : undefined });
  __deps.checkPermission = async (_key, scope) => { assert.equal(scope, "print:agent"); return permission; };
  __deps.checkRateLimit = async () => ({ allowed: true, remaining: 20, resetAt: new Date(Date.now() + 60000) });
  __deps.updateApiKeyUsage = async () => {};
  __deps.logApiUsage = async () => {};
  const { GET } = require("../app/api/print-agent/setup/route.ts");
  const request = (auth = true) => new NextRequest("https://mos.tools/api/print-agent/setup?shopId=999",
    { headers: auth ? { authorization: "Bearer synthetic-only" } : {} });
  assert.equal((await GET(request(false))).status, 401);
  valid = false; assert.equal((await GET(request())).status, 401);
  valid = true; permission = false; assert.equal((await GET(request())).status, 403);
  permission = true; partner = true; assert.equal((await GET(request())).status, 403);
  assert.equal(reads, 0);
  partner = false;
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { shopId: 17, name: "Fixture shop" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(reads, 1);
  console.log("PASS setup authentication, permission, partner rejection and server-derived shop identity");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Module._load = original; });
