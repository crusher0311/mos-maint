const test = require("node:test");
const assert = require("node:assert/strict");
require("tsx/cjs");

test("browser print routes accept public origin behind proxy and reject hostile origins before writes", async () => {
  const Module = require("node:module"), load = Module._load;
  const oldEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  let writes = 0;
  class IppRequestError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  Module._load = function (request, ...args) {
    if (request === "@/lib/auth") return { requireSession: async () => ({ shopId: 63, role: "owner" }) };
    if (request === "@/lib/extension-route-guard") return { checkShopFeatureGate: async () => null };
    if (request === "./ipp-repository") return {
      IppRequestError, labelKind: x => x, setDefaultDestination: async () => { writes++; },
      getDestinationSettings: async () => ({}), enqueueIpp: async () => { throw Error("No print may be queued in this test"); },
    };
    return load.call(this, request, ...args);
  };
  try {
    const { NextRequest } = require("next/server");
    const { webTest, webDestinations } = require("../lib/print-queue/ipp-http");
    const req = (origin, method, body) => new NextRequest("https://0.0.0.0:5000/api/print/test", {
      method, headers: { origin, host: "mos.tools", "x-forwarded-host": "mos.tools", "content-type": "application/json" }, body,
    });
    // Invalid JSON reaches the parser only after the valid public-origin check.
    assert.equal((await webTest(req("https://mos.tools", "POST", "{"))).status, 400);
    assert.equal((await webDestinations(req("https://mos.tools", "PUT", JSON.stringify({kind:"sticker",destinationId:"fixture"})))).status, 200);
    assert.equal(writes, 1);
    for (const origin of ["https://evil.example", "https://mos.tools.evil.example", "http://mos.tools", "null", "https://0.0.0.0:5000"]) {
      assert.equal((await webTest(req(origin, "POST", "{"))).status, 403);
      assert.equal((await webDestinations(req(origin, "PUT", JSON.stringify({kind:"sticker",destinationId:"fixture"})))).status, 403);
    }
    assert.equal(writes, 1);
  } finally {
    Module._load = load;
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
  }
});
