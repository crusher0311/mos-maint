/**
 * Offline repository tests for callback history outcomes.
 *
 * Run: npx tsx tests/protractor-callback-outcomes-repository.smoke.ts
 *
 * The Mongo arm is an in-memory collection/session fake.  The PG arm is a
 * tiny Drizzle query-builder fake that records predicates and projections;
 * neither arm opens a real database connection.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { ObjectId } from "mongodb";

type Doc = Record<string, any>;

const originalLoad = (Module as any)._load;
const mongoEvents = new Map<string, Doc>();
const mongoAdmissions = new Map<string, Doc>();
let mongoReportDocs: Doc[] = [];
let mongoReportQuery: { filter?: Doc; options?: Doc; sort?: Doc } = {};
const pgUpdates: Array<{ set: Doc; where: any }> = [];
const pgInserts: Doc[] = [];
const pgSelects: Array<{ selection: Doc; where?: any; limit?: number }> = [];
const pgExecutions: any[] = [];
let pgOwnerRows: Doc[] = [];
let pgReportRows: Doc[] = [];
let pgReportSelectCalls = 0;

function idString(value: unknown): string {
  return value instanceof ObjectId ? value.toHexString() : String(value);
}

function matchesMongoFilter(doc: Doc, filter: Doc): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "$or") {
      if (!(expected as Doc[]).some((part) => matchesMongoFilter(doc, part))) return false;
      continue;
    }
    if (key === "$nor") {
      if ((expected as Doc[]).some((part) => matchesMongoFilter(doc, part))) return false;
      continue;
    }
    const actual = doc[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$ne" in expected && idString(actual) === idString(expected.$ne)) return false;
      if ("$in" in expected && !(expected.$in as unknown[]).some((value) => idString(actual) === idString(value))) return false;
      if ("$lte" in expected && !(actual instanceof Date && actual <= expected.$lte)) return false;
      if ("$gte" in expected && !(actual instanceof Date && actual >= expected.$gte)) return false;
      if ("$exists" in expected && (expected.$exists ? actual === undefined : actual !== undefined)) return false;
      const operators = ["$ne", "$in", "$lte", "$gte", "$exists"];
      if (operators.some((operator) => operator in expected)) continue;
    }
    if (expected instanceof RegExp) {
      if (typeof actual !== "string" || !expected.test(actual)) return false;
      continue;
    }
    if (expected instanceof ObjectId) {
      if (!(actual instanceof ObjectId) || !actual.equals(expected)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function applyMongoUpdate(doc: Doc, update: Doc): void {
  Object.assign(doc, update.$set ?? {});
  for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
}

const eventCollection = {
  insertOne: async (doc: Doc) => {
    const insertedId = new ObjectId();
    const stored = { ...doc, _id: insertedId };
    mongoEvents.set(insertedId.toHexString(), stored);
    return { insertedId };
  },
  findOne: async (filter: Doc) => {
    return [...mongoEvents.values()].find((doc) => matchesMongoFilter(doc, filter)) ?? null;
  },
  updateOne: async (filter: Doc, update: Doc) => {
    const doc = [...mongoEvents.values()].find((candidate) => matchesMongoFilter(candidate, filter));
    if (!doc) return { matchedCount: 0 };
    applyMongoUpdate(doc, update);
    return { matchedCount: 1 };
  },
  updateMany: async (filter: Doc, update: Doc) => {
    const docs = [...mongoEvents.values()].filter((candidate) => matchesMongoFilter(candidate, filter));
    docs.forEach((doc) => applyMongoUpdate(doc, update));
    return { matchedCount: docs.length };
  },
  find: (filter: Doc, options: Doc) => {
    mongoReportQuery = { filter, options };
    let rows = mongoReportDocs.filter((doc) => matchesMongoFilter(doc, filter));
    return {
      sort: (sort: Doc) => {
        mongoReportQuery.sort = sort;
        rows = rows.slice().sort((a, b) =>
          Number(new Date(b.receivedAt)) - Number(new Date(a.receivedAt)));
        return {
          limit: (limit: number) => ({
            toArray: async () => rows.slice(0, limit),
          }),
        };
      },
    };
  },
};

const admissionCollection = {
  findOne: async (filter: Doc) =>
    [...mongoAdmissions.values()].find((doc) => matchesMongoFilter(doc, filter)) ?? null,
  deleteOne: async (filter: Doc) => {
    const doc = [...mongoAdmissions.values()].find((candidate) => matchesMongoFilter(candidate, filter));
    if (!doc) return { deletedCount: 0 };
    mongoAdmissions.delete(String(doc._id));
    return { deletedCount: 1 };
  },
};

const mongoDb = {
  collection: (name: string) => name === "protractor_callback_admissions"
    ? admissionCollection
    : eventCollection,
};

function sql(strings: TemplateStringsArray | string, ...values: any[]): any {
  if (typeof strings === "string") return { kind: "sql", text: strings, values };
  return {
    kind: "sql",
    text: strings.reduce((result, part, index) =>
      result + part + (index < values.length ? ` ${renderSql(values[index])} ` : ""), ""),
    values,
  };
}
sql.raw = (value: string) => ({ kind: "sql", text: value, values: [] });

function renderSql(value: any): string {
  if (value?.kind === "column") return value.name;
  if (value?.kind === "sql") return value.text;
  return "?";
}
function condition(op: string, ...args: any[]) {
  return { kind: "condition", op, args };
}
const drizzleStub = {
  sql,
  and: (...args: any[]) => condition("and", ...args.filter(Boolean)),
  or: (...args: any[]) => condition("or", ...args.filter(Boolean)),
  eq: (column: any, value: any) => condition("eq", column, value),
  gte: (column: any, value: any) => condition("gte", column, value),
  lt: (column: any, value: any) => condition("lt", column, value),
  isNotNull: (column: any) => condition("isNotNull", column),
  inArray: (column: any, value: any) => condition("inArray", column, value),
  asc: (column: any) => condition("asc", column),
  desc: (column: any) => condition("desc", column),
  count: () => ({ kind: "count" }),
  max: (column: any) => ({ kind: "max", column }),
};

const columns = new Proxy({}, {
  get: (_target, property) => ({ kind: "column", name: String(property) }),
}) as any;

function pgSelectionRows(selection: Doc, limit?: number): Doc[] {
  if ("eventKey" in selection) return pgOwnerRows.slice(0, limit ?? pgOwnerRows.length);
  const method = pgReportSelectCalls++ === 0 ? "GET" : "POST";
  const offset = method === "GET" ? 0 : 1;
  return pgReportRows
    .slice(offset, offset + (limit ?? pgReportRows.length))
    .map((row) => ({
      ...row,
      method,
      ...(method === "POST" && row.receivedAt instanceof Date
        ? { receivedAt: new Date(row.receivedAt.getTime() + 1) }
        : {}),
    }));
}

const pgTransaction = {
  execute: async (statement: any) => {
    pgExecutions.push(statement);
    return [];
  },
  select: (selection: Doc) => {
    const state: { where?: any; limit?: number } = {};
    const builder: any = {
      from: () => builder,
      where: (where: any) => {
        state.where = where;
        return builder;
      },
      orderBy: () => builder,
      limit: (limit: number) => {
        state.limit = limit;
        return builder;
      },
      then: (resolve: (value: Doc[]) => void, reject: (error: unknown) => void) => {
        try {
          pgSelects.push({ selection, ...state });
          resolve(pgSelectionRows(selection, state.limit));
        } catch (error) {
          reject(error);
        }
      },
    };
    return builder;
  },
  update: () => ({
    set: (set: Doc) => ({
      where: (where: any) => {
        pgUpdates.push({ set, where });
        return {
          returning: async () => [{ eventKey: "owner" }],
        };
      },
    }),
  }),
};

const pgDb = {
  transaction: async (callback: (tx: any) => Promise<unknown>) => callback(pgTransaction),
  select: pgTransaction.select,
  update: pgTransaction.update,
  insert: () => ({
    values: async (values: Doc) => {
      pgInserts.push(values);
      return [];
    },
  }),
};

const dbStub = {
  getDb: () => {
    const selected = process.env.PROTRACTOR_OPS_PG_CANONICAL === "1" ? pgDb : mongoDb;
    return selected;
  },
  getMongoClient: async () => ({
    startSession: () => ({
      withTransaction: async (callback: () => Promise<void>) => callback(),
      endSession: async () => {},
    }),
  }),
};

(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "drizzle-orm") return drizzleStub;
  if (request.includes("/lib/db/schema/wave3") || request === "@/lib/db/schema/wave3") {
    return { protractorCallbackEvents: columns };
  }
  if (request.includes("/lib/db/drizzle") || request === "@/lib/db/drizzle") return dbStub;
  if (request === "@/lib/data/db" || request.endsWith("/lib/data/db")) return dbStub;
  return originalLoad.call(this, request, parent, isMain);
};

function resetMongo() {
  mongoEvents.clear();
  mongoAdmissions.clear();
}

function seedMongoGeneration(stale = false) {
  resetMongo();
  const ownerId = new ObjectId();
  const siblingId = new ObjectId();
  const newerId = new ObjectId();
  const ownerKey = ownerId.toHexString();
  const ownerReceivedAt = new Date("2026-06-01T00:00:00.000Z");
  const identity = {
    shopId: 42,
    method: "GET" as const,
    objectType: "WorkOrder",
    objectId: "wo-1",
    operation: "*",
    terminal: false,
  };
  mongoEvents.set(ownerKey, {
    _id: ownerId,
    shopId: 42,
    objectType: "WorkOrder",
    objectId: "wo-1",
    operation: "Modified",
    receivedAt: ownerReceivedAt,
    processed: false,
    processingOwnerToken: stale ? "new-owner" : "owner-token",
  });
  mongoEvents.set(siblingId.toHexString(), {
    _id: siblingId,
    shopId: 42,
    objectType: "WorkOrder",
    objectId: "wo-1",
    operation: "Modified",
    receivedAt: new Date(ownerReceivedAt.getTime() - 1_000),
    processed: false,
  });
  mongoEvents.set(newerId.toHexString(), {
    _id: newerId,
    shopId: 42,
    objectType: "WorkOrder",
    objectId: "wo-1",
    operation: "Modified",
    receivedAt: new Date(ownerReceivedAt.getTime() + 1_000),
    processed: false,
  });
  mongoAdmissions.set(JSON.stringify([42, "WorkOrder", "wo-1"]), {
    _id: JSON.stringify([42, "WorkOrder", "wo-1"]),
    activeEventKey: ownerKey,
    activeOwnerToken: stale ? "new-owner" : "owner-token",
  });
  return { ownerKey, siblingId, newerId, ownerReceivedAt, identity };
}

async function main() {
  const callbackRepositorySource = readFileSync(
    "lib/data/repositories/protractor-callback-events.ts",
    "utf8",
  );
  const callbackSchemaSource = readFileSync("lib/db/schema/wave3.ts", "utf8");
  const callbackMigrationSource = readFileSync(
    "scripts/apply-normalized-migration.ts",
    "utf8",
  );
  assert.match(
    callbackRepositorySource,
    /hint: "receivedAt_-1"/,
    "Mongo report pins the existing receivedAt index",
  );
  assert.match(
    callbackRepositorySource,
    /\.sort\(\{ receivedAt: -1 \}\)/,
    "Mongo report sort matches the receivedAt_-1 index shape",
  );
  assert.match(
    callbackSchemaSource,
    /index\("pro_cb_method_received_idx"\)\.on\(t\.method, t\.receivedAt\)/,
    "PG schema has the method/receivedAt report index",
  );
  assert.match(
    callbackMigrationSource,
    /CREATE INDEX IF NOT EXISTS "pro_cb_method_received_idx" ON "protractor_callback_events" \("method", "received_at"\)/,
    "PG migration creates the method/received_at report index",
  );

  delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
  const repo = await import("../lib/data/repositories/protractor-callback-events");

  {
    resetMongo();
    const key = await repo.insertPostEvent({
      payload: {
        private: "provider-payload",
        historyOutcome: { category: "applied_indexed", reason: "indexed" },
      },
      workOrderId: "wo-insert",
      status: "Open",
      connectionId: "connection",
      shopId: 42,
    });
    assert.deepEqual(
      mongoEvents.get(key)!.historyOutcome,
      { category: "deferred", reason: "pending_replay" },
      "Mongo insertion always records conservative deferred evidence",
    );
    const getKey = await repo.insertGetEvent({
      connectionId: "connection",
      objectType: "WorkOrder",
      objectId: "wo-get",
      operation: "Modified",
      shopId: 42,
    });
    assert.deepEqual(
      mongoEvents.get(getKey)!.historyOutcome,
      { category: "deferred", reason: "pending_replay" },
      "Mongo GET insertion records deferred evidence",
    );
  }

  {
    const fixture = seedMongoGeneration();
    const outcome = {
      category: "applied_indexed" as const,
      reason: "indexed" as const,
      indexedJobs: 3,
      changedJobs: 2,
    };
    assert.equal(
      await repo.completeCallbackGeneration(
        fixture.ownerKey,
        fixture.identity,
        "owner-token",
        fixture.ownerReceivedAt,
        outcome,
      ),
      true,
    );
    const owner = mongoEvents.get(fixture.ownerKey)!;
    const sibling = mongoEvents.get(fixture.siblingId.toHexString())!;
    const newer = mongoEvents.get(fixture.newerId.toHexString())!;
    assert.deepEqual(owner.historyOutcome, outcome, "Mongo owner keeps the supplied outcome");
    assert.deepEqual(
      sibling.historyOutcome,
      { category: "coalesced", reason: "superseded" },
      "Mongo sibling records coalesced evidence",
    );
    assert.equal(newer.processed, false, "Mongo newer callback remains replayable");
  }

  {
    const fixture = seedMongoGeneration(true);
    assert.equal(
      await repo.completeCallbackGeneration(
        fixture.ownerKey,
        fixture.identity,
        "owner-token",
        fixture.ownerReceivedAt,
        { category: "applied_indexed", reason: "indexed" },
      ),
      false,
      "Mongo stale owner fence rejects completion",
    );
    assert.equal(mongoEvents.get(fixture.siblingId.toHexString())!.processed, false);
    assert.equal(mongoEvents.get(fixture.siblingId.toHexString())!.historyOutcome, undefined);
  }

  {
    const fixture = seedMongoGeneration();
    await repo.recordCallbackOutcome(
      fixture.ownerKey,
      "wrong-owner",
      { category: "failed", reason: "dispatch_failed" },
    );
    assert.equal(
      mongoEvents.get(fixture.ownerKey)!.historyOutcome,
      undefined,
      "Mongo failure evidence cannot cross owner fence",
    );
    await repo.recordCallbackOutcome(
      fixture.ownerKey,
      "owner-token",
      { category: "failed", reason: "dispatch_failed" },
    );
    assert.deepEqual(
      mongoEvents.get(fixture.ownerKey)!.historyOutcome,
      { category: "failed", reason: "dispatch_failed" },
    );
  }

  {
    process.env.PROTRACTOR_OPS_PG_CANONICAL = "1";
    pgUpdates.length = 0;
    pgSelects.length = 0;
    pgOwnerRows = [{ eventKey: "owner" }];
    const pgRepo = await import("../lib/data/repositories/pg/protractor-callback-events");
    pgInserts.length = 0;
    await pgRepo.insertPostEvent({
      eventKey: "insert-post",
      receivedAt: new Date("2026-06-01T00:00:00.000Z"),
      payload: {
        private: "provider-payload",
        historyOutcome: { category: "applied_indexed", reason: "indexed" },
      },
      workOrderId: "wo-insert",
      status: "Open",
      connectionId: "connection",
      shopId: 42,
    });
    await pgRepo.insertGetEvent({
      eventKey: "insert-get",
      receivedAt: new Date("2026-06-01T00:00:00.000Z"),
      connectionId: "connection",
      objectType: "WorkOrder",
      objectId: "wo-get",
      operation: "Modified",
      shopId: 42,
    });
    assert.deepEqual(
      (pgInserts[0].payload as Doc).historyOutcome,
      { category: "deferred", reason: "pending_replay" },
      "PG insertion overwrites client payload outcome with deferred evidence",
    );
    assert.deepEqual(
      (pgInserts[1].payload as Doc).historyOutcome,
      { category: "deferred", reason: "pending_replay" },
      "PG GET insertion records deferred evidence",
    );
    const identity = {
      shopId: 42,
      method: "GET" as const,
      objectType: "WorkOrder",
      objectId: "wo-pg",
      operation: "*",
      terminal: false,
    };
    const receivedAt = new Date("2026-06-01T00:00:00.000Z");
    const ownerOutcome = {
      category: "applied_indexed" as const,
      reason: "indexed" as const,
      indexedJobs: 4,
      changedJobs: 1,
    };
    assert.equal(
      await pgRepo.completeCallbackGeneration(
        "owner",
        identity,
        receivedAt.toISOString(),
        receivedAt,
        ownerOutcome,
      ),
      true,
    );
    assert.equal(pgUpdates.length, 2, "PG completion updates owner and siblings separately");
    assert.match(
      JSON.stringify(pgUpdates[0].set),
      /applied_indexed|indexed|indexedJobs/,
      "PG owner update stores supplied outcome",
    );
    assert.match(
      JSON.stringify(pgUpdates[1].set),
      /coalesced|superseded/,
      "PG sibling update stores coalesced outcome",
    );
    assert.match(
      JSON.stringify(pgUpdates[0].where),
      /processingStartedAt|processing_started_at/,
      "PG owner update retains processing fence",
    );

    pgUpdates.length = 0;
    await pgRepo.recordCallbackOutcome(
      "owner",
      receivedAt.toISOString(),
      { category: "failed", reason: "dispatch_failed" },
    );
    assert.equal(pgUpdates.length, 1, "PG failure outcome performs one update");
    assert.match(
      JSON.stringify(pgUpdates[0].where),
      /processingStartedAt|processing_started_at/,
      "PG failure outcome is owner fenced",
    );

    pgOwnerRows = [];
    pgUpdates.length = 0;
    assert.equal(
      await pgRepo.completeCallbackGeneration(
        "owner",
        identity,
        receivedAt.toISOString(),
        receivedAt,
        ownerOutcome,
      ),
      false,
      "PG stale owner fence rejects completion",
    );
    assert.equal(pgUpdates.length, 0, "PG stale owner cannot alter siblings");
  }

  {
    delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
    const now = Date.now();
    mongoReportDocs = Array.from({ length: 205 }, (_, index) => ({
      _id: new ObjectId(),
      method: index === 0 ? "GET" : "POST",
      shopId: 100 + index,
      receivedAt: new Date(now - index * 1_000),
      customer: { name: "private-customer" },
      vin: "PRIVATE-VIN",
      payload: { error: "private-error", customer: "private-customer" },
      ...(index === 0
        ? {}
        : {
            historyOutcome: {
              category: "applied_indexed",
              reason: "indexed",
              indexedJobs: 2,
              changedJobs: 1,
            },
          }),
    }));
    const report = await repo.getCallbackOutcomeReport(mongoDb as any);
    assert.equal(report.sampleLimit, 200);
    assert.equal(report.sampled, 200, "Mongo report is capped at 200 rows");
    assert.equal(report.counts.applied_indexed, 199, "Mongo counts describe the sample only");
    assert.equal(report.counts.unknown, 1, "Mongo legacy row remains unknown");
    assert.equal(report.rows[0].method, "GET", "Mongo report labels GET samples");
    assert.equal(JSON.stringify(report).includes("private-customer"), false);
    assert.equal(JSON.stringify(report).includes("PRIVATE-VIN"), false);
    assert.equal(JSON.stringify(report).includes("private-error"), false);
    assert.equal(JSON.stringify(report).includes("_id"), false);
    assert.deepEqual(mongoReportQuery.options?.projection, {
      method: 1,
      shopId: 1,
      receivedAt: 1,
      historyOutcome: 1,
    });
    assert.equal(mongoReportQuery.options?.maxTimeMS, 5_000);
    assert.equal(mongoReportQuery.options?.hint, "receivedAt_-1");
    assert.deepEqual(mongoReportQuery.sort, { receivedAt: -1 });
  }

  {
    process.env.PROTRACTOR_OPS_PG_CANONICAL = "1";
    pgReportRows = Array.from({ length: 205 }, (_, index) => ({
      shopId: 200 + index,
      receivedAt: new Date(Date.now() - index * 1_000),
      historyOutcome: index === 0
        ? null
        : { category: "failed", reason: "dispatch_failed" },
      payload: { customer: "private-customer", vin: "PRIVATE-VIN", error: "private-error" },
    }));
    pgSelects.length = 0;
    pgReportSelectCalls = 0;
    const report = await repo.getCallbackOutcomeReport();
    assert.equal(report.sampled, 200, "PG report is capped at 200 rows");
    assert.equal(report.counts.failed, 199, "PG counts describe the sample only");
    assert.equal(report.counts.unknown, 1, "PG legacy row remains unknown");
    assert.equal(report.rows.some((row) => row.method === "GET"), true, "PG report labels GET samples");
    assert.equal(report.rows.some((row) => row.method === "POST"), true, "PG report labels POST samples");
    assert.equal(JSON.stringify(report).includes("private-customer"), false);
    assert.equal(JSON.stringify(report).includes("PRIVATE-VIN"), false);
    assert.equal(JSON.stringify(report).includes("private-error"), false);
    assert.equal("payload" in (pgSelects.at(-1)?.selection ?? {}), false);
    assert.equal(pgSelects.length, 2, "PG report uses one bounded query per method");
    assert.deepEqual(pgSelects.map((select) => select.limit), [200, 200]);
    assert.match(
      JSON.stringify(pgSelects.map((select) => select.where)),
      /method|receivedAt/,
      "PG report predicates include method and receivedAt",
    );
    assert.equal(
      JSON.stringify(pgExecutions).includes("statement_timeout"),
      true,
      "PG report applies a bounded statement timeout",
    );
    assert.equal(
      JSON.stringify(pgExecutions).includes("2500ms"),
      true,
      "PG report bounds each method statement to 2500ms",
    );
  }

  (Module as any)._load = originalLoad;
  console.log("✓ callback outcome repository offline tests passed");
}

main().catch((error) => {
  (Module as any)._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
