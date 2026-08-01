/**
 * Task #1012 — protractor_callback_events shadow-parity smoke test.
 *
 * Run: `npx tsx tests/protractor-callback-events-parity.smoke.ts`
 *
 * Exercises the repo's PROTRACTOR_OPS_PG_CANONICAL dispatch for
 * insertPostEvent / insertGetEvent / markProcessed / recordAttempt
 * against FAKE stores (no DB access — dev Mongo is prod), pinning:
 *
 *   1. Flag OFF (default): Mongo writes are byte-identical to the
 *      pre-task-#1006 shape — exact document keys, no `eventKey`
 *      field, updates target `_id` — and PG is NEVER touched.
 *   2. Flag ON: PG receives the write keyed by an app UUID, the
 *      return key IS that UUID, and the Mongo shadow doc carries the
 *      same `eventKey` with otherwise-matching fields (so the
 *      cutover-parity script can join the two stores on it).
 *   3. Flag ON updates: pg.markProcessedByKey / pg.recordAttempt get
 *      the UUID; shadow Mongo updates filter on `{ eventKey }` (a
 *      UUID never matches an ObjectId filter).
 *   4. Shadow-write kill switch (WRITE_MONGO_PROTRACTOR_OPS=0):
 *      flag-ON writes touch PG only.
 *   5. Shadow-write failures are swallowed (non-fatal).
 */
import Module from "node:module";
import { ObjectId } from "mongodb";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  \u2713 ${name}`);
  else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

/* ---- fake Mongo store ---------------------------------------------------- */

type MongoOp =
  | { op: "insertOne"; doc: Record<string, unknown> }
  | { op: "updateOne"; filter: Record<string, unknown>; update: Record<string, unknown> };

const mongoOps: MongoOp[] = [];
let mongoThrowNext = false;
let lastInsertedId: ObjectId | null = null;

const fakeCollection = {
  insertOne: async (doc: Record<string, unknown>) => {
    if (mongoThrowNext) {
      mongoThrowNext = false;
      throw new Error("simulated mongo outage");
    }
    mongoOps.push({ op: "insertOne", doc });
    lastInsertedId = new ObjectId();
    return { insertedId: lastInsertedId };
  },
  updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    if (mongoThrowNext) {
      mongoThrowNext = false;
      throw new Error("simulated mongo outage");
    }
    mongoOps.push({ op: "updateOne", filter, update });
    return { matchedCount: 1, modifiedCount: 1 };
  },
};
const dbStub = {
  getDb: async () => ({ collection: () => fakeCollection }),
  getMongoClient: async () => ({}),
};

/* ---- fake PG repo module -------------------------------------------------- */

const pgCalls: Array<{ fn: string; args: unknown[] }> = [];
function pgFn(name: string, ret?: unknown) {
  return async (...args: unknown[]) => {
    pgCalls.push({ fn: name, args });
    return ret;
  };
}
// Plain object (not a Proxy) — tsx's __importStar copies own keys, so a
// keyless Proxy would flatten to an empty namespace.
const pgStub = {
  __esModule: true,
  insertPostEvent: pgFn("insertPostEvent"),
  insertGetEvent: pgFn("insertGetEvent"),
  countRecentByConnection: pgFn("countRecentByConnection", 0),
  hasRecentProcessedPost: pgFn("hasRecentProcessedPost", false),
  findRecentProcessedGet: pgFn("findRecentProcessedGet", null),
  markProcessedByKey: pgFn("markProcessedByKey"),
  markOneProcessedByWorkOrderStatus: pgFn("markOneProcessedByWorkOrderStatus"),
  markOneProcessedByObject: pgFn("markOneProcessedByObject"),
  recordAttempt: pgFn("recordAttempt"),
  recordProcessingStarted: pgFn("recordProcessingStarted"),
  recordError: pgFn("recordError"),
  findPendingGetEvents: pgFn("findPendingGetEvents", []),
  countsByShopSince: pgFn("countsByShopSince", []),
  countGetSince: pgFn("countGetSince", 0),
  connectionShopPairs: pgFn("connectionShopPairs", []),
};

/* ---- module interception --------------------------------------------------
 * The repo imports the Mongo handle from "@/lib/data/db" and the PG
 * surface from "./pg/protractor-callback-events"; intercept both. */
const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request.includes("pg/protractor-callback-events")) return pgStub;
  if (request === "@/lib/data/db" || request.endsWith("/lib/data/db")) return dbStub;
  if (request === "@/lib/mongo" || request.endsWith("/lib/mongo")) return dbStub;
  return origLoad.call(this, request, parent, isMain);
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reset() {
  mongoOps.length = 0;
  pgCalls.length = 0;
}

async function main() {
  delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
  delete process.env.WRITE_MONGO_PROTRACTOR_OPS;

  const repo = await import("../lib/data/repositories/protractor-callback-events");

  /* ================= 1. Flag OFF — byte-identical Mongo ================= */
  console.log("\nflag OFF (Mongo canonical)");
  reset();

  const postKey = await repo.insertPostEvent({
    payload: { hello: "world" },
    workOrderId: "WO-1",
    status: "Deposited",
    connectionId: "conn-1",
    shopId: 42,
  });
  {
    const ins = mongoOps[0];
    ok("insertPostEvent writes one Mongo doc", ins?.op === "insertOne");
    const doc = (ins as any)?.doc ?? {};
    ok(
      "POST doc keys are the exact legacy shape (no eventKey/method)",
      JSON.stringify(Object.keys(doc).sort()) ===
        JSON.stringify(["connectionId", "payload", "processed", "receivedAt", "shopId", "status", "workOrderId"]),
      `got keys: ${Object.keys(doc).sort().join(",")}`,
    );
    ok("POST doc processed=false", doc.processed === false);
    ok("returned key is the inserted ObjectId hex", postKey === lastInsertedId?.toHexString());
    ok("PG never touched with flag OFF (insert)", pgCalls.length === 0);
  }

  const getKey = await repo.insertGetEvent({
    connectionId: "conn-1",
    objectType: "WorkOrder",
    objectId: "obj-9",
    operation: "Modified",
    shopId: 42,
  });
  {
    const doc = (mongoOps[1] as any)?.doc ?? {};
    ok(
      "GET doc keys are the exact legacy shape",
      JSON.stringify(Object.keys(doc).sort()) ===
        JSON.stringify([
          "attempts", "connectionId", "method", "objectId", "objectType",
          "operation", "priority", "processed", "receivedAt", "shopId",
        ]),
      `got keys: ${Object.keys(doc).sort().join(",")}`,
    );
    ok("GET doc method/attempts/priority defaults", doc.method === "GET" && doc.attempts === 0 && doc.priority === 1);
    ok("GET returned key is ObjectId hex", /^[0-9a-f]{24}$/.test(getKey));
  }

  await repo.markProcessed(postKey, { vin: "VIN123", noAction: true });
  {
    const upd = mongoOps[2] as any;
    ok("markProcessed targets _id with an ObjectId", upd?.filter?._id instanceof ObjectId && upd.filter._id.toHexString() === postKey);
    const set = upd?.update?.$set ?? {};
    ok(
      "markProcessed $set exact fields",
      set.processed === true && set.processedAt instanceof Date && set.vin === "VIN123" && set.noAction === true &&
        JSON.stringify(Object.keys(set).sort()) === JSON.stringify(["noAction", "processed", "processedAt", "vin"]),
    );
  }

  await repo.recordAttempt(getKey, "boom ".repeat(200));
  {
    const upd = mongoOps[3] as any;
    ok("recordAttempt targets _id", upd?.filter?._id instanceof ObjectId);
    ok("recordAttempt $inc attempts:1", upd?.update?.$inc?.attempts === 1);
    ok("recordAttempt truncates lastError to 500", String(upd?.update?.$set?.lastError ?? "").length === 500);
    ok("recordAttempt stamps lastAttemptAt", upd?.update?.$set?.lastAttemptAt instanceof Date);
  }
  ok("PG never touched with flag OFF (all ops)", pgCalls.length === 0);

  /* ================= 2/3. Flag ON — PG canonical + Mongo shadow ========= */
  console.log("\nflag ON (PG canonical, shadow on)");
  process.env.PROTRACTOR_OPS_PG_CANONICAL = "1";
  reset();

  const key2 = await repo.insertPostEvent({
    payload: { p: 1 },
    workOrderId: "WO-2",
    status: null,
    connectionId: "conn-2",
    shopId: "77", // string shopId must be coerced for PG
  });
  {
    ok("flag-ON key is a UUID", UUID_RE.test(key2));
    const pgIns = pgCalls[0];
    ok("pg.insertPostEvent called first", pgIns?.fn === "insertPostEvent");
    const f = (pgIns?.args?.[0] ?? {}) as any;
    ok("PG insert carries the same eventKey", f.eventKey === key2);
    ok("PG shopId coerced to number", f.shopId === 77);
    const shadow = (mongoOps[0] as any)?.doc ?? {};
    ok("Mongo shadow doc carries the same eventKey", shadow.eventKey === key2);
    ok(
      "shadow doc matches PG fields (wo/status/conn/processed)",
      shadow.workOrderId === "WO-2" && shadow.status === null &&
        shadow.connectionId === "conn-2" && shadow.processed === false,
    );
    ok("shadow receivedAt equals PG receivedAt", shadow.receivedAt === f.receivedAt);
  }

  await repo.markProcessed(key2, { workOrderNumber: 555 });
  {
    ok("pg.markProcessedByKey gets the UUID", pgCalls[1]?.fn === "markProcessedByKey" && pgCalls[1]?.args?.[0] === key2);
    const upd = mongoOps[1] as any;
    ok("shadow markProcessed filters on {eventKey} (not _id)", upd?.filter?.eventKey === key2 && !("_id" in (upd?.filter ?? {})));
    ok("shadow markProcessed sets processed/workOrderNumber", upd?.update?.$set?.processed === true && upd?.update?.$set?.workOrderNumber === 555);
  }

  await repo.recordAttempt(key2, "err");
  {
    ok("pg.recordAttempt gets the UUID", pgCalls[2]?.fn === "recordAttempt" && pgCalls[2]?.args?.[0] === key2);
    const upd = mongoOps[2] as any;
    ok("shadow recordAttempt filters on {eventKey} + $inc attempts", upd?.filter?.eventKey === key2 && upd?.update?.$inc?.attempts === 1);
  }

  /* ================= 5. Shadow failure is non-fatal ====================== */
  mongoThrowNext = true;
  let threw = false;
  try {
    await repo.recordAttempt(key2);
  } catch {
    threw = true;
  }
  ok("shadow Mongo failure is swallowed (PG write still lands)", !threw && pgCalls[3]?.fn === "recordAttempt");

  /* ================= 4. Shadow kill switch =============================== */
  console.log("\nflag ON, WRITE_MONGO_PROTRACTOR_OPS=0 (shadow off)");
  process.env.WRITE_MONGO_PROTRACTOR_OPS = "0";
  reset();
  const key3 = await repo.insertGetEvent({
    connectionId: "c",
    objectType: "WorkOrder",
    objectId: "o",
    operation: null,
    shopId: 1,
  });
  await repo.markProcessed(key3);
  ok("shadow-off: PG-only writes", pgCalls.length === 2 && mongoOps.length === 0);
  ok("shadow-off key still a UUID", UUID_RE.test(key3));

  delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
  delete process.env.WRITE_MONGO_PROTRACTOR_OPS;

  console.log("");
  if (failed > 0) {
    console.error(`${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
