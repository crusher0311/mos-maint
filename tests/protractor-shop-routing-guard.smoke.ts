import assert from "node:assert/strict";
import {
  isProtractorShopRecord,
  readShopProtractorCredentials,
} from "../lib/integrations/protractor/shop-eligibility";
import {
  __protractorClientTestHooks,
  protractorFetch,
  soapAddServicePackage,
  testConnection,
  type ProtractorConfig,
} from "../lib/integrations/protractor/client";

const validCredentials = {
  connectionId: "connection-1",
  apiKey: "api-key-1",
};

assert.equal(
  isProtractorShopRecord({
    integrationProvider: "tekmetric",
    protractor: validCredentials,
  }),
  false,
  "declared non-Protractor provider must win over stale credentials",
);

assert.equal(
  readShopProtractorCredentials({
    integrationProvider: "protractor",
    protractor: validCredentials,
  })?.connectionId,
  validCredentials.connectionId,
);

assert.equal(
  readShopProtractorCredentials({
    integrationProvider: "protractor",
  }),
  null,
  "global environment credentials must not make a shop configured",
);

assert.equal(
  isProtractorShopRecord({
    protractorConnectionId: validCredentials.connectionId,
    protractorApiKey: validCredentials.apiKey,
  }),
  true,
  "legacy shops with a complete shop-owned credential pair remain eligible",
);

let transportCalls = 0;
const originalHttpsRequest = __protractorClientTestHooks.httpsRequest;
const originalAcquireOutboundGate = __protractorClientTestHooks.acquireOutboundGate;
const originalAcquireDistributedRateLimitSlot =
  __protractorClientTestHooks.acquireDistributedRateLimitSlot;
const originalResolveProtractorConfig = __protractorClientTestHooks.resolveProtractorConfig;
const originalTrackApiRequest = __protractorClientTestHooks.trackApiRequest;
const originalRecordResponse = __protractorClientTestHooks.recordResponse;
__protractorClientTestHooks.httpsRequest = async () => {
  transportCalls++;
  return { statusCode: 200, body: '{"ItemCollection":[]}' };
};
__protractorClientTestHooks.acquireOutboundGate = async () => ({ allowed: true, probe: false });
__protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
  acquired: true,
  waitedMs: 0,
  currentCount: 1,
});
__protractorClientTestHooks.trackApiRequest = async () => {};
__protractorClientTestHooks.recordResponse = async () => {};

const config: ProtractorConfig = {
  shopId: 1,
  ...validCredentials,
  authentication: "authentication",
  configured: true,
};

async function main() {
  try {
    const result = await protractorFetch("/Invoice/blocked", config);
    assert.equal(result.ok, false);
    assert.match(result.error || "", /valid shop ID/i);
    assert.equal(transportCalls, 0, "unattributed calls must be blocked before transport");

    const mismatch = await protractorFetch("/Invoice/blocked", config, {}, 0, 2);
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error || "", /does not belong/i);
    assert.equal(transportCalls, 0, "a config for one shop must not be usable by another");

    const connectionTest = await testConnection(
      validCredentials.connectionId,
      validCredentials.apiKey,
      9,
    );
    assert.equal(connectionTest.ok, true, "authenticated credential setup remains usable");
    assert.equal(transportCalls, 1);

    __protractorClientTestHooks.resolveProtractorConfig = async () => config;
    const soapMismatch = await soapAddServicePackage(2, "work-order-2", {
      ID: "work-order-2",
      ServicePackages: { ItemCollection: [] },
    });
    assert.equal(soapMismatch.ok, false);
    assert.match(soapMismatch.error || "", /matching shop configuration/i);
    assert.equal(transportCalls, 1, "SOAP config mismatch must be blocked before transport");
  } finally {
    __protractorClientTestHooks.httpsRequest = originalHttpsRequest;
    __protractorClientTestHooks.acquireOutboundGate = originalAcquireOutboundGate;
    __protractorClientTestHooks.acquireDistributedRateLimitSlot =
      originalAcquireDistributedRateLimitSlot;
    __protractorClientTestHooks.resolveProtractorConfig = originalResolveProtractorConfig;
    __protractorClientTestHooks.trackApiRequest = originalTrackApiRequest;
    __protractorClientTestHooks.recordResponse = originalRecordResponse;
  }

  console.log("protractor shop routing guard smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});