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

const pending: CallbackEvent[] = [];
const ownerTokens = new Map<string, string | null>();
const completionResults = new Map<string, boolean>();
const dispatchOutcomes = new Map<string, any>();
const dispatchErrors = new Map<string, Error>();

const dispatches: CallbackEvent[] = [];
const processingStarts: string[] = [];
const claims: Array<{ key: string; ownerToken: string | null }> = [];
const completionCalls: any[][] = [];
const served: Array<{ shopId: number; key: string }> = [];
const releases: Array<{ key: string; ownerToken?: string }> = [];
const callbackOutcomeWrites: Array<{
  key: string;
  ownerToken: string;
  outcome: any;
}> = [];
const errors: Array<{ key: string; message: string }> = [];

const terminalApplications: Array<{ db: unknown; args: Doc }> = [];
const workOrderFetches: string[] = [];
const workOrderSnapshots: Array<{ shopId: number; workOrder: Doc }> = [];
const normalizedWorkOrders: Doc[] = [];
const indexCalls: Doc[] = [];

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

function resetQueueState(events: CallbackEvent[]): void {
  pending.splice(0, pending.length, ...events);
  ownerTokens.clear();
  completionResults.clear();
  dispatchOutcomes.clear();
  dispatchErrors.clear();
  dispatches.length = 0;
  processingStarts.length = 0;
  claims.length = 0;
  completionCalls.length = 0;
  served.length = 0;
  releases.length = 0;
  callbackOutcomeWrites.length = 0;
  errors.length = 0;
}

const callbackEventsMock = {
  __esModule: true,
  findPendingGetEvents: async (...args: any[]) => {
    const requestedLimit = Number(args[2] ?? args[0] ?? pending.length);
    return pending.slice(0, requestedLimit);
  },
  claimCallbackEvent: async (key: string) => {
    const ownerToken = ownerTokens.has(key) ? ownerTokens.get(key)! : null;
    claims.push({ key, ownerToken });
    return ownerToken;
  },
  recordProcessingStarted: async (key: string) => {
    processingStarts.push(key);
  },
  completeCallbackGeneration: async (...args: any[]) => {
    completionCalls.push(args);
    return completionResults.get(String(args[0])) ?? true;
  },
  markCallbackShopSuccessfullyServed: async (shopId: number, key: string) => {
    served.push({ shopId, key });
  },
  recordCallbackOutcome: async (key: string, ownerToken: string, outcome: any) => {
    callbackOutcomeWrites.push({ key, ownerToken, outcome });
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
  getCallbackQueueDb: async () => queueDb,
};

const clientMock = {
  __esModule: true,
  getEffectiveProtractorOutboundPolicy: async () => ({
    allowed: true,
    callbackNotBeforeMs: undefined,
    requireTimedTrial: false,
  }),
  runWithProtractorCallbackTransport: async (
    _deadlineMs: number,
    callback: () => Promise<unknown>,
  ) => callback(),
  fetchVehicleById: async () => ({ ok: false, error: "unused" }),
  fetchWorkOrderById: async (shopId: number, objectId: string) => {
    void shopId;
    workOrderFetches.push(objectId);
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
        findOne: async () => ({
          enterpriseId: "enterprise-42",
          integrationProvider: "protractor",
        }),
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

const integrationMock = {
  __esModule: true,
  upsertProtractorVehicleSnapshot: async () => undefined,
  upsertProtractorWorkOrderSnapshot: async (shopId: number, workOrder: Doc) => {
    workOrderSnapshots.push({ shopId, workOrder });
  },
};

class MockNormalizedIngestionService {
  constructor(..._args: any[]) {}

  async ingestWorkOrderWithAllEntities(workOrder: Doc): Promise<void> {
    normalizedWorkOrders.push(workOrder);
  }
}

const terminalMock = {
  __esModule: true,
  applyProtractorTerminalCallback: async (db: unknown, args: Doc) => {
    terminalApplications.push({ db, args });
    return true;
  },
};

const replayMock = {
  __esModule: true,
  CALLBACK_REPLAY_FETCH_OPTIONS: { timeoutMs: 8_000, maxRetries: 0 },
  replayDeferredTerminalPost: async () => true,
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
  if (request === "./callback-replay" || request.endsWith("/callback-replay")) {
    return replayMock;
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
  return dispatchOutcomes.get(item.key);
};

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
    "a returned failed/indexing_failed outcome still completes the queue event",
  );
  assert.equal(
    completionCalls[0][4],
    failedOutcome,
    "failed indexing evidence is forwarded unchanged",
  );
  assert.deepEqual(served, [{ shopId: 42, key: indexingFailed.key }]);
  assert.deepEqual(callbackOutcomeWrites, []);
  assert.deepEqual(errors, []);

  const thrown = event("thrown", "wo-thrown");
  resetQueueState([thrown]);
  ownerTokens.set(thrown.key, "owner-thrown");
  dispatchErrors.set(thrown.key, new Error("provider dispatch exploded"));

  assert.deepEqual(
    await processProtractorCallbackQueue({}, dispatch, queueOptions()),
    { processed: 0, failed: 1 },
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
      outcome: { category: "failed", reason: "dispatch_failed" },
    }],
    "stale completion failure is fenced to the stale owner",
  );
  assert.deepEqual(
    errors,
    [{ key: stale.key, message: "Callback completion fence rejected stale owner" }],
  );

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

async function runDrainAssertions(
  processProtractorCallbackDrain: (
    db: any,
    options?: { budgetMs?: number },
  ) => Promise<{ processed: number; failed: number }>,
): Promise<void> {
  const terminal = event("terminal", "wo-terminal", "DELETE");
  const open = event("open", "wo-open", "Update");
  const missingVin = event("missing-vin", "wo-missing-vin", "Update");
  resetQueueState([terminal, open, missingVin]);
  ownerTokens.set(terminal.key, "owner-terminal");
  ownerTokens.set(open.key, "owner-open");
  ownerTokens.set(missingVin.key, "owner-missing-vin");
  terminalApplications.length = 0;
  workOrderFetches.length = 0;
  workOrderSnapshots.length = 0;
  normalizedWorkOrders.length = 0;
  indexCalls.length = 0;

  assert.deepEqual(
    await processProtractorCallbackDrain(queueDb, { budgetMs: 60_000 }),
    { processed: 3, failed: 0 },
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
  assert.equal(workOrderSnapshots.length, 2);
  assert.equal(normalizedWorkOrders.length, 2);
  assert.deepEqual(indexCalls, [], "open and missing-VIN branches do not claim indexed evidence");
  assert.deepEqual(callbackOutcomeWrites, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    served.map(({ key }) => key).sort(),
    [terminal.key, open.key, missingVin.key].sort(),
    "a successfully fenced failed outcome is still marked served",
  );
}

async function main(): Promise<void> {
  const { processProtractorCallbackQueue } = await import(
    "../lib/integrations/protractor/callback-queue"
  );
  const { processProtractorCallbackDrain } = await import(
    "../lib/integrations/protractor/callback-drain"
  );

  await runQueueAssertions(processProtractorCallbackQueue);
  await runDrainAssertions(processProtractorCallbackDrain);
  console.log("protractor callback queue runtime: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});