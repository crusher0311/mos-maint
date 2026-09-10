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
  createServiceItem,
  protractorFetch,
  runWithProtractorCallbackTransport,
  soapAddServicePackage,
  type ProtractorConfig,
} from "../lib/integrations/protractor/client";
import {
  PROTRACTOR_RELAY_OVERSIZED_RESPONSE_STATUS,
  PROTRACTOR_TRANSPORT_FAILURE_STATUS,
} from "../lib/data/repositories/protractor-circuit-breaker";
import { RelayTransportError } from "../lib/integrations/protractor/relay-transport";

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
__protractorClientTestHooks.physicalTransportHeartbeatMs = 30_000;
__protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
  acquired: true,
  waitedMs: 0,
  currentCount: 1,
});
__protractorClientTestHooks.acquireOutboundGate = async () => ({ allowed: true, probe: false });
__protractorClientTestHooks.renewPhysicalTransportLease = async (token) =>
  token === ownerToken;
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

  console.log("Scenario 7: relay failures retain privacy-safe shop and endpoint attribution");
  resetObservations();
  installWorkingPhysicalLease();
  const capturedErrors: string[] = [];
  const relayOrdering: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    capturedErrors.push(args.map(String).join(" "));
  };
  let restTransportAttempts = 0;
  const relayBreakerStatuses: number[] = [];
  __protractorClientTestHooks.recordResponse = async (_connectionId, statusCode) => {
    relayOrdering.push("record");
    relayBreakerStatuses.push(statusCode);
  };
  __protractorClientTestHooks.releasePhysicalTransportLease = async (token) => {
    assert.equal(token, ownerToken);
    relayOrdering.push("release");
    ownerToken = null;
    nextAllowedAt = Date.now() + TEST_GAP_MS;
    leaseReleases += 1;
  };
  __protractorClientTestHooks.httpsRequest = async () => {
    restTransportAttempts += 1;
    throw new RelayTransportError("upstream_response_too_large");
  };
  try {
    const oversized = await protractorFetch(
      "/WorkOrder/private-work-order-id?vin=private-vin",
      config,
      {},
      0,
      1,
      { maxRetries: 3 },
    );
    assert.equal(oversized.ok, false);
    assert.equal(oversized.error, "Protractor relay transport failed");
    assert.equal(restTransportAttempts, 1, "relay REST failure must not retry");
  } finally {
    console.error = originalConsoleError;
  }
  const restAttributions = capturedErrors
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(value => value?.event === "protractor_relay_transport_error");
  assert.equal(restAttributions.length, 1);
  assert.deepEqual(
    relayBreakerStatuses,
    [PROTRACTOR_RELAY_OVERSIZED_RESPONSE_STATUS],
    "oversized relay responses must trip the immediate shared breaker signal",
  );
  assert.deepEqual(
    relayOrdering,
    ["record", "release"],
    "relay failure feedback must be committed before the fleet lease is released",
  );
  assert.deepEqual(restAttributions[0], {
    event: "protractor_relay_transport_error",
    method: "GET",
    shopId: 1,
    endpointClass: "work_order",
    relayErrorCode: "upstream_response_too_large",
    attempt: 1,
    priority: false,
  });
  assert.doesNotMatch(JSON.stringify(restAttributions), /private-work-order-id|private-vin/);

  relayBreakerStatuses.length = 0;
  relayOrdering.length = 0;
  restTransportAttempts = 0;
  __protractorClientTestHooks.httpsRequest = async () => {
    restTransportAttempts += 1;
    throw new RelayTransportError("busy");
  };
  const busy = await protractorFetch(
    "/Invoice/private-invoice-id",
    config,
    {},
    0,
    1,
    { maxRetries: 3 },
  );
  assert.equal(busy.ok, false);
  assert.equal(restTransportAttempts, 1, "other relay failures must not retry");
  assert.deepEqual(
    relayBreakerStatuses,
    [PROTRACTOR_TRANSPORT_FAILURE_STATUS],
    "other relay failures must feed the existing transient breaker signal",
  );
  assert.deepEqual(relayOrdering, ["record", "release"]);

  relayBreakerStatuses.length = 0;
  relayOrdering.length = 0;
  __protractorClientTestHooks.httpsRequest = async () => ({
    statusCode: 200,
    body: "{}",
  });
  const recordedSuccess = await protractorFetch(
    "/Invoice/success-ordering",
    config,
    {},
    0,
    1,
    { maxRetries: 0 },
  );
  assert.equal(recordedSuccess.ok, true);
  assert.deepEqual(relayBreakerStatuses, [200]);
  assert.deepEqual(
    relayOrdering,
    ["record", "release"],
    "successful probe feedback must be committed before the fleet lease is released",
  );

  console.log("Scenario 7b: slow breaker persistence keeps the physical lease alive");
  relayBreakerStatuses.length = 0;
  relayOrdering.length = 0;
  let heartbeatRenewals = 0;
  __protractorClientTestHooks.physicalTransportHeartbeatMs = 5;
  __protractorClientTestHooks.renewPhysicalTransportLease = async (token) => {
    assert.equal(token, ownerToken);
    heartbeatRenewals += 1;
    return true;
  };
  __protractorClientTestHooks.recordResponse = async (_connectionId, statusCode) => {
    relayOrdering.push("record-start");
    relayBreakerStatuses.push(statusCode);
    await new Promise((resolve) => setTimeout(resolve, 25));
    relayOrdering.push("record-end");
  };
  const slowRecorded = await protractorFetch(
    "/Invoice/slow-breaker-record",
    config,
    {},
    0,
    1,
    { maxRetries: 0 },
  );
  assert.equal(slowRecorded.ok, true);
  assert.ok(heartbeatRenewals >= 2, "lease must renew while breaker persistence is delayed");
  assert.deepEqual(
    relayOrdering,
    ["record-start", "record-end", "release"],
    "lease release must wait for delayed breaker persistence",
  );
  __protractorClientTestHooks.physicalTransportHeartbeatMs = 30_000;
  __protractorClientTestHooks.renewPhysicalTransportLease = async (token) =>
    token === ownerToken;

  console.log("Scenario 8: SOAP relay failures are attributed once without private identifiers");
  resetObservations();
  installWorkingPhysicalLease();
  const capturedSoapLogs: string[] = [];
  const originalConsoleLog = console.log;
  const originalSoapConsoleError = console.error;
  console.log = (...args: unknown[]) => {
    capturedSoapLogs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    capturedSoapLogs.push(args.map(String).join(" "));
  };
  let soapTransportAttempts = 0;
  const trackedApiEndpoints: string[] = [];
  relayBreakerStatuses.length = 0;
  __protractorClientTestHooks.trackApiRequest = async (_provider, endpoint) => {
    trackedApiEndpoints.push(String(endpoint));
  };
  __protractorClientTestHooks.httpsRequest = async () => {
    soapTransportAttempts += 1;
    throw new RelayTransportError("upstream_response_too_large");
  };
  try {
    const workOrderResult = await soapAddServicePackage(
      1,
      "private-work-order-guid",
      { ID: "private-work-order-guid", Type: "WorkOrder", ServicePackages: [] },
    );
    assert.equal(workOrderResult.ok, false);
    assert.equal(soapTransportAttempts, 1, "relay WorkOrder failure must not retry");

    const serviceItemResult = await createServiceItem(1, {
      ownerId: "private-owner-id",
      vin: "PRIVATEVIN123456789",
      year: 2020,
      make: "Private Make",
      model: "Private Model",
    });
    assert.equal(serviceItemResult.ok, false);
    assert.equal(soapTransportAttempts, 2, "relay ServiceItem failure must not retry");

    __protractorClientTestHooks.httpsRequest = async () => {
      soapTransportAttempts += 1;
      return {
        statusCode: 400,
        body: "<soap:Fault><faultstring>private-provider-fault-vin</faultstring></soap:Fault>",
      };
    };
    const providerFault = await soapAddServicePackage(
      1,
      "private-fault-work-order-guid",
      { ID: "private-fault-work-order-guid", Type: "WorkOrder", ServicePackages: [] },
    );
    assert.equal(providerFault.ok, false);
    assert.equal(providerFault.error, "private-provider-fault-vin");
    assert.equal(soapTransportAttempts, 3);
  } finally {
    console.log = originalConsoleLog;
    console.error = originalSoapConsoleError;
  }
  const soapAttributions = capturedSoapLogs
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(value => value?.event === "protractor_relay_transport_error");
  assert.equal(soapAttributions.length, 2);
  assert.deepEqual(
    relayBreakerStatuses.slice(0, 2),
    [
      PROTRACTOR_RELAY_OVERSIZED_RESPONSE_STATUS,
      PROTRACTOR_RELAY_OVERSIZED_RESPONSE_STATUS,
    ],
    "both SOAP families must trip the immediate shared breaker signal",
  );
  for (const event of soapAttributions) {
    assert.deepEqual(event, {
      event: "protractor_relay_transport_error",
      method: "POST",
      shopId: 1,
      endpointClass: "soap",
      relayErrorCode: "upstream_response_too_large",
      attempt: 1,
      priority: false,
    });
  }
  assert.doesNotMatch(
    capturedSoapLogs.join("\n"),
    /private-work-order-guid|private-fault-work-order-guid|private-provider-fault-vin|private-owner-id|PRIVATEVIN|Private Make|Private Model/,
  );
  assert.deepEqual(trackedApiEndpoints, ["soap:work_order"]);

  console.log("All Protractor fleet-pacer checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});