import assert from "node:assert/strict";
import Module from "node:module";
import { ObjectId } from "mongodb";
import { NextRequest } from "next/server";

type Doc = Record<string, any>;
const events: Doc[] = [];
const admissions = new Map<string, string>();
let releases = 0;
let providerFetches = 0;
const pgInserts: Doc[] = [];
const pgRows: Doc[] = [];
let pgAdmissions = 0;
let pgReleases = 0;

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
  shops: {
    findOne: async () => ({ shopId: 42 }),
  },
  protractor_callback_events: {
    insertOne: async (doc: Doc) => {
      const stored = { _id: new ObjectId(), ...doc };
      events.push(stored);
      return { insertedId: stored._id };
    },
    findOne: async () => null,
    countDocuments: async () => 0,
    find: () => ({
      sort() { return this; },
      limit() { return this; },
      async toArray() { return events.filter((e) => !e.processed && (e.method === "GET" || e.method === "POST")); },
    }),
    updateOne: async (filter: Doc, update: Doc) => {
      const doc = events.find((e) => matches(e, filter));
      if (doc && update.$set) Object.assign(doc, update.$set);
      if (doc && update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + Number(v);
      return { matchedCount: doc ? 1 : 0 };
    },
  },
  protractor_callback_admissions: {
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
const dbStub = { getDb: async () => fakeDb };
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
  finishCallbackEventAdmission: async () => { pgReleases++; return null; },
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
  assert.equal(admissions.size, 0, "all denied admissions were released");
  assert.equal(releases, 3);

  process.env.RENDER_INSTANCE_ID = "allowed-replica";
  const { replayDeferredTerminalPost } = await import(
    "../lib/integrations/protractor/callback-replay"
  );
  const callbackRepo = await import("../lib/data/repositories/protractor-callback-events");
  const terminalHelper = (
    await import("../lib/integrations/protractor/callback-terminal")
  ).applyProtractorTerminalCallback;
  const { processProtractorCallbackQueue } = await import(
    "../lib/integrations/protractor/callback-queue"
  );
  const queueResult = await processProtractorCallbackQueue(fakeDb as any, async (item) => {
    if (item.method === "POST" && item.operation === "CLOSED") {
      const ok = await replayDeferredTerminalPost(
        fakeDb as any,
        { key: item.key, shopId: item.shopId, objectId: item.objectId!, operation: item.operation },
        {
          ...integrationStub,
          applyProtractorTerminalCallback: terminalHelper,
          markProcessed: callbackRepo.markProcessed,
        },
      );
      if (!ok) throw new Error("terminal replay failed");
      return;
    }
    const result = await integrationStub.fetchWorkOrderById();
    assert.equal(result.ok, true);
    await callbackRepo.markProcessed(item.key);
  });
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
  assert.equal(pgAdmissions, 3);
  assert.equal(pgReleases, 3);
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
          markProcessed: callbackRepo.markProcessed,
        },
      );
      if (!ok) throw new Error("PG terminal replay failed");
      return;
    }
    await integrationStub.fetchWorkOrderById();
    await callbackRepo.markProcessed(item.key);
  });
  assert.deepEqual(pgQueue, { processed: 3, failed: 0 });
  assert.ok(pgRows.every((row) => row.processed === true));
  assert.ok(pgRows.every((row) => row.attempts === 1));
  assert.equal(pgAdmissions, 6);
  assert.equal(pgReleases, 6);
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