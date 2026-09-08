import assert from "node:assert/strict";
import {
  __protractorClientTestHooks,
  protractorFetch,
  withProtractorApiSource,
  type ProtractorConfig,
} from "../lib/integrations/protractor/client";
import {
  __protractorDenialTest,
  withProtractorDirectDenialCache,
} from "../lib/external-api/partner-vhi-protractor-denials";

const config: ProtractorConfig = {
  connectionId: "status-test",
  apiKey: "test",
  authentication: "test",
  configured: true,
};

async function main() {
  delete process.env.PROTRACTOR_OUTBOUND_DISABLED;
  __protractorClientTestHooks.enforceLocalPolicyWithMockTransport = true;
  __protractorClientTestHooks.acquireOutboundGate = async () => ({ allowed: true, probe: false });
  __protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
    acquired: true, waitedMs: 0, currentCount: 0,
  });
  __protractorClientTestHooks.trackApiRequest = async () => {};
  __protractorClientTestHooks.recordResponse = async () => {};
  __protractorClientTestHooks.httpsRequest = async () => ({
    statusCode: 403,
    body: "forbidden",
  });
  const propagated = await protractorFetch("/ServiceItem/Search/TEST", config);
  assert.equal(propagated.ok, false);
  assert.equal(propagated.statusCode, 403, "HTTP status is preserved structurally");
  const wrapped = withProtractorApiSource(propagated);
  assert.equal(wrapped.statusCode, 403, "cache wrapper preserves structured status");
  assert.equal(wrapped.source, "api");

  __protractorDenialTest.clear();
  let calls = 0;
  const denied = () => {
    calls += 1;
    return Promise.resolve({ ok: false as const, statusCode: 403, error: "denied" });
  };
  const run = (shopId: number, vin: string, operation: "vehicle" | "deferred") =>
    withProtractorDirectDenialCache({ shopId, vin, operation, fetch: denied });

  await run(1, "1HGCM82633A004352", "vehicle");
  const cached = await run(1, "1HGCM82633A004352", "vehicle");
  assert.equal(calls, 1, "repeat identical denial is suppressed");
  assert.equal((cached as any).denialCacheHit, true);
  await run(2, "1HGCM82633A004352", "vehicle");
  await run(1, "1M8GDM9AXKP042788", "vehicle");
  await run(1, "1HGCM82633A004352", "deferred");
  assert.equal(calls, 4, "shop, VIN, and operation keys are isolated");

  __protractorDenialTest.clear();
  let otherCalls = 0;
  const otherFailure = async () => {
    otherCalls += 1;
    return { ok: false as const, statusCode: 500, error: "server" };
  };
  await withProtractorDirectDenialCache({
    shopId: 1, vin: "1HGCM82633A004352", operation: "vehicle", fetch: otherFailure,
  });
  await withProtractorDirectDenialCache({
    shopId: 1, vin: "1HGCM82633A004352", operation: "vehicle", fetch: otherFailure,
  });
  assert.equal(otherCalls, 2, "non-auth failures are never negative-cached");

  __protractorDenialTest.clear();
  __protractorDenialTest.seed(
    1, "1HGCM82633A004352", "vehicle", 401, Date.now() - 1,
  );
  __protractorDenialTest.sweep();
  let afterExpiry = 0;
  await withProtractorDirectDenialCache({
    shopId: 1,
    vin: "1HGCM82633A004352",
    operation: "vehicle",
    fetch: async () => {
      afterExpiry += 1;
      return { ok: true as const };
    },
  });
  assert.equal(afterExpiry, 1, "expired denial permits a new request");

  __protractorDenialTest.clear();
  let rejected = 0;
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => withProtractorDirectDenialCache({
      shopId: 1,
      vin: "1HGCM82633A004352",
      operation: "vehicle",
      fetch: async () => {
        rejected += 1;
        throw new Error("transport rejected");
      },
    }));
  }
  assert.equal(rejected, 2, "rejections do not poison the denial cache");
  console.log("AppFueled Protractor denial-cache smoke checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});