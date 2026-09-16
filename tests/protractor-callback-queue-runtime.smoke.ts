/**
 * Offline runtime coverage for the Protractor callback queue and drain.
 *
 * The queue and drain modules are imported for real.  Every runtime sibling
 * they import is mocked before the import, so these checks exercise ownership,
 * fencing, and outcome propagation without a Mongo connection or provider
 * transport.
 *
 * Run: npx tsx tests/protractor-callback-queue-runtime.smoke.ts
 */

import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import Module from "node:module";

type CallbackEvent = {
  key: string;
  method: "GET" | "POST";
  shopId: number;
  objectType: string | null;
  objectId: string | null;
  operation: string | null;
  receivedAt: Date;
};

type Doc = Record<string, any>;

const originalLoad = (Module as any)._load;
const originalConsoleInfo = console.info;
const timingRecords: Array<Record<string, any>> = [];
const normalizationTimingRecords: Array<Record<string, any>> = [];
console.info = ((prefix: unknown, payload?: unknown, ...rest: unknown[]) => {
  if (prefix === "[ProtractorCallbackTiming]") {
    try {
      timingRecords.push(JSON.parse(String(payload)));
    } catch {
      throw new Error("callback timing telemetry was not valid JSON");
    }
    return;
  }
  if (prefix === "[ProtractorCallbackNormalizationTiming]") {
    try {
      normalizationTimingRecords.push(JSON.parse(String(payload)));
    } catch {
      throw new Error("normalization timing telemetry was not valid JSON");
    }
    return;
  }
  originalConsoleInfo(prefix, payload, ...rest);
}) as typeof console.info;

const pending: CallbackEvent[] = [];
const ownerTokens = new Map<string, string | null>();
const completionResults = new Map<string, boolean>();
const completionErrors = new Map<string, Error>();
const dispatchOutcomes = new Map<string, any>();
const dispatchErrors = new Map<string, Error>();
const transportErrors: Array<Error | undefined> = [];
const lateCompletionKeys = new Set<string>();
let clockOffsetMs = 0;
const originalDateNow = Date.now;

const dispatches: CallbackEvent[] = [];
const processingStarts: string[] = [];
const claims: Array<{ key: string; ownerToken: string | null }> = [];
const completionCalls: any[][] = [];
const processedMarks: Array<{ key: string; details: any }> = [];
const served: Array<{ shopId: number; key: string }> = [];
const releases: Array<{ key: string; ownerToken?: string }> = [];
const selectionCalls: any[][] = [];
const transportDeadlines: number[] = [];
const dispatchClockAdvances = new Map<string, number>();
const callbackOutcomeWrites: Array<{
  key: string;
  ownerToken: string;
  outcome: any;
}> = [];
const callbackDeferralWrites: Array<{
  key: string;
  ownerToken: string;
  outcome: any;
}> = [];
const errors: Array<{ key: string; message: string }> = [];
const attempts = new Map<string, number>();

const terminalApplications: Array<{ db: unknown; args: Doc }> = [];
const workOrderFetches: string[] = [];
const vehicleFetches: string[] = [];
const workOrderSnapshots: Array<{ shopId: number; workOrder: Doc }> = [];
const normalizedWorkOrders: Doc[] = [];
const normalizedEnterpriseIds: Array<string | undefined> = [];
const normalizationTimingRecorders: unknown[] = [];
const normalizationThrows = new Set<string>();
const indexCalls: Doc[] = [];
const vehicleReplayResults = new Map<string, any[]>();
const workOrderReplayResults = new Map<string, any[]>();
let drainSetupAdvanceMs = 0;
let selectionAdvanceMs = 0;

function event(
  key: string,
  objectId: string,
  operation = "Update",
): CallbackEvent {
  return {
    key,
    method: "GET",
    shopId: 42,
    objectType: "WorkOrder",
    objectId,
    operation,
    receivedAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

function terminalPostEvent(
  key: string,
  objectId: string,
  operation = "CLOSED",
): CallbackEvent {
  return {
    ...event(key, objectId, operation),
    method: "POST",
  };
}

function resetQueueState(events: CallbackEvent[]): void {
  pending.splice(0, pending.length, ...events);
  ownerTokens.clear();
  completionResults.clear();
  completionErrors.clear();
  dispatchOutcomes.clear();
  dispatchErrors.clear();
  transportErrors.splice(0, transportErrors.length);
  lateCompletionKeys.clear();
  clockOffsetMs = 0;
  dispatches.length = 0;
  processingStarts.length = 0;
  claims.length = 0;
  completionCalls.length = 0;
  processedMarks.length = 0;
  served.length = 0;
  releases.length = 0;
  selectionCalls.length = 0;
  transportDeadlines.length = 0;
  dispatchClockAdvances.clear();
  callbackOutcomeWrites.length = 0;
  callbackDeferralWrites.length = 0;
  errors.length = 0;
  attempts.clear();
  timingRecords.length = 0;
  normalizationTimingRecords.length = 0;
  normalizationTimingRecorders.length = 0;
  drainSetupAdvanceMs = 0;
  selectionAdvanceMs = 0;
}

const callbackEventsMock = {
  __esModule: true,
  findPendingGetEvents: async (...args: any[]) => {
    selectionCalls.push(args);
    if (selectionAdvanceMs) {
      clockOffsetMs += selectionAdvanceMs;
      selectionAdvanceMs = 0;
    }
    const requestedLimit = Number(args[2] ?? args[0] ?? pending.length);
    return pending.slice(0, requestedLimit);
  },
  filterPendingCallbackCandidatesByAuthority: async (items: CallbackEvent[]) => items,
  claimCallbackEvent: async (key: string) => {
    const ownerToken = ownerTokens.has(key) ? ownerTokens.get(key)! : null;
    claims.push({ key, ownerToken });
    return ownerToken;
  },
  recordProcessingStarted: async (key: string) => {
    processingStarts.push(key);
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
  },
  completeCallbackGeneration: async (...args: any[]) => {
    completionCalls.push(args);
    const thrown = completionErrors.get(String(args[0]));
    if (thrown) throw thrown;
    return completionResults.get(String(args[0])) ?? true;
  },
  markProcessed: async (key: string, details: any) => {
    processedMarks.push({ key, details });
  },
  markCallbackShopSuccessfullyServed: async (shopId: number, key: string) => {
    served.push({ shopId, key });
  },
  recordCallbackOutcome: async (key: string, ownerToken: string, outcome: any) => {
    callbackOutcomeWrites.push({ key, ownerToken, outcome });
  },
  recordCallbackDeferral: async (key: string, ownerToken: string, outcome: any) => {
    callbackDeferralWrites.push({ key, ownerToken, outcome });
    attempts.set(key, Math.max((attempts.get(key) ?? 0) - 1, 0));
  },
  recordError: async (key: string, message: string) => {
    errors.push({ key, message });
  },
  releaseCallbackEventAdmission: async (
    key: string,
    _identity: unknown,
    ownerToken?: string,
  ) => {
    releases.push({ key, ownerToken });
  },
  getCallbackQueueDb: async () => {
    if (drainSetupAdvanceMs) {
      clockOffsetMs += drainSetupAdvanceMs;
      drainSetupAdvanceMs = 0;
    }
    return queueDb;
  },
};

const clientMock = {
  __esModule: true,
  getEffectiveProtractorOutboundPolicy: async () => ({
    allowed: true,
    callbackNotBeforeMs: undefined,
    requireTimedTrial: false,
  }),
  runWithProtractorCallbackTransport: async (
    deadlineMs: number,
    callback: () => Promise<unknown>,
  ) => {
    transportDeadlines.push(deadlineMs);
    const transportError = transportErrors.shift();
    if (transportError) throw transportError;
    return callback();
  },
  fetchVehicleById: async (shopId: number, objectId: string) => {
    void shopId;
    vehicleFetches.push(objectId);
    const scripted = vehicleReplayResults.get(objectId);
    if (scripted?.length) return scripted.shift();
    return { ok: false, error: "unused" };
  },
  fetchWorkOrderById: async (shopId: number, objectId: string) => {
    void shopId;
    workOrderFetches.push(objectId);
    const scripted = workOrderReplayResults.get(objectId);
    if (scripted?.length) return scripted.shift();
    if (objectId === "wo-open") {
      return {
        ok: true,
        workOrder: {
          ID: objectId,
          WorkflowStage: "OPEN",
          Completed: false,
          ServiceItem: { VIN: "OPEN-VIN" },
        },
      };
    }
    if (objectId === "wo-missing-vin") {
      return {
        ok: true,
        workOrder: {
          ID: objectId,
          WorkflowStage: "CLOSED",
          Completed: true,
          ServiceItem: {},
        },
      };
    }
    throw new Error(`unexpected work order ${objectId}`);
  },
};

const queueDb = {
  collection: (name: string) => {
    if (name === "shops") {
      return {
        findOne: async () => {
          shopLookupCount++;
          return {
            enterpriseId: "enterprise-42",
            integrationProvider: "protractor",
          };
        },
      };
    }
    if (name === "protractor_work_orders") {
      return {
        findOne: async () => null,
        updateMany: async () => ({ modifiedCount: 1 }),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  },
};
let shopLookupCount = 0;

const integrationMock = {
  __esModule: true,
  fetchWorkOrderById: async (shopId: number, objectId: string, _options?: unknown) =>
    clientMock.fetchWorkOrderById(shopId, objectId),
  upsertProtractorVehicleSnapshot: async () => undefined,
  upsertProtractorWorkOrderSnapshot: async (shopId: number, workOrder: Doc) => {
    workOrderSnapshots.push({ shopId, workOrder });
  },
};

class MockNormalizedIngestionService {
  constructor(...args: any[]) {
    normalizedEnterpriseIds.push(args[3] as string | undefined);
    normalizationTimingRecorders.push(args[4]?.callbackNormalizationTiming);
  }

  async ingestWorkOrderWithAllEntities(workOrder: Doc): Promise<void> {
    normalizedWorkOrders.push(workOrder);
    if (normalizationThrows.has(String(workOrder.ID))) {
      throw new Error("normalization failure");
    }
  }
}

const terminalMock = {
  __esModule: true,
  applyProtractorTerminalCallback: async (db: unknown, args: Doc) => {
    terminalApplications.push({ db, args });
    const admitted = pending.find((item) => item.objectId === args.workOrderId);
    if (admitted) {
      const clockAdvance = dispatchClockAdvances.get(admitted.key);
      if (clockAdvance !== undefined) {
        clockOffsetMs += clockAdvance;
        dispatchClockAdvances.delete(admitted.key);
      }
    }
    return true;
  },
};

const historyIndexMock = {
  __esModule: true,
  indexCallbackHistory: async (...args: any[]) => {
    indexCalls.push({ args });
    return { category: "applied_indexed", reason: "indexed" };
  },
};

const shopEligibilityMock = {
  __esModule: true,
  isProtractorShopRecord: () => true,
};

const enterpriseMock = {
  __esModule: true,
  attributeRevenueFromWorkOrder: async () => ({ matched: 0 }),
};

const normalizedIngestionMock = {
  __esModule: true,
  NormalizedIngestionService: MockNormalizedIngestionService,
};

const outboundPolicyMock = {
  __esModule: true,
  logProtractorPolicyDenial: () => undefined,
};

const mocks = new Map<string, any>([
  ["@/lib/data/repositories/protractor-callback-events", callbackEventsMock],
  ["@/lib/integrations/protractor", integrationMock],
  ["@/lib/integrations/core/normalized-ingestion", normalizedIngestionMock],
  ["@/lib/enterprise", enterpriseMock],
  ["@/lib/integrations/protractor/shop-eligibility", shopEligibilityMock],
]);

(Module as any)._load = function (
  request: string,
  parent: any,
  ...rest: any[]
) {
  if (mocks.has(request)) return mocks.get(request);
  if (
    request === "./client" ||
    request.endsWith("/lib/integrations/protractor/client")
  ) return clientMock;
  if (request.endsWith("outbound-policy.cjs")) return outboundPolicyMock;
  if (request === "./callback-terminal" || request.endsWith("/callback-terminal")) {
    return terminalMock;
  }
  if (
    request === "./callback-history-index" ||
    request.endsWith("/callback-history-index")
  ) return historyIndexMock;
  return originalLoad.call(this, request, parent, ...rest);
};

const dispatch = async (item: CallbackEvent): Promise<any> => {
  dispatches.push(item);
  const thrown = dispatchErrors.get(item.key);
  if (thrown) throw thrown;
  if (lateCompletionKeys.has(item.key)) clockOffsetMs = 61_000;
  const clockAdvance = dispatchClockAdvances.get(item.key);
  if (clockAdvance !== undefined) clockOffsetMs += clockAdvance;
  return dispatchOutcomes.get(item.key);
};

Date.now = () => originalDateNow() + clockOffsetMs;

function queueOptions() {
  return {
    budgetMs: 60_000,
    isShopEligible: async () => true,
    acquireBudgetSlot: async () => true,
  };
}

async function runQueueAssertions(
  processProtractorCallbackQueue: (
    db: any,
    dispatch: (item: any) => Promise<any>,
    options: any,
  ) => Promise<{ processed: number; failed: number }>,
): Promise<void> {
  const applied = event("applied", "wo-applied");
  const appliedOutcome = {
    category: "applied_indexed",
    reason: "indexed",
    indexedJobs: 4,
    changedJobs: 2,
  };
  resetQueueState([applied]);
  ownerTokens.set(applied.key, "owner-applied");
  dispatchOutcomes.set(applied.key, appliedOutcome);

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, queueOptions()),
    { processed: 1, failed: 0 },
  );
  assert.equal(
    timingRecords.some((record) =>
      record.kind === "callback_stage_timing" &&
      record.stage === "total" &&
      record.outcome === "success"
    ),
    true,
    "successful callbacks emit a total timing outcome",
  );
  assert.equal(
    timingRecords.some((record) =>
      JSON.stringify(record).includes("wo-applied") ||
      JSON.stringify(record).includes("shop") ||
      JSON.stringify(record).includes("VIN")
    ),
    false,
    "callback timing telemetry contains no callback identity",
  );
  assert.equal(dispatches.length, 1, "claimed event is dispatched");
  assert.equal(completionCalls.length, 1);
  assert.equal(
    completionCalls[0][4],
    appliedOutcome,
    "dispatch applied_indexed outcome is forwarded as completion's fifth argument",
  );
  assert.equal(completionCalls[0][2], "owner-applied");
  assert.deepEqual(served, [{ shopId: 42, key: applied.key }]);
  assert.deepEqual(callbackOutcomeWrites, []);

  const indexingFailed = event("indexing-failed", "wo-indexing-failed");
  const failedOutcome = {
    category: "failed",
    reason: "indexing_failed",
  };
  resetQueueState([indexingFailed]);
  ownerTokens.set(indexingFailed.key, "owner-indexing-failed");
  dispatchOutcomes.set(indexingFailed.key, failedOutcome);

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, queueOptions()),
    { processed: 1, failed: 0 },
    "a returned noncritical indexing_failed outcome keeps historical completion semantics",
  );
  assert.equal(completionCalls.length, 1);
  assert.equal(completionCalls[0][4], failedOutcome);
  assert.deepEqual(
    served,
    [{ shopId: 42, key: indexingFailed.key }],
    "noncritical indexing failure still marks the callback generation served",
  );
  assert.deepEqual(callbackOutcomeWrites, []);
  assert.deepEqual(errors, []);
  assert.equal(attempts.get(indexingFailed.key), 1, "returned failures charge an attempt");

  const thrown = event("thrown", "wo-thrown");
  resetQueueState([thrown]);
  ownerTokens.set(thrown.key, "owner-thrown");
  dispatchErrors.set(thrown.key, new Error("provider dispatch exploded"));

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, queueOptions()),
    { processed: 0, failed: 1 },
  );
  assert.equal(
    timingRecords.some((record) =>
      record.kind === "callback_stage_timing" &&
      record.stage === "dispatch" &&
      record.outcome === "failed"
    ),
    true,
    "dispatch failures emit a failed dispatch timing outcome",
  );
  assert.equal(
    timingRecords.some((record) =>
      record.kind === "callback_stage_timing" &&
      record.stage === "total" &&
      record.outcome === "failed"
    ),
    true,
    "dispatch failures emit a failed total timing outcome",
  );
  assert.equal(
    timingRecords.some((record) => JSON.stringify(record).includes("provider dispatch exploded")),
    false,
    "timing telemetry does not include error text",
  );
  assert.deepEqual(
    callbackOutcomeWrites,
    [{
      key: thrown.key,
      ownerToken: "owner-thrown",
      outcome: { category: "failed", reason: "dispatch_failed" },
    }],
    "thrown dispatch writes fenced failure evidence with its owner token",
  );
  assert.deepEqual(
    errors,
    [{ key: thrown.key, message: "provider dispatch exploded" }],
    "thrown dispatch retains the legacy error record",
  );
  assert.deepEqual(served, []);
  assert.deepEqual(releases, [{ key: thrown.key, ownerToken: "owner-thrown" }]);

  const contact = event("contact", "contact-1");
  contact.objectType = "Contact";
  resetQueueState([contact]);
  ownerTokens.set(contact.key, "owner-contact");
  dispatchOutcomes.set(contact.key, {
    category: "applied_indexed",
    reason: "indexed",
  });

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, queueOptions()),
    { processed: 0, failed: 0 },
    "unsupported Contact callbacks are held without becoming failures",
  );
  assert.deepEqual(dispatches, [], "Contact callbacks are not dispatched");
  assert.deepEqual(processingStarts, [], "Contact callbacks do not increment attempts");
  assert.equal(attempts.get(contact.key) ?? 0, 0);
  assert.deepEqual(completionCalls, [], "Contact callbacks are not completed");
  assert.deepEqual(
    callbackOutcomeWrites,
    [{
      key: contact.key,
      ownerToken: "owner-contact",
      outcome: { category: "deferred", reason: "unsupported_contact" },
    }],
    "Contact deferral is fenced to its admission owner",
  );
  assert.deepEqual(callbackDeferralWrites, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(releases, [{ key: contact.key, ownerToken: "owner-contact" }]);

  const pacedExpiry = event("paced-expiry", "wo-paced-expiry");
  resetQueueState([pacedExpiry]);
  ownerTokens.set(pacedExpiry.key, "owner-paced-expiry");
  transportErrors.push(new Error("Protractor fleet transport pacer deadline expired"));

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, queueOptions()),
    { processed: 0, failed: 0 },
    "local pacing expiry defers rather than fails callback work",
  );
  assert.deepEqual(dispatches, [], "pacing expiry occurs before provider dispatch");
  assert.deepEqual(
    callbackDeferralWrites,
    [{
      key: pacedExpiry.key,
      ownerToken: "owner-paced-expiry",
      outcome: { category: "deferred", reason: "safety_boundary" },
    }],
    "exact local pacing message is classified as safety_boundary",
  );
  assert.deepEqual(callbackOutcomeWrites, []);
  assert.deepEqual(errors, []);
  assert.equal(attempts.get(pacedExpiry.key), 0, "safety-boundary deferral refunds the attempt");

  const canaryExpiry = event("canary-expiry", "wo-canary-expiry");
  resetQueueState([canaryExpiry]);
  ownerTokens.set(canaryExpiry.key, "owner-canary-expiry");
  transportErrors.push(new Error("callback transport blocked: callback_canary_expired"));

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, queueOptions()),
    { processed: 0, failed: 0 },
    "local callback-canary expiry while waiting defers rather than fails",
  );
  assert.deepEqual(dispatches, [], "callback-canary expiry occurs before provider dispatch");
  assert.deepEqual(
    callbackDeferralWrites,
    [{
      key: canaryExpiry.key,
      ownerToken: "owner-canary-expiry",
      outcome: { category: "deferred", reason: "safety_boundary" },
    }],
  );
  assert.deepEqual(callbackOutcomeWrites, []);
  assert.deepEqual(errors, []);
  assert.equal(attempts.get(canaryExpiry.key), 0);

  const genericDeadline = event("generic-deadline", "wo-generic-deadline");
  resetQueueState([genericDeadline]);
  ownerTokens.set(genericDeadline.key, "owner-generic-deadline");
  dispatchErrors.set(
    genericDeadline.key,
    new Error("provider transport deadline exceeded"),
  );

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, queueOptions()),
    { processed: 0, failed: 1 },
    "a provider transport deadline remains a genuine failure",
  );
  assert.deepEqual(callbackDeferralWrites, []);
  assert.deepEqual(
    callbackOutcomeWrites,
    [{
      key: genericDeadline.key,
      ownerToken: "owner-generic-deadline",
      outcome: { category: "failed", reason: "dispatch_failed" },
    }],
  );
  assert.deepEqual(
    errors,
    [{ key: genericDeadline.key, message: "provider transport deadline exceeded" }],
  );

  const late = event("late-success", "wo-late-success");
  const lateOutcome = {
    category: "applied_indexed",
    reason: "indexed",
    indexedJobs: 2,
    changedJobs: 1,
  };
  resetQueueState([late]);
  ownerTokens.set(late.key, "owner-late-success");
  lateCompletionKeys.add(late.key);
  dispatchOutcomes.set(late.key, lateOutcome);

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, queueOptions()),
    { processed: 1, failed: 0 },
    "successful work completing after the batch deadline still completes",
  );
  assert.equal(completionCalls[0][4], lateOutcome);
  assert.equal(completionCalls[0][2], "owner-late-success");
  assert.deepEqual(served, [{ shopId: 42, key: late.key }]);
  assert.deepEqual(callbackOutcomeWrites, []);
  assert.deepEqual(errors, []);

  const stale = event("stale", "wo-stale");
  const staleOutcome = {
    category: "applied_indexed",
    reason: "indexed",
    indexedJobs: 1,
    changedJobs: 1,
  };
  resetQueueState([stale]);
  ownerTokens.set(stale.key, "owner-stale");
  completionResults.set(stale.key, false);
  dispatchOutcomes.set(stale.key, staleOutcome);

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, queueOptions()),
    { processed: 0, failed: 1 },
  );
  assert.equal(completionCalls[0][4], staleOutcome);
  assert.deepEqual(served, [], "stale completion cannot mark the shop successfully served");
  assert.deepEqual(
    callbackOutcomeWrites,
    [{
      key: stale.key,
      ownerToken: "owner-stale",
      outcome: staleOutcome,
    }],
    "stale completion retains the real returned evidence under its owner fence",
  );
  assert.deepEqual(
    errors,
    [{ key: stale.key, message: "Callback completion fence rejected stale owner" }],
  );

  const persistenceError = event("persistence-error", "wo-persistence-error");
  const persistenceOutcome = {
    category: "applied_indexed",
    reason: "indexed",
    indexedJobs: 3,
    changedJobs: 3,
  };
  resetQueueState([persistenceError]);
  ownerTokens.set(persistenceError.key, "owner-persistence-error");
  dispatchOutcomes.set(persistenceError.key, persistenceOutcome);
  completionErrors.set(
    persistenceError.key,
    new Error("callback history persistence unavailable"),
  );

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, queueOptions()),
    { processed: 0, failed: 1 },
    "persistence errors leave the callback pending",
  );
  assert.deepEqual(
    callbackOutcomeWrites,
    [{
      key: persistenceError.key,
      ownerToken: "owner-persistence-error",
      outcome: persistenceOutcome,
    }],
    "persistence failure retains returned real evidence",
  );
  assert.deepEqual(
    errors,
    [{
      key: persistenceError.key,
      message: "callback history persistence unavailable",
    }],
  );
  assert.deepEqual(served, []);

  const unclaimed = event("unclaimed", "wo-unclaimed");
  resetQueueState([unclaimed]);
  ownerTokens.set(unclaimed.key, null);
  dispatchOutcomes.set(unclaimed.key, {
    category: "applied_indexed",
    reason: "indexed",
  });

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, queueOptions()),
    { processed: 0, failed: 0 },
  );
  assert.deepEqual(dispatches, [], "an event without an admission owner is not dispatched");
  assert.deepEqual(processingStarts, []);
  assert.deepEqual(completionCalls, []);
  assert.deepEqual(served, []);
  assert.deepEqual(releases, []);
}

async function runPreAdmissionDeadlineAssertions(
  processProtractorCallbackQueue: (
    db: any,
    dispatch: (item: any) => Promise<any>,
    options: any,
  ) => Promise<{ processed: number; failed: number }>,
): Promise<void> {
  const assertUnclaimed = (key: string, label: string): void => {
    assert.deepEqual(dispatches, [], `${label}: no dispatch`);
    assert.deepEqual(claims, [], `${label}: no claim`);
    assert.deepEqual(processedMarks, [], `${label}: no markProcessed`);
    assert.deepEqual(processingStarts, [], `${label}: no processing attempt`);
    assert.equal(attempts.get(key) ?? 0, 0, `${label}: no attempt charge`);
    assert.deepEqual(releases, [], `${label}: no admission release`);
    assert.deepEqual(completionCalls, [], `${label}: no completion`);
    assert.deepEqual(served, [], `${label}: no served mutation`);
  };

  const lateAcquire = event(
    "late-budget-acquire",
    "wo-late-budget-acquire",
    "DELETE",
  );
  resetQueueState([lateAcquire]);
  const lateAcquireDeadline = Date.now() + 10_000;
  let lateAcquireEligibilityCalls = 0;

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, {
      ...queueOptions(),
      deadlineAtMs: lateAcquireDeadline,
      isShopEligible: async () => {
        lateAcquireEligibilityCalls++;
        return true;
      },
      acquireBudgetSlot: async () => {
        clockOffsetMs += 10_001;
        return true;
      },
    }),
    { processed: 0, failed: 0 },
    "late budget-slot wait exits at the absolute deadline",
  );
  assert.equal(
    lateAcquireEligibilityCalls,
    0,
    "late budget-slot wait does not reach eligibility",
  );
  assertUnclaimed(lateAcquire.key, "late budget-slot wait");
  assert.equal(
    timingRecords.some(
      (record) => record.kind === "callback_batch_timing" &&
        record.exitReason === "deadline",
    ),
    true,
    "late budget-slot wait records a deadline exit",
  );

  const lateEligibility = event(
    "late-eligibility",
    "wo-late-eligibility",
    "DELETE",
  );
  resetQueueState([lateEligibility]);
  const lateEligibilityDeadline = Date.now() + 10_000;

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, {
      ...queueOptions(),
      deadlineAtMs: lateEligibilityDeadline,
      isShopEligible: async () => {
        clockOffsetMs += 10_001;
        return false;
      },
      acquireBudgetSlot: async () => true,
    }),
    { processed: 0, failed: 0 },
    "late ineligible-shop wait exits at the absolute deadline",
  );
  assertUnclaimed(lateEligibility.key, "late eligibility wait");
  assert.equal(
    timingRecords.some(
      (record) => record.kind === "callback_batch_timing" &&
        record.exitReason === "deadline",
    ),
    true,
    "late eligibility wait records a deadline exit",
  );
}

async function runDrainDeadlineAssertions(
  processProtractorCallbackDrain: (
    db: any,
    options?: { budgetMs?: number },
  ) => Promise<{ processed: number; failed: number }>,
): Promise<void> {
  const admission = event("default-admission", "wo-default-admission", "DELETE");
  resetQueueState([admission]);
  ownerTokens.set(admission.key, "owner-default-admission");

  const defaultInvocationStartedAt = Date.now();
  assert.deepEqual(
    await processProtractorCallbackDrain(queueDb),
    { processed: 1, failed: 0 },
  );
  const defaultDeadline = transportDeadlines[0];
  assert.ok(defaultDeadline, "default drain passes an admission deadline to transport");
  assert.ok(
    defaultDeadline - defaultInvocationStartedAt >= 29_500 &&
      defaultDeadline - defaultInvocationStartedAt < 31_000,
    "default drain admission deadline stays near 30 seconds from invocation",
  );
  const defaultSelection = selectionCalls[0];
  assert.equal(defaultSelection?.[1], 3, "drain keeps the callback max-attempt limit");
  assert.equal(defaultSelection?.[2], 45, "drain keeps the bounded selection limit");

  const setupAndSelection = event(
    "default-setup-selection-budget",
    "wo-default-setup-selection-budget",
    "DELETE",
  );
  resetQueueState([setupAndSelection]);
  ownerTokens.set(setupAndSelection.key, "owner-default-setup-selection-budget");
  drainSetupAdvanceMs = 20_000;
  selectionAdvanceMs = 10_001;

  assert.deepEqual(
    await processProtractorCallbackDrain(undefined),
    { processed: 0, failed: 0 },
    "default drain charges database setup and selection against its invocation budget",
  );
  assert.deepEqual(dispatches, [], "an exhausted default budget admits no callback");
  assert.deepEqual(processingStarts, [], "an exhausted default budget starts no callback");
  assert.deepEqual(completionCalls, [], "an unadmitted callback has no completion");

  const admitted = event("admitted-before-deadline", "wo-admitted-before-deadline", "DELETE");
  const notAdmitted = event("after-deadline", "wo-after-deadline", "DELETE");
  resetQueueState([admitted, notAdmitted]);
  ownerTokens.set(admitted.key, "owner-admitted-before-deadline");
  ownerTokens.set(notAdmitted.key, "owner-after-deadline");
  dispatchClockAdvances.set(admitted.key, 30_001);
  terminalApplications.length = 0;

  assert.deepEqual(
    await processProtractorCallbackDrain(queueDb),
    { processed: 1, failed: 0 },
    "admitted callback completion remains durable after the deadline",
  );
  assert.deepEqual(
    processingStarts,
    [admitted.key],
    "deadline exhaustion stops the next dispatch",
  );
  assert.deepEqual(
    terminalApplications.map(({ args }) => args.workOrderId),
    [admitted.objectId],
    "deadline exhaustion stops the next provider replay",
  );
  assert.deepEqual(
    completionCalls.map((args) => args[0]),
    [admitted.key],
    "the callback admitted before exhaustion still completes",
  );
  assert.ok(
    Date.now() >= transportDeadlines[0],
    "the admitted completion runs after the admission deadline",
  );

  const explicit = event(
    "explicit-relative-budget",
    "wo-explicit-relative-budget",
    "DELETE",
  );
  resetQueueState([explicit]);
  ownerTokens.set(explicit.key, "owner-explicit-relative-budget");
  drainSetupAdvanceMs = 20_000;
  selectionAdvanceMs = 10_001;
  const explicitInvocationStartedAt = Date.now();

  assert.deepEqual(
    await processProtractorCallbackDrain(undefined, { budgetMs: 60_000 }),
    { processed: 1, failed: 0 },
    "explicit 60-second drain budgets retain relative deadline semantics",
  );
  assert.ok(
    transportDeadlines[0] - explicitInvocationStartedAt >= 89_000,
    "explicit budget starts after setup and selection rather than invocation",
  );
}

async function runDrainAssertions(
  processProtractorCallbackDrain: (
    db: any,
    options?: { budgetMs?: number },
  ) => Promise<{ processed: number; failed: number }>,
): Promise<void> {
  const terminal = event("terminal", "wo-terminal", "DELETE");
  const open = event("open", "wo-open", "Update");
  const missingVin = event("missing-vin", "wo-missing-vin", "Update");
  const vehicleMissingData = event("vehicle-missing-data", "vehicle-missing-data", "Update");
  vehicleMissingData.objectType = "ServiceItem";
  const vehicleMissingVin = event("vehicle-missing-vin", "vehicle-missing-vin", "Update");
  vehicleMissingVin.objectType = "ServiceItem";

  workOrderReplayResults.set(missingVin.objectId!, [
    {
      ok: true,
      workOrder: {
        ID: missingVin.objectId,
        WorkflowStage: "CLOSED",
        Completed: true,
        ServiceItem: {},
      },
    },
    {
      ok: true,
      workOrder: {
        ID: missingVin.objectId,
        WorkflowStage: "CLOSED",
        Completed: true,
        ServiceItem: { VIN: "REPLAYED-VIN" },
      },
    },
  ]);
  vehicleReplayResults.set(vehicleMissingData.objectId!, [
    { ok: false, error: "missing data" },
    { ok: true, vehicle: { VIN: "VEHICLE-REPLAYED-VIN" } },
  ]);
  vehicleReplayResults.set(vehicleMissingVin.objectId!, [
    { ok: true, vehicle: { Make: "NoVin" } },
    { ok: true, vehicle: { VIN: "VIN-REPLAYED" } },
  ]);

  resetQueueState([
    terminal,
    open,
    missingVin,
    vehicleMissingData,
    vehicleMissingVin,
  ]);
  ownerTokens.set(terminal.key, "owner-terminal");
  ownerTokens.set(open.key, "owner-open");
  ownerTokens.set(missingVin.key, "owner-missing-vin");
  ownerTokens.set(vehicleMissingData.key, "owner-vehicle-missing-data");
  ownerTokens.set(vehicleMissingVin.key, "owner-vehicle-missing-vin");
  terminalApplications.length = 0;
  workOrderFetches.length = 0;
  vehicleFetches.length = 0;
  workOrderSnapshots.length = 0;
  normalizedWorkOrders.length = 0;
  normalizedEnterpriseIds.length = 0;
  indexCalls.length = 0;
  shopLookupCount = 0;

  assert.deepEqual(
    await processProtractorCallbackDrain(queueDb, { budgetMs: 60_000 }),
    { processed: 3, failed: 2 },
  );

  const outcomes = new Map(
    completionCalls.map((args) => [String(args[0]), args[4]]),
  );
  assert.deepEqual(outcomes.get(terminal.key), {
    category: "terminal_no_history",
    reason: "terminal_applied",
  });
  assert.deepEqual(outcomes.get(open.key), {
    category: "terminal_no_history",
    reason: "open_work_order",
  });
  assert.deepEqual(outcomes.get(missingVin.key), {
    category: "failed",
    reason: "missing_vin",
  });
  assert.equal(outcomes.has(vehicleMissingData.key), false, "missing vehicle data does not complete");
  assert.equal(outcomes.has(vehicleMissingVin.key), false, "vehicle missing VIN does not complete");
  assert.equal(terminalApplications.length, 1, "terminal DELETE uses terminal application");
  assert.deepEqual(terminalApplications[0].args, {
    shopId: 42,
    workOrderId: "wo-terminal",
    status: "Deleted",
  });
  assert.deepEqual(
    workOrderFetches.sort(),
    ["wo-missing-vin", "wo-open"],
    "open and completed callback branches perform their mocked work-order reads",
  );
  assert.deepEqual(
    vehicleFetches.sort(),
    ["vehicle-missing-data", "vehicle-missing-vin"],
  );
  assert.equal(workOrderSnapshots.length, 2);
  assert.equal(normalizedWorkOrders.length, 2);
  assert.equal(
    normalizationTimingRecorders.length,
    2,
    "the drain passes one normalization recorder to each work-order normalization",
  );
  assert(
    normalizationTimingRecorders.every(Boolean),
    "normalization recorder ownership is runtime-visible, not source-only",
  );
  assert.equal(
    normalizationTimingRecords.length,
    2,
    "normalization timing finalizes for every completed normalization path",
  );
  assert(
    normalizationTimingRecords.every(
      (record) => record.kind === "callback_normalization_timing" &&
        record.outcome === "success",
    ),
    "successful callback normalizations emit finalized summaries",
  );
  assert.deepEqual(
    normalizedEnterpriseIds,
    ["enterprise-42", "enterprise-42"],
    "normalization reuses enterprise metadata from the eligibility lookup",
  );
  assert.equal(
    shopLookupCount,
    5,
    "each selected callback performs one eligibility lookup, not a second normalization lookup",
  );
  assert.deepEqual(indexCalls, [], "failed and open branches do not claim indexed evidence");
  assert.deepEqual(
    new Map(callbackOutcomeWrites.map((write) => [write.key, write.outcome])),
    new Map([
      [vehicleMissingData.key, { category: "failed", reason: "dispatch_failed" }],
      [vehicleMissingVin.key, { category: "failed", reason: "missing_vin" }],
    ]),
    "failed replay outcomes stay pending with bounded evidence",
  );
  assert.deepEqual(
    new Map(errors.map((entry) => [entry.key, entry.message])),
    new Map([
      [vehicleMissingData.key, "Vehicle callback replay failed: missing data"],
      [vehicleMissingVin.key, "Callback replay failed: missing_vin"],
    ]),
  );
  assert.deepEqual(
    served.map(({ key }) => key).sort(),
    [terminal.key, open.key, missingVin.key].sort(),
    "historical noncritical failure completion still marks work served",
  );

  const normalizationFailure = event(
    "normalization-failure",
    "wo-normalization-failure",
    "Update",
  );
  resetQueueState([normalizationFailure]);
  ownerTokens.set(normalizationFailure.key, "owner-normalization-failure");
  workOrderReplayResults.set(normalizationFailure.objectId!, [{
    ok: true,
    workOrder: {
      ID: normalizationFailure.objectId,
      WorkflowStage: "CLOSED",
      Completed: true,
      ServiceItem: { VIN: "NORMALIZATION-FAILURE-VIN" },
    },
  }]);
  normalizationThrows.add(normalizationFailure.objectId!);
  assert.deepEqual(
    await processProtractorCallbackDrain(queueDb, { budgetMs: 60_000 }),
    { processed: 1, failed: 0 },
    "normalization exceptions remain isolated from callback completion",
  );
  normalizationThrows.delete(normalizationFailure.objectId!);
  assert.equal(normalizationTimingRecords.length, 1);
  assert.equal(normalizationTimingRecords[0]?.outcome, "failed");

  resetQueueState([vehicleMissingData, vehicleMissingVin]);
  ownerTokens.set(vehicleMissingData.key, "owner-vehicle-missing-data-replay");
  ownerTokens.set(vehicleMissingVin.key, "owner-vehicle-missing-vin-replay");
  terminalApplications.length = 0;
  workOrderFetches.length = 0;
  vehicleFetches.length = 0;
  workOrderSnapshots.length = 0;
  normalizedWorkOrders.length = 0;
  normalizedEnterpriseIds.length = 0;
  indexCalls.length = 0;
  shopLookupCount = 0;

  assert.deepEqual(
    await processProtractorCallbackDrain(queueDb, { budgetMs: 60_000 }),
    { processed: 2, failed: 0 },
    "failed vehicle and missing-VIN callbacks replay successfully later",
  );
  const replayOutcomes = new Map(
    completionCalls.map((args) => [String(args[0]), args[4]]),
  );
  assert.deepEqual(replayOutcomes.get(vehicleMissingData.key), {
    category: "terminal_no_history",
    reason: "vehicle_snapshot",
  });
  assert.deepEqual(replayOutcomes.get(vehicleMissingVin.key), {
    category: "terminal_no_history",
    reason: "vehicle_snapshot",
  });
  assert.equal(workOrderSnapshots.length, 0);
  assert.equal(normalizedWorkOrders.length, 0);
  assert.deepEqual(normalizedEnterpriseIds, []);
  assert.deepEqual(indexCalls, []);
  assert.deepEqual(
    vehicleFetches.sort(),
    ["vehicle-missing-data", "vehicle-missing-vin"],
  );
  assert.equal(shopLookupCount, 2, "replay retries still perform one eligibility lookup per callback");
  assert.deepEqual(callbackOutcomeWrites, []);
  assert.deepEqual(callbackDeferralWrites, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    served.map(({ key }) => key).sort(),
    [vehicleMissingData.key, vehicleMissingVin.key].sort(),
  );
}

async function runTerminalPostAssertions(
  processProtractorCallbackDrain: (
    db: any,
    options?: { budgetMs?: number },
  ) => Promise<{ processed: number; failed: number }>,
): Promise<void> {
  const safetyExpiry = terminalPostEvent(
    "terminal-post-safety-expiry",
    "wo-terminal-post-safety-expiry",
  );
  resetQueueState([safetyExpiry]);
  ownerTokens.set(safetyExpiry.key, "owner-terminal-post-safety-expiry");
  workOrderReplayResults.set(safetyExpiry.objectId!, [
    { ok: false, error: "callback transport blocked: callback_canary_expired" },
  ]);
  workOrderFetches.length = 0;
  terminalApplications.length = 0;
  workOrderSnapshots.length = 0;

  assert.deepEqual(
    await processProtractorCallbackDrain(queueDb, { budgetMs: 60_000 }),
    { processed: 0, failed: 0 },
    "terminal POST local safety expiry remains deferred",
  );
  assert.equal(attempts.get(safetyExpiry.key), 0, "safety expiry does not charge an attempt");
  assert.deepEqual(workOrderFetches, [safetyExpiry.objectId]);
  assert.deepEqual(terminalApplications, []);
  assert.deepEqual(workOrderSnapshots, []);
  assert.deepEqual(
    callbackDeferralWrites,
    [{
      key: safetyExpiry.key,
      ownerToken: "owner-terminal-post-safety-expiry",
      outcome: { category: "deferred", reason: "safety_boundary" },
    }],
  );
  assert.deepEqual(callbackOutcomeWrites, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(completionCalls, []);

  const providerFailure = terminalPostEvent(
    "terminal-post-provider-failure",
    "wo-terminal-post-provider-failure",
  );
  resetQueueState([providerFailure]);
  ownerTokens.set(providerFailure.key, "owner-terminal-post-provider-failure");
  workOrderReplayResults.set(providerFailure.objectId!, [
    { ok: false, error: "provider unavailable" },
  ]);
  workOrderFetches.length = 0;

  assert.deepEqual(
    await processProtractorCallbackDrain(queueDb, { budgetMs: 60_000 }),
    { processed: 0, failed: 1 },
    "terminal POST provider failures remain replayable",
  );
  assert.equal(attempts.get(providerFailure.key), 1);
  assert.deepEqual(workOrderFetches, [providerFailure.objectId]);
  assert.deepEqual(completionCalls, []);
  assert.deepEqual(
    callbackOutcomeWrites,
    [{
      key: providerFailure.key,
      ownerToken: "owner-terminal-post-provider-failure",
      outcome: { category: "failed", reason: "dispatch_failed" },
    }],
  );
  assert.deepEqual(
    errors,
    [{
      key: providerFailure.key,
      message: "Work-order callback replay failed: provider unavailable",
    }],
    "real callback-replay context reaches queue error evidence",
  );

  const success = terminalPostEvent(
    "terminal-post-success",
    "wo-terminal-post-success",
  );
  const successWorkOrder = {
    ID: success.objectId,
    WorkflowStage: "CLOSED",
    Completed: true,
    ServiceItem: { VIN: "TERMINAL-POST-VIN" },
  };
  resetQueueState([success]);
  ownerTokens.set(success.key, "owner-terminal-post-success");
  workOrderReplayResults.set(success.objectId!, [
    { ok: true, workOrder: successWorkOrder },
  ]);
  workOrderFetches.length = 0;
  terminalApplications.length = 0;
  workOrderSnapshots.length = 0;

  assert.deepEqual(
    await processProtractorCallbackDrain(queueDb, { budgetMs: 60_000 }),
    { processed: 1, failed: 0 },
    "terminal POST success completes through the real replay helper",
  );
  assert.equal(attempts.get(success.key), 1);
  assert.deepEqual(workOrderFetches, [success.objectId]);
  assert.deepEqual(workOrderSnapshots, [{
    shopId: 42,
    workOrder: successWorkOrder,
  }]);
  assert.deepEqual(terminalApplications, [{
    db: queueDb,
    args: {
      shopId: 42,
      workOrderId: success.objectId,
      status: success.operation,
    },
  }]);
  assert.deepEqual(
    new Map(completionCalls.map((args) => [String(args[0]), args[4]])),
    new Map([[
      success.key,
      { category: "terminal_no_history", reason: "terminal_applied" },
    ]]),
  );
  assert.deepEqual(callbackOutcomeWrites, []);
  assert.deepEqual(callbackDeferralWrites, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    served,
    [{ shopId: 42, key: success.key }],
  );
}

async function main(): Promise<void> {
  const { processProtractorCallbackQueue } = await import(
    "../lib/integrations/protractor/callback-queue"
  );
  const { processProtractorCallbackDrain } = await import(
    "../lib/integrations/protractor/callback-drain"
  );

  try {
    await runQueueAssertions(processProtractorCallbackQueue);
    await runPreAdmissionDeadlineAssertions(processProtractorCallbackQueue);
    await runDrainDeadlineAssertions(processProtractorCallbackDrain);
    await runDrainAssertions(processProtractorCallbackDrain);
    await runTerminalPostAssertions(processProtractorCallbackDrain);
  } finally {
    Date.now = originalDateNow;
    console.info = originalConsoleInfo;
  }
  console.log("protractor callback queue runtime: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});