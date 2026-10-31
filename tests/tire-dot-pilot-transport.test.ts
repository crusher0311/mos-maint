import test from "node:test";
import assert from "node:assert/strict";

test("actual transport uses ISO boundaries and preserves only safe HTTP errors", async () => {
  const Module = require("module");
  const load = Module._load;
  const originalFetch = globalThis.fetch;
  Module._load = function(request: string, ...args: any[]) {
    if (request.endsWith("/shared-rate-limiter")) return {
      isSharedLimiterDisabled: () => false, isSharedLimiterPgCanonical: () => true,
      acquireSharedTekmetricSlot: async () => ({ acquired: true }),
    };
    if (request.endsWith("/tekmetric-ops")) return {
      getCurrentToken: async () => ({ accessToken: "fictional", expiresAt: new Date(Date.now() + 60_000) }),
    };
    if (request.endsWith("/heart-recovery-budget")) return {};
    return load.call(this, request, ...args);
  };
  try {
    const { fetchTirePilotPage } = require("../lib/tire-dot-pilot-transport");
    let admitted = 0, calls = 0, status = 200;
    globalThis.fetch = (async (input: any, init: any) => {
      calls++;
      assert.equal(admitted, calls, "guard runs before each physical request");
      const url = new URL(input);
      assert.equal(url.origin + url.pathname, "https://shop.tekmetric.com/api/v1/repair-orders");
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        shop: "469", postedDateStart: "2026-09-30T00:00:00.000Z",
        postedDateEnd: "2026-11-02T00:00:00.000Z", sort: "repairOrderNumber",
        sortDirection: "ASC", size: "50", page: "0",
      });
      assert.equal(init.redirect, "error");
      return new Response(status === 200 ? '{"content":[]}' : "private upstream body", { status });
    }) as typeof fetch;
    const run = () => fetchTirePilotPage({} as any,
      { shopId: 32, providerShopId: 469, timezone: "America/New_York" }, 0, async () => { admitted++; });
    assert.deepEqual(await run(), { content: [] });
    for (status of [400, 401, 403, 429, 500, 503]) {
      await assert.rejects(run(), (error: any) => {
        assert.equal(error.message, "provider_http_error");
        assert.equal(error.status, status);
        assert(!JSON.stringify(error).includes("private"));
        return true;
      });
    }
    assert.equal(calls, 7, "HTTP errors are not automatically retried");
  } finally {
    Module._load = load;
    globalThis.fetch = originalFetch;
  }
});
