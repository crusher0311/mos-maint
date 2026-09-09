import assert from "node:assert/strict";
import Module from "node:module";
import { ObjectId } from "mongodb";
import { NextRequest } from "next/server";

type Doc = Record<string, any>;
const events: Doc[] = [];
const admissions = new Map<string, string>();
const admissionTokens = new Map<string, string>();
let releases = 0;
let providerFetches = 0;
const pgInserts: Doc[] = [];
const pgRows: Doc[] = [];
let pgAdmissions = 0;
let pgReleases = 0;
let callbackAggregateCalls = 0;
let lastCallbackFindFilter: Doc | null = null;
let lastCallbackFindOptions: Doc | null = null;
let lastCallbackFindSort: Doc | null = null;
let lastCallbackFindLimit: number | null = null;

function matches(doc: Doc, filter: Doc): boolean {
  if (filter._id instanceof ObjectId) return String(doc._id) === String(filter._id);
  if (filter.eventKey) return doc.eventKey === filter.eventKey;
  if (filter.workOrderId) return doc.workOrderId === filter.workOrderId &&
    (filter.status === undefined || doc.status === filter.status) &&
    (filter.processed === undefined || doc.processed === filter.processed);
  return true;
}

const workOrder: Doc = { workOrderGuid: "wo-terminal", shopId: 42, status: "OPEN" };
const vehicle: Doc = {
  _id: new ObjectId(),
  shopId: 42,
  status: {
    active: true,
    sources: [
      { provider: "protractor", workOrderId: "wo-terminal" },
      { provider: "other", workOrderId: "other" },
    ],
  },
};
const collections: Record<string, any> = {
  protractor_callback_fairness: {
    states: new Map<number, Doc>(),
    find: (filter: Doc) => ({
      async toArray() {
        return [...collections.protractor_callback_fairness.states.values()]
          .filter((state) => filter._id?.$in?.includes(state._id));
      },
    }),
    async updateOne(filter: Doc, update: any) {
      const current = this.states.get(Number(filter._id)) || { _id: filter._id };
      const set = Array.isArray(update) ? update[0].$set : update.$set;
      this.states.set(Number(filter._id), {
        ...current,
        ...set,
        lastSuccessfullyServedAt: new Date(),
      });
      return { matchedCount: 1 };
    },
  },
  shops: {
    findOne: async () => ({
      shopId: 42,
      integrationProvider: "protractor",
      protractor: { connectionId: "conn-42", apiKey: "key-42" },
    }),
  },
  protractor_callback_events: {
    insertOne: async (doc: Doc) => {
      const stored = { _id: new ObjectId(), ...doc };
      events.push(stored);
      return { insertedId: stored._id };
    },
    findOne: async (filter: Doc) => events.find((event) => matches(event, filter)) || null,
    countDocuments: async () => 0,
    find: (filter: Doc = {}, options: Doc = {}) => {
      let sortSpec: Doc | null = null;
      let rowLimit = Number.POSITIVE_INFINITY;
      if (filter.method?.$in) {
        lastCallbackFindFilter = filter;
        lastCallbackFindOptions = options;
      }
      return {
      sort(spec: Doc) {
        sortSpec = spec;
        if (filter.method?.$in) lastCallbackFindSort = spec;
        return this;
      },
      limit(value: number) {
        rowLimit = value;
        if (filter.method?.$in) lastCallbackFindLimit = value;
        return this;
      },
      async next() {
        return events.find((e) =>
          !e.processed &&
          (e.method === "GET" || e.method === "POST") &&
          (filter.objectType === undefined || e.objectType === filter.objectType) &&
          (filter.objectId === undefined || e.objectId === filter.objectId),
        ) || null;
      },
      async toArray() {
        const rows = events.filter((e) =>
          (filter.method?.$in === undefined || filter.method.$in.includes(e.method)) &&
          (filter.processed === undefined || e.processed === filter.processed) &&
          (filter.priority === undefined || e.priority === filter.priority) &&
          (
            filter.receivedAt?.$gte === undefined ||
            +new Date(e.receivedAt) >= +new Date(filter.receivedAt.$gte)
          ) &&
          (
            filter.$or === undefined ||
            e.attempts === undefined ||
            e.attempts < filter.$or[1].attempts.$lt
          )
        );
        if (sortSpec?.receivedAt) {
          rows.sort((a, b) =>
            sortSpec!.receivedAt * (+new Date(a.receivedAt) - +new Date(b.receivedAt)));
        }
        return rows.slice(0, rowLimit);
      },
    };
    },
    aggregate: (pipeline: Doc[]) => ({
      async toArray() {
        callbackAggregateCalls++;
        const limit = Number(pipeline.find((stage) => stage.$limit)?.$limit || 5000);
        const byShop = new Map<number, Doc[]>();
        for (const event of events.filter((e) => !e.processed && (e.method === "GET" || e.method === "POST"))) {
          const queue = byShop.get(Number(event.shopId)) || [];
          queue.push(event);
          byShop.set(Number(event.shopId), queue);
        }
        for (const queue of byShop.values()) queue.sort((a, b) => +new Date(b.receivedAt) - +new Date(a.receivedAt));
        const fair: Doc[] = [];
        for (let round = 0; fair.length < limit; round++) {
          let added = false;
          for (const queue of byShop.values()) if (queue[round]) {
            fair.push(queue[round]);
            added = true;
          }
          if (!added) break;
        }
        return fair.slice(0, limit);
      },
    }),
    updateOne: async (filter: Doc, update: Doc) => {
      const doc = events.find((e) => matches(e, filter));
      if (doc && update.$set) Object.assign(doc, update.$set);
      if (doc && update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + Number(v);
      return { matchedCount: doc ? 1 : 0 };
    },
    updateMany: async (filter: Doc, update: Doc) => {
      const exact = filter.$or?.[0];
      const doc = exact ? events.find((event) => matches(event, exact)) : undefined;
      if (doc && update.$set) Object.assign(doc, update.$set);
      return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 };
    },
  },
  protractor_callback_admissions: {
    findOne: async (filter: Doc) => {
      const activeEventKey = admissions.get(String(filter._id));
      const activeOwnerToken = admissionTokens.get(String(filter._id));
      return activeEventKey === filter.activeEventKey &&
        (!filter.activeOwnerToken || filter.activeOwnerToken === activeOwnerToken)
        ? { _id: filter._id, activeEventKey, activeOwnerToken }
        : null;
    },
    updateOne: async (filter: Doc, update: Doc) => {
      const id = String(filter._id);
      if (admissions.get(id) !== filter.activeEventKey) return { matchedCount: 0 };
      if (update.$set?.activeOwnerToken) admissionTokens.set(id, update.$set.activeOwnerToken);
      return { matchedCount: 1 };
    },
    findOneAndUpdate: async (filter: Doc, update: any) => {
      const id = String(filter._id);
      if (Array.isArray(update) && !("activeEventKey" in filter)) {
        const key = update[0].$set.activeEventKey.$cond[1];
        const prior = admissions.get(id);
        if (!prior) admissions.set(id, key);
        return prior ? { activeEventKey: prior, activeStartedAt: new Date() } : null;
      }
      if (filter.activeEventKey && admissions.get(id) === filter.activeEventKey) {
        admissions.delete(id);
        releases++;
      }
      return null;
    },
    deleteOne: async () => ({ deletedCount: 1 }),
  },
  protractor_work_orders: {
    findOne: async () => workOrder,
    updateMany: async (_filter: Doc, update: Doc) => {
      Object.assign(workOrder, update.$set);
      return { modifiedCount: 1 };
    },
  },
  vehicles: {
    findOne: async () => vehicle,
    updateOne: async (_filter: Doc, update: Doc) => {
      vehicle.status.active = update.$set["status.active"];
      vehicle.status.sources = update.$set["status.sources"];
      return { modifiedCount: 1 };
    },
  },
  dashboard_updates: {
    updateOne: async () => ({ modifiedCount: 1 }),
  },
};
const fakeDb = { collection: (name: string) => collections[name] || collections.protractor_callback_events };
const dbStub = {
  getDb: async () => fakeDb,
  getMongoClient: async () => ({
    startSession: () => ({
      withTransaction: async (fn: () => Promise<void>) => fn(),
      endSession: async () => {},
    }),
  }),
};
const integrationStub = {
  fetchVehicleById: async () => { providerFetches++; return { ok: false }; },
  fetchWorkOrderById: async () => {
    providerFetches++;
    return { ok: true, workOrder: { ID: "wo-terminal", WorkOrderGuid: "wo-terminal", WorkflowStage: "CLOSED" } };
  },
  upsertProtractorVehicleSnapshot: async () => {},
  upsertProtractorWorkOrderSnapshot: async () => {},
};
const pgStub = {
  __esModule: true,
  insertPostEvent: async (doc: Doc) => {
    pgInserts.push(doc);
    pgRows.push({
      eventKey: doc.eventKey, method: "POST", shopId: doc.shopId,
      objectType: "WorkOrder", objectId: doc.workOrderId,
      operation: doc.status, processed: false, attempts: 0,
    });
  },
  insertGetEvent: async (doc: Doc) => {
    pgRows.push({
      eventKey: doc.eventKey, method: "GET", shopId: doc.shopId,
      objectType: doc.objectType, objectId: doc.objectId,
      operation: doc.operation, processed: false, attempts: 0,
    });
  },
  countRecentByConnection: async () => 0,
  findRecentProcessedGet: async () => null,
  admitCallbackEvent: async () => { pgAdmissions++; return true; },
  claimCallbackEvent: async (eventKey: string) => {
    pgAdmissions++;
    return new Date().toISOString();
  },
  finishCallbackEventAdmission: async () => { pgReleases++; return null; },
  releaseCallbackEventAdmission: async () => { pgReleases++; },
  completeCallbackGeneration: async (eventKey: string) => {
    const row = pgRows.find((candidate) => candidate.eventKey === eventKey);
    if (row) row.processed = true;
    return true;
  },
  findPendingGetEvents: async () => pgRows.filter((r) => !r.processed),
  recordProcessingStarted: async (key: string) => {
    const row = pgRows.find((r) => r.eventKey === key);
    if (row) row.attempts++;
  },
  recordError: async () => {},
  markProcessedByKey: async (key: string) => {
    const row = pgRows.find((r) => r.eventKey === key);
    if (row) row.processed = true;
  },
  markOneProcessedByWorkOrderStatus: async (
    workOrderId: string,
    status: string | null,
  ) => {
    const row = pgRows.find((r) =>
      !r.processed &&
      r.objectId === workOrderId &&
      String(r.operation || "").toUpperCase() === String(status || "").toUpperCase()
    );
    if (row) row.processed = true;
  },
};

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request.includes("pg/protractor-callback-events")) return pgStub;
  if (request === "@/lib/data/db" || request.endsWith("/lib/data/db")) return dbStub;
  if (request === "@/lib/mongo" || request.endsWith("/lib/mongo")) return dbStub;
  if (request === "@/lib/integrations/protractor") return integrationStub;
  if (request === "@/lib/enterprise") return { attributeRevenueFromWorkOrder: async () => ({ matched: 0 }) };
  return originalLoad.call(this, request, parent, isMain);
};

function post(body: Doc) {
  return new NextRequest("http://test/api/callbacks/protractor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ConnectionId: "connection-42", ...body }),
  });
}

async function main() {
  process.env.RENDER_INSTANCE_ID = "denied-replica";
  process.env.PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS = "denied-replica";
  delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
  const route = await import("../app/api/callbacks/protractor/route");

  const open = await route.POST(post({ WorkOrderGuid: "wo-open", Status: "OPEN" }));
  const terminal = await route.POST(post({ WorkOrderGuid: "wo-terminal", Status: "CLOSED" }));
  const get = await route.GET(new NextRequest(
    "http://test/api/callbacks/protractor?connectionId=connection-42&type=WorkOrder&id=wo-get&operation=Update",
  ));
  for (const response of [open, terminal, get]) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "deferred");
  }
  assert.equal(providerFetches, 0, "denied handlers perform no enrichment");
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.equal(event.processed, false);
    assert.equal(event.attempts, 0);
    assert.ok(event.method === "POST" || event.method === "GET");
  }
  assert.equal(admissions.size, 0, "denied ingress creates no worker claim");
  assert.equal(releases, 0);

  process.env.RENDER_INSTANCE_ID = "allowed-replica";
  process.env.PROTRACTOR_OUTBOUND_DISABLED = "true";
  const globallyDisabled = await route.GET(new NextRequest(
    "http://test/api/callbacks/protractor?connectionId=connection-42&type=WorkOrder&id=wo-disabled&operation=Update",
  ));
  assert.equal(globallyDisabled.status, 200);
  assert.equal((await globallyDisabled.json()).status, "deferred");
  assert.equal(providerFetches, 0, "global outbound disable performs zero provider reads");
  const disabledEvent = events.find((event) => event.objectId === "wo-disabled")!;
  assert.equal(disabledEvent.processed, false, "globally disabled work remains replayable");
  disabledEvent.processed = true;
  delete process.env.PROTRACTOR_OUTBOUND_DISABLED;

  process.env.RENDER_INSTANCE_ID = "allowed-replica";
  const { replayDeferredTerminalPost } = await import(
    "../lib/integrations/protractor/callback-replay"
  );
  const callbackRepo = await import("../lib/data/repositories/protractor-callback-events");
  const terminalHelper = (
    await import("../lib/integrations/protractor/callback-terminal")
  ).applyProtractorTerminalCallback;
  const { processProtractorCallbackQueue, selectFairCallbackBatch } = await import(
    "../lib/integrations/protractor/callback-queue"
  );
  const fairnessInput = [
    { key: "a1", method: "GET" as const, shopId: 1, objectType: "WorkOrder", objectId: "same", operation: "Update", receivedAt: new Date(1) },
    { key: "a2", method: "GET" as const, shopId: 1, objectType: "WorkOrder", objectId: "same", operation: "Delete", receivedAt: new Date(2) },
    { key: "a3", method: "GET" as const, shopId: 1, objectType: "WorkOrder", objectId: "same", operation: "Update", receivedAt: new Date(3) },
    { key: "a4", method: "GET" as const, shopId: 1, objectType: "WorkOrder", objectId: "other", operation: "Update", receivedAt: new Date(4) },
    { key: "b1", method: "GET" as const, shopId: 2, objectType: "WorkOrder", objectId: "wo-2", operation: "Update", receivedAt: new Date(5) },
  ];
  const fair = selectFairCallbackBatch(fairnessInput, 3);
  assert.equal(fair.selected[0].shopId, 1);
  assert.equal(fair.selected[1].shopId, 2, "busy shop cannot consume the whole batch");
  assert.ok(fair.selected.some((item) => item.key === "a2"), "Delete dominates later Update noise");
  assert.deepEqual(
    fair.coalesced.map((item) => item.key).sort(),
    ["a1", "a3"],
    "duplicate/coalesced events retain one terminal latest-wins event",
  );
  const fairnessBase = Date.now();
  const noisyFairnessDocs = Array.from({ length: 501 }, (_, index) => ({
    _id: new ObjectId(), method: "GET", shopId: 1, objectType: "WorkOrder",
    objectId: `noisy-${index}`, operation: "Update", processed: false,
    attempts: 0, priority: 1, receivedAt: new Date(fairnessBase + index),
  }));
  const quietFairnessDoc = {
    ...noisyFairnessDocs[0], _id: new ObjectId(), shopId: 2, objectId: "quiet",
  };
  const priorEvents = events.splice(0);
  events.push(...noisyFairnessDocs, quietFairnessDoc);
  const datastoreFair = await callbackRepo.findPendingGetEvents(2, 3);
  assert.deepEqual(
    datastoreFair.map((item) => item.shopId),
    [1, 1],
    "Mongo retrieval remains bounded to the newest indexed candidate window",
  );
  assert.equal(callbackAggregateCalls, 0, "Mongo queue retrieval never ranks the full historical backlog");
  assert.deepEqual(lastCallbackFindSort, { receivedAt: -1 });
  assert.equal(lastCallbackFindLimit, 2);
  assert.equal(
    lastCallbackFindOptions?.hint,
    "method_1_processed_1_priority_1_receivedAt_1",
  );
  assert.equal(lastCallbackFindOptions?.maxTimeMS, 5_000);
  const replayFloor = new Date(fairnessBase + 499);
  const floorBounded = await callbackRepo.findPendingGetEvents(10, 3, 10, replayFloor);
  assert.ok(
    floorBounded.every((item) => (item.receivedAt?.getTime() ?? 0) >= replayFloor.getTime()),
    "callback replay floor excludes historical backlog before retrieval",
  );
  assert.equal(lastCallbackFindFilter?.receivedAt?.$gte, replayFloor);
  const urgentDocs = Array.from({ length: 3 }, (_, index) => ({
    ...noisyFairnessDocs[0],
    _id: new ObjectId(),
    objectId: `urgent-${index}`,
    priority: 0,
    receivedAt: new Date(fairnessBase + 1_000 + index),
  }));
  const malformedPriority = {
    ...noisyFairnessDocs[0],
    _id: new ObjectId(),
    objectId: "missing-priority",
    priority: undefined,
    receivedAt: new Date(fairnessBase + 2_000),
  };
  events.push(...urgentDocs, malformedPriority);
  const urgentBounded = await callbackRepo.findPendingGetEvents(2, 3);
  assert.equal(urgentBounded.length, 2, "priority lanes share one combined candidate cap");
  assert.ok(
    urgentBounded.every((item) => item.objectId?.startsWith("urgent-")),
    "priority zero intentionally consumes the cap before normal callbacks",
  );
  assert.ok(
    urgentBounded.every((item) => item.objectId !== "missing-priority"),
    "missing priority is excluded from the contracted rollout queue",
  );
  events.splice(0);
  events.push(...priorEvents);
  const queueReplayFloor = new Date(Date.now() - 60_000);
  let terminalReplayFetchOptions: Doc | undefined;
  process.env.PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE = queueReplayFloor.toISOString();
  process.env.PROTRACTOR_CALLBACK_CANARY_UNTIL = new Date(Date.now() + 60_000).toISOString();
  const queueResult = await processProtractorCallbackQueue(fakeDb as any, async (item) => {
    if (item.method === "POST" && item.operation === "CLOSED") {
      const ok = await replayDeferredTerminalPost(
        fakeDb as any,
        { key: item.key, shopId: item.shopId, objectId: item.objectId!, operation: item.operation },
        {
          ...integrationStub,
          fetchWorkOrderById: async (...args: any[]) => {
            terminalReplayFetchOptions = args[2];
            return integrationStub.fetchWorkOrderById();
          },
          applyProtractorTerminalCallback: terminalHelper,
        },
      );
      if (!ok) throw new Error("terminal replay failed");
      return;
    }
    const result = await integrationStub.fetchWorkOrderById();
    assert.equal(result.ok, true);
    await callbackRepo.markProcessed(item.key);
  }, {
    isShopEligible: async (shopId) => shopId === 42,
    acquireBudgetSlot: async () => true,
  });
  assert.equal(
    lastCallbackFindFilter?.receivedAt?.$gte?.getTime(),
    queueReplayFloor.getTime(),
    "callback-only queue passes the exact policy replay floor into retrieval",
  );
  assert.deepEqual(
    terminalReplayFetchOptions,
    { timeoutMs: 8_000, maxRetries: 0 },
    "terminal callback replay uses the same bounded zero-retry provider read",
  );
  delete process.env.PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE;
  delete process.env.PROTRACTOR_CALLBACK_CANARY_UNTIL;
  assert.deepEqual(queueResult, { processed: 3, failed: 0 });
  assert.equal(providerFetches, 3, "allowed queue fetches GET, open POST, and terminal POST");
  const terminalEvent = events.find((e) => e.objectId === "wo-terminal")!;
  assert.ok(events.every((e) => e.processed), "allowed queue marks every deferred event processed");
  assert.equal(admissions.size, 0, "allowed queue releases every admission");
  assert.equal(terminalEvent.processed, true);
  assert.equal(workOrder.closedViaCallback, true);
  assert.equal(workOrder.status, "CLOSED");
  assert.equal(vehicle.status.active, true);
  assert.deepEqual(vehicle.status.sources, [{ provider: "other", workOrderId: "other" }]);

  const budgetDocs = ["budget-1", "budget-2", "budget-3"].map((objectId) => ({
    _id: new ObjectId(),
    receivedAt: new Date(),
    method: "GET",
    connectionId: "connection-42",
    objectType: "WorkOrder",
    objectId,
    operation: "Update",
    shopId: 42,
    processed: false,
    attempts: 0,
    priority: 1,
  }));
  events.push(...budgetDocs);
  let budgetClaims = 0;
  const budgetResult = await processProtractorCallbackQueue(fakeDb as any, async (item) => {
    await callbackRepo.markProcessed(item.key);
  }, {
    limit: 3,
    isShopEligible: async () => true,
    acquireBudgetSlot: async () => ++budgetClaims === 1,
  });
  assert.deepEqual(budgetResult, { processed: 1, failed: 0 });
  assert.equal(
    budgetDocs.filter((doc) => !doc.processed).length,
    2,
    "budget exhaustion leaves callback work replayable",
  );
  for (const doc of budgetDocs) doc.processed = true;

  process.env.PROTRACTOR_OPS_PG_CANONICAL = "1";
  process.env.WRITE_MONGO_PROTRACTOR_OPS = "0";
  process.env.RENDER_INSTANCE_ID = "denied-replica";
  const pgOpen = await route.POST(post({ WorkOrderGuid: "wo-pg-open", Status: "OPEN" }));
  const pgTerminal = await route.POST(post({ WorkOrderGuid: "wo-terminal", Status: "CLOSED" }));
  const pgGet = await route.GET(new NextRequest(
    "http://test/api/callbacks/protractor?connectionId=connection-42&type=WorkOrder&id=wo-pg-get&operation=Update",
  ));
  for (const response of [pgOpen, pgTerminal, pgGet]) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "deferred");
  }
  assert.equal(pgInserts.length, 2);
  assert.ok(pgInserts.every((row) => row.deferredForReplay === true));
  assert.equal(pgRows.length, 3);
  assert.deepEqual(
    pgRows.map((row) => row.method).sort(),
    ["GET", "POST", "POST"],
  );
  assert.ok(pgRows.every((row) => row.attempts === 0 && row.processed === false));
  assert.equal(pgAdmissions, 0);
  assert.equal(pgReleases, 0);
  assert.equal(providerFetches, 3);

  workOrder.status = "OPEN";
  workOrder.closedViaCallback = false;
  vehicle.status.sources = [
    { provider: "protractor", workOrderId: "wo-terminal" },
    { provider: "other", workOrderId: "other" },
  ];
  process.env.RENDER_INSTANCE_ID = "allowed-replica";
  const pgQueue = await processProtractorCallbackQueue(fakeDb as any, async (item) => {
    if (item.method === "POST" && item.operation === "CLOSED") {
      const ok = await replayDeferredTerminalPost(
        fakeDb as any,
        { key: item.key, shopId: item.shopId, objectId: item.objectId!, operation: item.operation },
        {
          ...integrationStub,
          applyProtractorTerminalCallback: terminalHelper,
        },
      );
      if (!ok) throw new Error("PG terminal replay failed");
      return;
    }
    await integrationStub.fetchWorkOrderById();
    await callbackRepo.markProcessed(item.key);
  }, {
    isShopEligible: async (shopId) => shopId === 42,
    acquireBudgetSlot: async () => true,
  });
  assert.deepEqual(pgQueue, { processed: 3, failed: 0 });
  assert.ok(pgRows.every((row) => row.processed === true));
  assert.ok(pgRows.every((row) => row.attempts === 1));
  assert.equal(pgAdmissions, 3);
  assert.equal(pgReleases, 3);
  assert.equal(providerFetches, 6);
  assert.equal(workOrder.closedViaCallback, true);
  assert.equal(workOrder.status, "CLOSED");
  assert.deepEqual(vehicle.status.sources, [{ provider: "other", workOrderId: "other" }]);

  process.env.RENDER_INSTANCE_ID = "denied-replica";
  const { selectBackfillWorkerKinds } = await import("../workers/worker-registration");
  const selected = selectBackfillWorkerKinds(false);
  assert.ok(selected.includes("tekmetric-fullpage"));
  assert.ok(selected.includes("drain-tekmetric"));
  assert.equal(selected.includes("drain-protractor"), false);
  const ping = await (await import("../app/api/ping/route")).GET();
  assert.equal(ping.status, 200);
  assert.equal((await ping.json()).ok, true);

  console.log("protractor instance callback deferral: all checks passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});