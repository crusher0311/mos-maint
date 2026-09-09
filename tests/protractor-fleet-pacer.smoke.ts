/**
 * Offline transport test for the provider-wide Protractor hard pacer.
 *
 * No real provider or relay traffic is generated. The mocked lease models one
 * Mongo-owned record shared by concurrent priority/background callers and the
 * mocked transport records the actual send boundary.
 */
import assert from "node:assert/strict";
import {
  __protractorClientTestHooks,
  protractorFetch,
  runWithProtractorCallbackTransport,
  soapAddServicePackage,
  type ProtractorConfig,
} from "../lib/integrations/protractor/client";

const TEST_GAP_MS = 20;
const config: ProtractorConfig = {
  shopId: 1,
  connectionId: "fleet-pacer-test-connection",
  apiKey: "test-key",
  authentication: "test-auth",
  configured: true,
};

let ownerToken: string | null = null;
let nextAllowedAt = 0;
let tokenSequence = 0;
let leaseAcquisitions = 0;
let leaseReleases = 0;
let callbackLeaseAcquisitions = 0;
let physicalStarts: number[] = [];
let transportActive = false;
let transportOverlap = false;
let responseForUrl: (url: string) => { statusCode: number; body: string };

function resetObservations(): void {
  ownerToken = null;
  nextAllowedAt = 0;
  leaseAcquisitions = 0;
  leaseReleases = 0;
  callbackLeaseAcquisitions = 0;
  physicalStarts = [];
  transportActive = false;
  transportOverlap = false;
}

function minimumGap(values: number[]): number {
  if (values.length < 2) return Number.POSITIVE_INFINITY;
  return Math.min(...values.slice(1).map((value, index) => value - values[index]));
}

function installWorkingPhysicalLease(): void {
  __protractorClientTestHooks.acquirePhysicalTransportLease = async (deadlineMs) => {
    while (Date.now() < deadlineMs) {
      const now = Date.now();
      if (!ownerToken && now >= nextAllowedAt) {
        ownerToken = `physical-${++tokenSequence}`;
        leaseAcquisitions += 1;
        return ownerToken;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return null;
  };
  __protractorClientTestHooks.confirmPhysicalTransportLease = async (token) =>
    token === ownerToken;
  __protractorClientTestHooks.releasePhysicalTransportLease = async (token) => {
    assert.equal(token, ownerToken, "only the current fleet lease owner may release");
    ownerToken = null;
    nextAllowedAt = Date.now() + TEST_GAP_MS;
    leaseReleases += 1;
  };
}

for (const key of [
  "PROTRACTOR_OUTBOUND_DISABLED",
  "PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS",
  "PROTRACTOR_CALLBACK_CANARY_UNTIL",
  "PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE",
]) {
  delete process.env[key];
}

__protractorClientTestHooks.enforceFleetPacerWithMockTransport = true;
__protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
  acquired: true,
  waitedMs: 0,
  currentCount: 1,
});
__protractorClientTestHooks.acquireOutboundGate = async () => ({ allowed: true, probe: false });
__protractorClientTestHooks.recordResponse = async () => {};
__protractorClientTestHooks.trackApiRequest = async () => {};
__protractorClientTestHooks.retryBaseDelayMs = 1;
__protractorClientTestHooks.random = () => 0;
__protractorClientTestHooks.sleep = async () => {};
__protractorClientTestHooks.resolveProtractorConfig = async () => config;
__protractorClientTestHooks.acquireCallbackTransportLease = async () => {
  callbackLeaseAcquisitions += 1;
  return `callback-${callbackLeaseAcquisitions}`;
};
__protractorClientTestHooks.releaseCallbackTransportLease = async () => {};
installWorkingPhysicalLease();
__protractorClientTestHooks.httpsRequest = async (url: string) => {
  if (transportActive) transportOverlap = true;
  transportActive = true;
  physicalStarts.push(Date.now());
  await new Promise((resolve) => setTimeout(resolve, 2));
  transportActive = false;
  return responseForUrl(url);
};

async function main(): Promise<void> {
  console.log("Scenario 1: mixed priority/background REST calls share one hard pacer");
  resetObservations();
  responseForUrl = () => ({ statusCode: 200, body: "{}" });
  const mixed = await Promise.all([
    protractorFetch("/Invoice/background-1", config, {}, 0, 1, { maxRetries: 0 }),
    protractorFetch("/Invoice/priority-1", config, {}, 0, 1, { priority: true, maxRetries: 0 }),
    protractorFetch("/Invoice/background-2", config, {}, 0, 1, { maxRetries: 0 }),
    protractorFetch("/Invoice/priority-2", config, {}, 0, 1, { priority: true, maxRetries: 0 }),
    protractorFetch("/Invoice/background-3", config, {}, 0, 1, { maxRetries: 0 }),
  ]);
  assert.ok(mixed.every((result) => result.ok));
  assert.equal(physicalStarts.length, 5);
  assert.equal(leaseAcquisitions, 5);
  assert.equal(leaseReleases, 5);
  assert.equal(transportOverlap, false, "physical attempts must never overlap");
  assert.ok(
    minimumGap(physicalStarts) >= TEST_GAP_MS,
    `actual physical starts must be at least ${TEST_GAP_MS}ms apart`,
  );

  console.log("Scenario 2: every retry reacquires the same fleet lease");
  resetObservations();
  const attempts = new Map<string, number>();
  responseForUrl = (url) => {
    const path = new URL(url).pathname;
    const attempt = (attempts.get(path) || 0) + 1;
    attempts.set(path, attempt);
    return attempt === 1
      ? { statusCode: 500, body: "transient" }
      : { statusCode: 200, body: "{}" };
  };
  const retried = await Promise.all([
    protractorFetch("/Invoice/retry-1", config, {}, 0, 1, { maxRetries: 1 }),
    protractorFetch("/Invoice/retry-2", config, {}, 0, 1, { priority: true, maxRetries: 1 }),
  ]);
  assert.ok(retried.every((result) => result.ok));
  assert.equal(physicalStarts.length, 4);
  assert.equal(leaseAcquisitions, 4);
  assert.equal(leaseReleases, 4);
  assert.equal(transportOverlap, false);
  assert.ok(minimumGap(physicalStarts) >= TEST_GAP_MS);

  console.log("Scenario 3: REST and SOAP use the identical fleet lease");
  resetObservations();
  responseForUrl = (url) => url.endsWith("WorkOrderServices.asmx")
    ? {
        statusCode: 200,
        body: "<WorkOrderUpdateResult>&lt;WorkOrder&gt;&lt;ServicePackage&gt;&lt;/ServicePackage&gt;&lt;/WorkOrder&gt;</WorkOrderUpdateResult>",
      }
    : { statusCode: 200, body: "{}" };
  const [rest, soap] = await Promise.all([
    protractorFetch("/Invoice/rest", config, {}, 0, 1, { maxRetries: 0 }),
    soapAddServicePackage(1, "wo-test", {
      ID: "wo-test",
      Type: "WorkOrder",
      WorkOrderNumber: 1,
      ServicePackages: [],
    }),
  ]);
  assert.equal(rest.ok, true);
  assert.equal(soap.ok, true);
  assert.equal(physicalStarts.length, 2);
  assert.equal(leaseAcquisitions, 2);
  assert.equal(transportOverlap, false);
  assert.ok(minimumGap(physicalStarts) >= TEST_GAP_MS);

  console.log("Scenario 4: callback traffic keeps its stricter outer lease");
  resetObservations();
  responseForUrl = () => ({ statusCode: 200, body: "{}" });
  const callbackResult = await runWithProtractorCallbackTransport(
    Date.now() + 5_000,
    () => protractorFetch("/Invoice/callback", config, {}, 0, 1, { maxRetries: 0 }),
  );
  assert.equal(callbackResult.ok, true);
  assert.equal(callbackLeaseAcquisitions, 1);
  assert.equal(leaseAcquisitions, 1);
  assert.equal(physicalStarts.length, 1);

  console.log("Scenario 5: pacer failures and a stop raised while waiting fail closed");
  resetObservations();
  responseForUrl = () => ({ statusCode: 200, body: "{}" });
  __protractorClientTestHooks.acquirePhysicalTransportLease = async () => {
    throw new Error("coordinator unavailable");
  };
  const unavailable = await protractorFetch(
    "/Invoice/unavailable",
    config,
    {},
    0,
    1,
    { maxRetries: 0 },
  );
  assert.equal(unavailable.ok, false);
  assert.equal(physicalStarts.length, 0);

  installWorkingPhysicalLease();
  let releasedAfterStop = false;
  __protractorClientTestHooks.acquirePhysicalTransportLease = async () => {
    process.env.PROTRACTOR_OUTBOUND_DISABLED = "true";
    return "stop-race-token";
  };
  __protractorClientTestHooks.releasePhysicalTransportLease = async (token) => {
    assert.equal(token, "stop-race-token");
    releasedAfterStop = true;
  };
  __protractorClientTestHooks.enforceLocalPolicyWithMockTransport = true;
  const stopped = await protractorFetch("/Invoice/stopped", config, {}, 0, 1, { maxRetries: 0 });
  delete process.env.PROTRACTOR_OUTBOUND_DISABLED;
  __protractorClientTestHooks.enforceLocalPolicyWithMockTransport = false;
  assert.equal(stopped.ok, false);
  assert.equal(physicalStarts.length, 0);
  assert.equal(releasedAfterStop, true);

  console.log("Scenario 6: stop and deadline changes during minute admission prevent dispatch");
  resetObservations();
  installWorkingPhysicalLease();
  responseForUrl = () => ({ statusCode: 200, body: "{}" });
  __protractorClientTestHooks.enforceLocalPolicyWithMockTransport = true;
  __protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.env.PROTRACTOR_OUTBOUND_DISABLED = "true";
    return { acquired: true, waitedMs: 10, currentCount: 1 };
  };
  const stoppedDuringMinuteWait = await protractorFetch(
    "/Invoice/stopped-during-minute-wait",
    config,
    {},
    0,
    1,
    { priority: true, maxRetries: 0 },
  );
  delete process.env.PROTRACTOR_OUTBOUND_DISABLED;
  __protractorClientTestHooks.enforceLocalPolicyWithMockTransport = false;
  assert.equal(stoppedDuringMinuteWait.ok, false);
  assert.equal(physicalStarts.length, 0);
  assert.equal(leaseReleases, 1);

  resetObservations();
  installWorkingPhysicalLease();
  __protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { acquired: true, waitedMs: 25, currentCount: 1 };
  };
  const expiredDuringMinuteWait = await runWithProtractorCallbackTransport(
    Date.now() + 10,
    () => protractorFetch(
      "/Invoice/expired-during-minute-wait",
      config,
      {},
      0,
      1,
      { priority: true, maxRetries: 0 },
    ),
  );
  assert.equal(expiredDuringMinuteWait.ok, false);
  assert.match(expiredDuringMinuteWait.error || "", /deadline expired/);
  assert.equal(physicalStarts.length, 0);
  assert.equal(leaseReleases, 1);

  resetObservations();
  installWorkingPhysicalLease();
  __protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
    acquired: true,
    waitedMs: 0,
    currentCount: 1,
  });
  __protractorClientTestHooks.confirmPhysicalTransportLease = async () => false;
  const lostOwnership = await protractorFetch(
    "/Invoice/lost-ownership",
    config,
    {},
    0,
    1,
    { priority: true, maxRetries: 0 },
  );
  assert.equal(lostOwnership.ok, false);
  assert.match(lostOwnership.error || "", /lease lost/);
  assert.equal(physicalStarts.length, 0);

  console.log("All Protractor fleet-pacer checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});