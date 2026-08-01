/**
 * Task #1016 — protractor_callback_events READ-path parity smoke test.
 *
 * Run: `npx tsx tests/protractor-callback-events-read-parity.smoke.ts`
 *
 * The task #1012 smoke covers the write dispatch; this one covers the
 * READ paths that would silently cause duplicate work-order syncs or
 * false webhook-health alerts if the PG queries drift from the Mongo
 * query shapes:
 *
 *   - hasRecentProcessedPost   (POST dedup, incl. NULL-status matching)
 *   - findRecentProcessedGet   (GET dedup, incl. NULL-operation matching)
 *   - findPendingGetEvents     (queue ordering: priority asc, receivedAt
 *                               asc; attempts cap incl. missing-attempts
 *                               docs; limit; processed excluded)
 *   - countGetSince            (webhook-health lag windows)
 *
 * DB-free: the same logical events are seeded into a fake in-memory
 * Mongo collection (legacy doc shape, real query-matching semantics)
 * and a fake PG layer that re-implements the real
 * lib/data/repositories/pg/protractor-callback-events.ts predicates
 * over plain rows. Every read is executed through the repo TWICE —
 * flag OFF (Mongo arm) and flag ON (PG arm) — and the results must be
 * identical.
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

/* ---- time fixtures -------------------------------------------------------- */

const SINCE = new Date("2026-01-10T00:00:00Z");
const BEFORE = new Date("2026-01-09T00:00:00Z"); // outside every window
const T1 = new Date("2026-01-10T01:00:00Z");
const T2 = new Date("2026-01-10T02:00:00Z");
const T3 = new Date("2026-01-10T03:00:00Z");
const T5 = new Date("2026-01-10T05:00:00Z");

/* ---- logical events -------------------------------------------------------
 * One list of logical events, seeded into BOTH stores.  `attempts:
 * undefined` means "field missing" in Mongo and NULL in PG — the
 * missing-attempts case the queue query must include. */

interface Ev {
  label: string;
  method: "POST" | "GET";
  receivedAt: Date;
  connectionId: string;
  shopId: number;
  // POST
  workOrderId?: string;
  status?: string | null;
  // GET
  objectType?: string;
  objectId?: string;
  operation?: string | null;
  priority?: number;
  attempts?: number; // undefined = missing (Mongo) / NULL (PG)
  processed: boolean;
  processedAt?: Date;
}

const EVENTS: Ev[] = [
  // POST dedup fixtures
  { label: "post-null-status-processed", method: "POST", receivedAt: T1, connectionId: "c1", shopId: 1, workOrderId: "WO-A", status: null, processed: true, processedAt: T2 },
  { label: "post-deposited-processed", method: "POST", receivedAt: T1, connectionId: "c1", shopId: 1, workOrderId: "WO-A", status: "Deposited", processed: true, processedAt: T2 },
  { label: "post-null-status-old", method: "POST", receivedAt: BEFORE, connectionId: "c1", shopId: 1, workOrderId: "WO-B", status: null, processed: true, processedAt: BEFORE },
  { label: "post-unprocessed", method: "POST", receivedAt: T1, connectionId: "c1", shopId: 1, workOrderId: "WO-C", status: "Open", processed: false },
  // GET dedup fixtures
  { label: "get-null-op-processed", method: "GET", receivedAt: T1, connectionId: "c1", shopId: 1, objectType: "WorkOrder", objectId: "O1", operation: null, priority: 1, attempts: 1, processed: true, processedAt: T3 },
  { label: "get-modified-processed", method: "GET", receivedAt: T1, connectionId: "c1", shopId: 1, objectType: "WorkOrder", objectId: "O2", operation: "Modified", priority: 1, attempts: 1, processed: true, processedAt: T3 },
  { label: "get-modified-old", method: "GET", receivedAt: BEFORE, connectionId: "c1", shopId: 1, objectType: "WorkOrder", objectId: "O3", operation: "Modified", priority: 1, attempts: 1, processed: true, processedAt: BEFORE },
  // GET queue fixtures (maxAttempts cap = 5 below)
  { label: "pend-attempts2", method: "GET", receivedAt: T3, connectionId: "c2", shopId: 2, objectType: "WorkOrder", objectId: "P1", operation: "Modified", priority: 1, attempts: 2, processed: false },
  { label: "pend-missing-attempts-pri0", method: "GET", receivedAt: T5, connectionId: "c2", shopId: 2, objectType: "WorkOrder", objectId: "P2", operation: null, priority: 0, attempts: undefined, processed: false },
  { label: "pend-at-cap", method: "GET", receivedAt: T1, connectionId: "c2", shopId: 2, objectType: "WorkOrder", objectId: "P3", operation: "Modified", priority: 1, attempts: 5, processed: false },
  { label: "pend-attempts0", method: "GET", receivedAt: T2, connectionId: "c2", shopId: 2, objectType: "WorkOrder", objectId: "P4", operation: "Created", priority: 1, attempts: 0, processed: false },
];

/* ---- fake Mongo store (legacy doc shape + real query semantics) ----------- */

type Doc = Record<string, unknown>;
const mongoDocs: Doc[] = EVENTS.map((e) => {
  const d: Doc = { _id: new ObjectId(), receivedAt: e.receivedAt, connectionId: e.connectionId, shopId: e.shopId, processed: e.processed };
  if (e.method === "POST") {
    // legacy POST docs have NO `method` field
    d.payload = { label: e.label };
    d.workOrderId = e.workOrderId;
    d.status = e.status ?? null;
  } else {
    d.method = "GET";
    d.objectType = e.objectType;
    d.objectId = e.objectId;
    d.operation = e.operation ?? null;
    d.priority = e.priority;
    if (e.attempts !== undefined) d.attempts = e.attempts; // missing when undefined
  }
  if (e.processedAt) d.processedAt = e.processedAt;
  return d;
});

function eqVal(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** Mongo matching semantics for the filter shapes the repo uses. */
function mongoMatch(doc: Doc, filter: Doc): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$or") {
      if (!(v as Doc[]).some((sub) => mongoMatch(doc, sub))) return false;
      continue;
    }
    const dv = doc[k];
    if (v === null) {
      // Mongo: {field: null} matches null OR missing
      if (dv !== null && dv !== undefined) return false;
    } else if (v && typeof v === "object" && !(v instanceof Date)) {
      const cond = v as Doc;
      for (const [op, cv] of Object.entries(cond)) {
        if (op === "$gte") {
          if (!(dv instanceof Date) || dv.getTime() < (cv as Date).getTime()) return false;
        } else if (op === "$lt") {
          if (typeof dv !== "number" || !(dv < (cv as number))) return false;
        } else if (op === "$exists") {
          if (cv ? dv === undefined : dv !== undefined) return false;
        } else if (op === "$in") {
          if (!(cv as unknown[]).some((x) => eqVal(dv, x))) return false;
        } else {
          throw new Error(`fake Mongo: unsupported operator ${op}`);
        }
      }
    } else if (!eqVal(dv, v)) return false;
  }
  return true;
}

function mongoSort(docs: Doc[], spec: Record<string, 1 | -1>): Doc[] {
  const keys = Object.entries(spec);
  return [...docs].sort((a, b) => {
    for (const [k, dir] of keys) {
      const av = a[k], bv = b[k];
      const an = av instanceof Date ? av.getTime() : (av as number);
      const bn = bv instanceof Date ? bv.getTime() : (bv as number);
      if (an < bn) return -1 * dir;
      if (an > bn) return 1 * dir;
    }
    return 0;
  });
}

const fakeCollection = {
  findOne: async (filter: Doc) => mongoDocs.find((d) => mongoMatch(d, filter)) ?? null,
  countDocuments: async (filter: Doc) => mongoDocs.filter((d) => mongoMatch(d, filter)).length,
  find: (filter: Doc) => {
    let sortSpec: Record<string, 1 | -1> = {};
    let lim = Infinity;
    const cursor = {
      sort(s: Record<string, 1 | -1>) { sortSpec = s; return cursor; },
      limit(n: number) { lim = n; return cursor; },
      async toArray() {
        return mongoSort(mongoDocs.filter((d) => mongoMatch(d, filter)), sortSpec).slice(0, lim === Infinity ? undefined : lim);
      },
    };
    return cursor;
  },
};
const dbStub = {
  getDb: async () => ({ collection: () => fakeCollection }),
  getMongoClient: async () => ({}),
};

/* ---- fake PG layer (rows + the real module's predicate semantics) --------- */

interface PgRow {
  eventKey: string;
  receivedAt: Date;
  method: string | null;
  connectionId: string;
  shopId: number;
  workOrderId: string | null;
  status: string | null;
  objectType: string | null;
  objectId: string | null;
  operation: string | null;
  priority: number | null;
  attempts: number | null;
  processed: boolean;
  processedAt: Date | null;
}

const pgRows: PgRow[] = EVENTS.map((e, i) => ({
  eventKey: `key-${i}-${e.label}`,
  receivedAt: e.receivedAt,
  method: e.method === "GET" ? "GET" : null,
  connectionId: e.connectionId,
  shopId: e.shopId,
  workOrderId: e.workOrderId ?? null,
  status: e.method === "POST" ? e.status ?? null : null,
  objectType: e.objectType ?? null,
  objectId: e.objectId ?? null,
  operation: e.method === "GET" ? e.operation ?? null : null,
  priority: e.priority ?? null,
  attempts: e.attempts ?? null, // NULL in PG for the missing case
  processed: e.processed,
  processedAt: e.processedAt ?? null,
}));

// SQL semantics: NULL comparisons are never true; explicit IS NULL branches
// mirror the real pg module's `status == null ? IS NULL : eq(...)`.
const pgStub = {
  __esModule: true,
  hasRecentProcessedPost: async (workOrderId: string, status: string | null, since: Date) =>
    pgRows.some(
      (r) =>
        r.workOrderId === workOrderId &&
        (status == null ? r.status === null : r.status === status) &&
        r.processed === true &&
        r.processedAt !== null && r.processedAt >= since,
    ),
  findRecentProcessedGet: async (
    shopId: number, objectType: string, objectId: string, operation: string | null, since: Date,
  ) => {
    const row = pgRows.find(
      (r) =>
        r.shopId === shopId &&
        r.objectType === objectType &&
        r.objectId === objectId &&
        (operation == null ? r.operation === null : r.operation === operation) &&
        r.processed === true &&
        r.processedAt !== null && r.processedAt >= since,
    );
    return row?.processedAt ? { processedAt: row.processedAt } : null;
  },
  findPendingGetEvents: async (limit: number, maxAttempts: number) =>
    pgRows
      .filter(
        (r) =>
          r.method === "GET" &&
          r.processed === false &&
          r.eventKey !== null &&
          (r.attempts === null || r.attempts < maxAttempts),
      )
      .sort((a, b) =>
        (a.priority! - b.priority!) || (a.receivedAt.getTime() - b.receivedAt.getTime()),
      )
      .slice(0, limit)
      .map((r) => ({
        eventKey: r.eventKey,
        shopId: r.shopId,
        objectType: r.objectType,
        objectId: r.objectId,
        operation: r.operation,
      })),
  countGetSince: async (field: "receivedAt" | "processedAt", since: Date) =>
    pgRows.filter((r) => {
      const v = field === "receivedAt" ? r.receivedAt : r.processedAt;
      return r.method === "GET" && v !== null && v >= since;
    }).length,
  countRecentByConnection: async (connectionId: string, windowStart: Date) =>
    pgRows.filter((r) => r.connectionId === connectionId && r.receivedAt >= windowStart).length,
};

/* ---- module interception --------------------------------------------------- */

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request.includes("pg/protractor-callback-events")) return pgStub;
  if (request === "@/lib/data/db" || request.endsWith("/lib/data/db")) return dbStub;
  if (request === "@/lib/mongo" || request.endsWith("/lib/mongo")) return dbStub;
  return origLoad.call(this, request, parent, isMain);
};

/* ---- both-arms harness ------------------------------------------------------ */

type Repo = typeof import("../lib/data/repositories/protractor-callback-events");

async function bothArms<T>(repo: Repo, fn: (r: Repo) => Promise<T>): Promise<{ mongo: T; pg: T }> {
  delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
  const mongo = await fn(repo);
  process.env.PROTRACTOR_OPS_PG_CANONICAL = "1";
  const pg = await fn(repo);
  delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
  return { mongo, pg };
}

async function main() {
  delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
  delete process.env.WRITE_MONGO_PROTRACTOR_OPS;
  const repo: Repo = await import("../lib/data/repositories/protractor-callback-events");

  /* ============ hasRecentProcessedPost (POST dedup) ============ */
  console.log("\nhasRecentProcessedPost — POST dedup");
  {
    const nullHit = await bothArms(repo, (r) => r.hasRecentProcessedPost("WO-A", null, SINCE));
    ok("NULL-status dup found in both arms", nullHit.mongo === true && nullHit.pg === true, JSON.stringify(nullHit));

    const statusHit = await bothArms(repo, (r) => r.hasRecentProcessedPost("WO-A", "Deposited", SINCE));
    ok("string-status dup found in both arms", statusHit.mongo === true && statusHit.pg === true, JSON.stringify(statusHit));

    const wrongStatus = await bothArms(repo, (r) => r.hasRecentProcessedPost("WO-A", "Invoiced", SINCE));
    ok("non-matching status misses in both arms", wrongStatus.mongo === false && wrongStatus.pg === false, JSON.stringify(wrongStatus));

    const oldOne = await bothArms(repo, (r) => r.hasRecentProcessedPost("WO-B", null, SINCE));
    ok("processedAt before window misses in both arms", oldOne.mongo === false && oldOne.pg === false, JSON.stringify(oldOne));

    const unprocessed = await bothArms(repo, (r) => r.hasRecentProcessedPost("WO-C", "Open", SINCE));
    ok("unprocessed event misses in both arms", unprocessed.mongo === false && unprocessed.pg === false, JSON.stringify(unprocessed));
  }

  /* ============ findRecentProcessedGet (GET dedup) ============ */
  console.log("\nfindRecentProcessedGet — GET dedup");
  {
    const nullOp = await bothArms(repo, (r) => r.findRecentProcessedGet(1, "WorkOrder", "O1", null, SINCE));
    ok(
      "NULL-operation dup found in both arms with same processedAt",
      nullOp.mongo?.processedAt?.getTime() === T3.getTime() && nullOp.pg?.processedAt?.getTime() === T3.getTime(),
      JSON.stringify(nullOp),
    );

    const modOp = await bothArms(repo, (r) => r.findRecentProcessedGet(1, "WorkOrder", "O2", "Modified", SINCE));
    ok(
      "string-operation dup found in both arms with same processedAt",
      modOp.mongo?.processedAt?.getTime() === T3.getTime() && modOp.pg?.processedAt?.getTime() === T3.getTime(),
      JSON.stringify(modOp),
    );

    const crossOp = await bothArms(repo, (r) => r.findRecentProcessedGet(1, "WorkOrder", "O2", null, SINCE));
    ok("NULL query does NOT match string-operation row in either arm", crossOp.mongo === null && crossOp.pg === null, JSON.stringify(crossOp));

    const oldOp = await bothArms(repo, (r) => r.findRecentProcessedGet(1, "WorkOrder", "O3", "Modified", SINCE));
    ok("out-of-window processed GET misses in both arms", oldOp.mongo === null && oldOp.pg === null, JSON.stringify(oldOp));

    const wrongShop = await bothArms(repo, (r) => r.findRecentProcessedGet(99, "WorkOrder", "O1", null, SINCE));
    ok("wrong shopId misses in both arms", wrongShop.mongo === null && wrongShop.pg === null, JSON.stringify(wrongShop));
  }

  /* ============ findPendingGetEvents (queue ordering + attempts cap) ===== */
  console.log("\nfindPendingGetEvents — queue read");
  {
    const res = await bothArms(repo, (r) => r.findPendingGetEvents(10, 5));
    const mOrder = res.mongo.map((e) => e.objectId);
    const pOrder = res.pg.map((e) => e.objectId);
    ok(
      "queue order identical: priority asc then receivedAt asc (P2,P4,P1)",
      JSON.stringify(mOrder) === JSON.stringify(["P2", "P4", "P1"]) && JSON.stringify(pOrder) === JSON.stringify(mOrder),
      `mongo=${mOrder.join(",")} pg=${pOrder.join(",")}`,
    );
    ok("at-cap (attempts=5) excluded in both arms", !mOrder.includes("P3") && !pOrder.includes("P3"));
    ok("missing-attempts doc included in both arms", mOrder.includes("P2") && pOrder.includes("P2"));
    ok(
      "processed GETs excluded in both arms",
      !mOrder.some((o) => ["O1", "O2", "O3"].includes(o!)) && !pOrder.some((o) => ["O1", "O2", "O3"].includes(o!)),
    );
    ok(
      "row fields identical across arms (shopId/objectType/operation)",
      JSON.stringify(res.mongo.map(({ key, ...rest }) => rest)) === JSON.stringify(res.pg.map(({ key, ...rest }) => rest)),
      JSON.stringify(res),
    );
    ok(
      "mongo keys are ObjectId hex, pg keys are event keys",
      res.mongo.every((e) => /^[0-9a-f]{24}$/.test(e.key)) && res.pg.every((e) => e.key.startsWith("key-")),
    );

    const limited = await bothArms(repo, (r) => r.findPendingGetEvents(2, 5));
    ok(
      "limit honored identically (P2,P4)",
      JSON.stringify(limited.mongo.map((e) => e.objectId)) === JSON.stringify(["P2", "P4"]) &&
        JSON.stringify(limited.pg.map((e) => e.objectId)) === JSON.stringify(["P2", "P4"]),
      JSON.stringify(limited),
    );

    const strictCap = await bothArms(repo, (r) => r.findPendingGetEvents(10, 2));
    const mStrict = strictCap.mongo.map((e) => e.objectId);
    const pStrict = strictCap.pg.map((e) => e.objectId);
    ok(
      "tighter cap (maxAttempts=2) drops attempts>=2 but keeps missing-attempts, identically",
      JSON.stringify(mStrict) === JSON.stringify(["P2", "P4"]) && JSON.stringify(pStrict) === JSON.stringify(mStrict),
      `mongo=${mStrict.join(",")} pg=${pStrict.join(",")}`,
    );
  }

  /* ============ countGetSince (webhook-health lag) ============ */
  console.log("\ncountGetSince — webhook-health lag windows");
  {
    // GET events with receivedAt >= SINCE: O1, O2, P1, P2, P4 (not O3@BEFORE, not P3? P3 is T1 >= SINCE) => O1,O2,P1,P2,P3,P4 = 6
    const recv = await bothArms(repo, (r) => r.countGetSince("receivedAt", SINCE));
    ok("receivedAt window counts match", recv.mongo === recv.pg && recv.mongo === 6, JSON.stringify(recv));

    // GET events processed within window: O1, O2 (O3 processed BEFORE; pendings have no processedAt)
    const proc = await bothArms(repo, (r) => r.countGetSince("processedAt", SINCE));
    ok("processedAt window counts match (missing/NULL processedAt excluded)", proc.mongo === proc.pg && proc.mongo === 2, JSON.stringify(proc));

    // POST docs (no method field / NULL method) never counted
    const all = await bothArms(repo, (r) => r.countGetSince("receivedAt", BEFORE));
    ok("POST events never counted as GET in either arm", all.mongo === all.pg && all.mongo === 7, JSON.stringify(all));
  }

  /* ============ countRecentByConnection (rate limit) ============ */
  console.log("\ncountRecentByConnection — rate-limit read");
  {
    const c1 = await bothArms(repo, (r) => r.countRecentByConnection("c1", SINCE));
    ok("connection window counts match (c1)", c1.mongo === c1.pg && c1.mongo === 5, JSON.stringify(c1));
    const c2 = await bothArms(repo, (r) => r.countRecentByConnection("c2", SINCE));
    ok("connection window counts match (c2)", c2.mongo === c2.pg && c2.mongo === 4, JSON.stringify(c2));
  }

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
