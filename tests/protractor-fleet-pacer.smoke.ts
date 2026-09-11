/**
 * Offline transport test for the provider-wide Protractor hard pacer.
 *
 * No real provider or relay traffic is generated. The mocked lease models one
 * Mongo-owned record shared by concurrent priority/background callers and the
 * mocked transport records the actual send boundary.
 */
import "./helpers/deny-network-egress";
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
import {
  __protractorPhysicalTransportTestHooks,
  acquireProtractorPhysicalTransportLease,
  clearProtractorOperatorStop,
  confirmProtractorPhysicalTransportLease,
  releaseProtractorPhysicalTransportLease,
  renewProtractorPhysicalTransportLease,
} from "../lib/data/repositories/api-usage";
import { createMongoExpressionCollection } from "./helpers/mongo-expression-collection";

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
  "NODE_ENV",
  "REPLIT_DEV_DOMAIN",
  "PROTRACTOR_OUTBOUND_DISABLED",
  "PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS",
  "PROTRACTOR_CALLBACK_CANARY_UNTIL",
  "PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE",
]) {
  delete process.env[key];
}
const testEnv = process.env as Record<string, string | undefined>;
testEnv.NODE_ENV = "test";
delete testEnv.REPLIT_DEV_DOMAIN;

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
__protractorClientTestHooks.getOperatorStop = async () => ({
  active: false,
  canary: undefined,
} as any);
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

  console.log("Scenario 3b: usage provenance records the actual transport for REST writes and SOAP");
  const provenance: Array<{
    endpoint: string;
    method: string;
    options?: { environment?: string; transport?: string };
  }> = [];
  const originalProvenanceTracker = __protractorClientTestHooks.trackApiRequest;
  const originalProvenanceTransport = __protractorClientTestHooks.httpsRequest;
  __protractorClientTestHooks.trackApiRequest = async (...args) => {
    provenance.push({
      endpoint: String(args[1]),
      method: String(args[2]),
      options: args[6] as { environment?: string; transport?: string } | undefined,
    });
  };
  __protractorClientTestHooks.httpsRequest = async (...args) => ({
    statusCode: 200,
    body: String(args[1]) === "POST" && String(args[0]).endsWith("WorkOrderServices.asmx")
      ? "<WorkOrderUpdateResult>&lt;WorkOrder&gt;&lt;ServicePackage&gt;&lt;/ServicePackage&gt;&lt;/WorkOrderUpdateResult>"
      : "{}",
    transport: "relay",
  } as any);
  const restWrite = await protractorFetch(
    "/WorkOrder/provenance-rest-write",
    config,
    { method: "POST", body: "{}" },
    0,
    1,
    { maxRetries: 0 },
  );
  const soapProvenance = await soapAddServicePackage(1, "provenance-soap", {
    ID: "provenance-soap",
    Type: "WorkOrder",
    ServicePackages: [],
  });
  assert.equal(restWrite.ok, true);
  assert.equal(soapProvenance.ok, true);
  assert.deepEqual(
    provenance.map(item => [item.endpoint, item.method, item.options?.transport, item.options?.environment]),
    [
      ["relay", "POST", "relay", "test"],
      ["soap:work_order", "POST-SOAP", "relay", "test"],
    ],
    "usage records must reflect the transport actually returned by the dispatch boundary",
  );
  __protractorClientTestHooks.trackApiRequest = originalProvenanceTracker;
  __protractorClientTestHooks.httpsRequest = originalProvenanceTransport;

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

  console.log("Scenario 9: operator stop survives every stale in-flight outcome");
  let operatorStopActive = false;
  let operatorOwner: string | null = null;
  let operatorSequence = 0;
  let operatorPhysicalStarts = 0;
  const recordedOutcomes: number[] = [];
  __protractorClientTestHooks.acquirePhysicalTransportLease = async () => {
    if (operatorStopActive || operatorOwner) return null;
    operatorOwner = `operator-race-${++operatorSequence}`;
    return operatorOwner;
  };
  __protractorClientTestHooks.confirmPhysicalTransportLease = async token =>
    !operatorStopActive && token === operatorOwner;
  __protractorClientTestHooks.renewPhysicalTransportLease = async token =>
    token === operatorOwner;
  __protractorClientTestHooks.releasePhysicalTransportLease = async token => {
    if (token === operatorOwner) operatorOwner = null;
  };
  __protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
    acquired: true,
    waitedMs: 0,
    currentCount: 1,
  });
  __protractorClientTestHooks.acquireOutboundGate = async () => ({
    allowed: true,
    probe: true,
  });
  __protractorClientTestHooks.recordResponse = async (_connectionId, status) => {
    recordedOutcomes.push(status);
  };

  const staleOutcomes: Array<{
    name: string;
    expectedStatus: number;
    complete: (
      resolve: (value: { statusCode: number; body: string }) => void,
      reject: (error: Error) => void,
    ) => void;
  }> = [
    { name: "success", expectedStatus: 200, complete: resolve => resolve({ statusCode: 200, body: "{}" }) },
    { name: "authentication", expectedStatus: 401, complete: resolve => resolve({ statusCode: 401, body: "unauthorized" }) },
    { name: "throttled", expectedStatus: 429, complete: resolve => resolve({ statusCode: 429, body: "slow down" }) },
    { name: "server", expectedStatus: 503, complete: resolve => resolve({ statusCode: 503, body: "down" }) },
    {
      name: "transport",
      expectedStatus: PROTRACTOR_TRANSPORT_FAILURE_STATUS,
      complete: (_resolve, reject) => reject(new Error("socket reset")),
    },
  ];

  for (const outcome of staleOutcomes) {
    operatorStopActive = false;
    operatorOwner = null;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let completeTransport!: (value: { statusCode: number; body: string }) => void;
    let failTransport!: (error: Error) => void;
    const completion = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      completeTransport = resolve;
      failTransport = reject;
    });
    __protractorClientTestHooks.httpsRequest = async () => {
      operatorPhysicalStarts += 1;
      signalStarted();
      return completion;
    };
    const pending = protractorFetch(
      `/Invoice/operator-stop-${outcome.name}`,
      config,
      {},
      0,
      1,
      { maxRetries: 0 },
    );
    await started;
    operatorStopActive = true;
    outcome.complete(completeTransport, failTransport);
    await pending;
    assert.equal(operatorStopActive, true, `${outcome.name} feedback must not clear the operator stop`);
    assert.equal(recordedOutcomes.at(-1), outcome.expectedStatus);

    const startsBeforeDeniedCall = operatorPhysicalStarts;
    const denied = await protractorFetch(
      `/Invoice/operator-stop-denied-${outcome.name}`,
      config,
      {},
      0,
      1,
      { maxRetries: 0 },
    );
    assert.equal(denied.ok, false);
    assert.equal(
      operatorPhysicalStarts,
      startsBeforeDeniedCall,
      `${outcome.name} feedback must not permit a post-stop physical admission`,
    );
  }

  console.log("Scenario 10: operator stop wins recovery-probe and REST/SOAP admission races");
  operatorStopActive = false;
  operatorOwner = null;
  __protractorClientTestHooks.acquirePhysicalTransportLease = async () => {
    operatorOwner = `operator-probe-${++operatorSequence}`;
    operatorStopActive = true;
    return operatorOwner;
  };
  let recoveryRaceStarts = 0;
  __protractorClientTestHooks.httpsRequest = async () => {
    recoveryRaceStarts += 1;
    return { statusCode: 200, body: "{}" };
  };
  const recoveryRace = await protractorFetch(
    "/Invoice/operator-stop-probe-race",
    config,
    {},
    0,
    1,
    { maxRetries: 0 },
  );
  assert.equal(recoveryRace.ok, false);
  assert.equal(recoveryRaceStarts, 0, "activation before atomic dispatch must beat a claimed recovery probe");

  __protractorClientTestHooks.acquirePhysicalTransportLease = async () => null;
  const blockedFamilies = await Promise.all([
    protractorFetch("/Invoice/operator-stop-rest", config, {}, 0, 1, { maxRetries: 0 }),
    createServiceItem(1, { ownerId: "owner" }),
    soapAddServicePackage(1, "wo", { ID: "wo" }),
  ]);
  assert.ok(blockedFamilies.every(result => !result.ok));
  assert.equal(recoveryRaceStarts, 0, "active stop must block REST and both SOAP transport families");

  console.log("Scenario 11: real repository admission has REST/SOAP budget and expiry parity");
  let repositoryNow = new Date(Date.now() + 1_000);
  let repositorySequence = 0;
  const repositoryCollection = createMongoExpressionCollection({
    _id: "protractor-physical-transport-v1",
    count: 0,
    nextAllowedAt: new Date(0),
    leaseExpiresAt: new Date(0),
    operatorStop: {
      active: true,
      stopId: "repository-stop-0",
      reason: "test",
      changedBy: "test",
      activatedAt: repositoryNow,
      updatedAt: repositoryNow,
    },
  }, { now: () => repositoryNow });
  __protractorPhysicalTransportTestHooks.getDb = async () => ({
    collection: () => repositoryCollection,
  } as any);
  __protractorPhysicalTransportTestHooks.randomUUID = () =>
    `repository-${++repositorySequence}`;
  __protractorClientTestHooks.acquirePhysicalTransportLease =
    acquireProtractorPhysicalTransportLease;
  __protractorClientTestHooks.confirmPhysicalTransportLease =
    confirmProtractorPhysicalTransportLease;
  __protractorClientTestHooks.renewPhysicalTransportLease =
    renewProtractorPhysicalTransportLease;
  __protractorClientTestHooks.releasePhysicalTransportLease =
    releaseProtractorPhysicalTransportLease;
  __protractorClientTestHooks.acquireOutboundGate = async () => ({
    allowed: true,
    probe: false,
  });
  __protractorClientTestHooks.recordResponse = async () => {};
  __protractorClientTestHooks.trackApiRequest = async () => {};
  __protractorClientTestHooks.enforceFleetPacerWithMockTransport = true;
  __protractorClientTestHooks.httpsRequest = async url => ({
    statusCode: 200,
    body: url.endsWith("WorkOrderServices.asmx")
      ? "<WorkOrderUpdateResult>&lt;WorkOrder&gt;&lt;ServicePackage&gt;&lt;/ServicePackage&gt;&lt;/WorkOrder&gt;</WorkOrderUpdateResult>"
      : "{}",
  });

  const repositoryFamilies = [
    {
      name: "REST",
      send: () => protractorFetch(
        "/Invoice/repository-backed",
        config,
        {},
        0,
        1,
        { maxRetries: 0 },
      ),
    },
    {
      name: "SOAP ServiceItem",
      send: () => createServiceItem(1, { ownerId: "repository-owner" }),
    },
    {
      name: "SOAP WorkOrder",
      send: () => soapAddServicePackage(
        1,
        "repository-work-order",
        { ID: "repository-work-order", Type: "WorkOrder", ServicePackages: [] },
      ),
    },
  ];

  async function openRepositoryCanary(lifetimeMs: number): Promise<void> {
    const stopId = `repository-stop-${repositorySequence}`;
    repositoryCollection.row.operatorStop = {
      active: true,
      stopId,
      reason: "test",
      changedBy: "test",
      activatedAt: repositoryNow,
      updatedAt: repositoryNow,
    };
    delete repositoryCollection.row.ownerToken;
    delete repositoryCollection.row.ownerCanaryGeneration;
    delete repositoryCollection.row.physicalAdmissionOwnerToken;
    repositoryCollection.row.nextAllowedAt = new Date(0);
    repositoryCollection.row.leaseExpiresAt = new Date(0);
    await clearProtractorOperatorStop({
      changedBy: "test",
      reason: "repository-backed client parity",
      expectedStopId: stopId,
      expiresAt: new Date(repositoryNow.getTime() + lifetimeMs),
      maxAdmissions: 1,
      now: repositoryNow,
    });
  }

  for (const family of repositoryFamilies) {
    await openRepositoryCanary(60_000);
    let sends = 0;
    const transport = __protractorClientTestHooks.httpsRequest;
    __protractorClientTestHooks.httpsRequest = async (...args) => {
      sends += 1;
      return transport(...args);
    };
    assert.equal((await family.send()).ok, true, `${family.name} must consume its one admission`);
    assert.equal((await family.send()).ok, false, `${family.name} must be denied after budget`);
    assert.equal(sends, 1, `${family.name} budget denial must occur before physical transport`);
    assert.equal(repositoryCollection.row.canary.consumedAdmissions, 1);
    assert.equal(repositoryCollection.row.canary.endedBy, "budget");
    __protractorClientTestHooks.httpsRequest = transport;

    await openRepositoryCanary(10);
    repositoryNow = new Date(repositoryNow.getTime() + 11);
    sends = 0;
    __protractorClientTestHooks.httpsRequest = async (...args) => {
      sends += 1;
      return transport(...args);
    };
    assert.equal((await family.send()).ok, false, `${family.name} must honor canary expiry`);
    assert.equal(sends, 0, `${family.name} expiry must be enforced before transport`);
    assert.equal(repositoryCollection.row.canary.endedBy, "time");
    __protractorClientTestHooks.httpsRequest = transport;
    repositoryNow = new Date(repositoryNow.getTime() + 1_001);
  }

  console.log("All Protractor fleet-pacer checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});