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
import { replayableCallbackWindowWinners } from "../lib/integrations/protractor/callback-selection";

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
  historyOutcomeReason?: string;
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
  { label: "pend-safety-boundary", method: "GET", receivedAt: T3, connectionId: "c4", shopId: 4, objectType: "ServiceItem", objectId: "P5", operation: "Modified", priority: 1, attempts: 2, historyOutcomeReason: "safety_boundary", processed: false },
  { label: "pend-missing-vin", method: "GET", receivedAt: T2, connectionId: "c4", shopId: 4, objectType: "ServiceItem", objectId: "P6", operation: "Modified", priority: 1, attempts: 2, historyOutcomeReason: "missing_vin", processed: false },
  // Exact-case Contacts have no replay handler even before their deferral
  // outcome is persisted. A differently-cased provider type remains outside
  // that exact safety boundary.
  { label: "contact-pending", method: "GET", receivedAt: T5, connectionId: "c3", shopId: 3, objectType: "Contact", objectId: "C1", operation: "Modified", priority: 0, attempts: 0, processed: false },
  { label: "contact-lowercase", method: "GET", receivedAt: T1, connectionId: "c3", shopId: 3, objectType: "contact", objectId: "C2", operation: "Modified", priority: 1, attempts: 0, processed: false },
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
    if (e.historyOutcomeReason) {
      d.historyOutcome = { category: "deferred", reason: e.historyOutcomeReason };
    }
  }
  if (e.processedAt) d.processedAt = e.processedAt;
  return d;
});

function eqVal(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
  return a === b;
}

/** Mongo matching semantics for the filter shapes the repo uses. */
function mongoMatch(doc: Doc, filter: Doc): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$and") {
      if (!(v as Doc[]).every((sub) => mongoMatch(doc, sub))) return false;
      continue;
    }
    if (k === "$or") {
      if (!(v as Doc[]).some((sub) => mongoMatch(doc, sub))) return false;
      continue;
    }
    const dv = k.split(".").reduce<unknown>(
      (value, part) => value && typeof value === "object"
        ? (value as Doc)[part]
        : undefined,
      doc,
    );
    if (v === null) {
      // Mongo: {field: null} matches null OR missing
      if (dv !== null && dv !== undefined) return false;
    } else if (v && typeof v === "object" && !(v instanceof Date)) {
      const cond = v as Doc;
      for (const [op, cv] of Object.entries(cond)) {
        if (op === "$gte") {
          if (!(dv instanceof Date) || dv.getTime() < (cv as Date).getTime()) return false;
        } else if (op === "$gt") {
          if (dv instanceof Date && cv instanceof Date) {
            if (dv.getTime() <= cv.getTime()) return false;
          } else if (dv instanceof ObjectId && cv instanceof ObjectId) {
            if (dv.toHexString() <= cv.toHexString()) return false;
          } else if (!(typeof dv === "number" && dv > (cv as number))) {
            return false;
          }
        } else if (op === "$lt") {
          if (typeof dv !== "number" || !(dv < (cv as number))) return false;
        } else if (op === "$exists") {
          if (cv ? dv === undefined : dv !== undefined) return false;
        } else if (op === "$ne") {
          // Mongo's $ne includes documents where the field is absent.
          if (dv !== undefined && eqVal(dv, cv)) return false;
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
      const an = av instanceof Date ? av.getTime() : av instanceof ObjectId ? av.toHexString() : (av as number);
      const bn = bv instanceof Date ? bv.getTime() : bv instanceof ObjectId ? bv.toHexString() : (bv as number);
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
        const out = mongoSort(mongoDocs.filter((d) => mongoMatch(d, filter)), sortSpec).slice(0, lim === Infinity ? undefined : lim);
        return out;
      },
    };
    return cursor;
  },
};
const fairnessDocs = new Map<string, Doc>();
let forceCursorCasLoss = false;
const fairnessCollection = {
  findOne: async (filter: Doc) => fairnessDocs.get(String(filter._id)) ?? null,
  updateOne: async (filter: Doc, update: Doc, options?: Doc) => {
    const id = String(filter._id);
    const current = fairnessDocs.get(id);
    const expectedRevision = filter.callbackRecoveryCursorRevision;
    const initializing = (filter.$or as Doc[] | undefined)?.some((part) =>
      (part.callbackRecoveryCursorRevision as any)?.$exists === false ||
      part.callbackRecoveryCursorRevision === 0,
    );
    const revisionMatches = expectedRevision === undefined
      ? true
      : current?.callbackRecoveryCursorRevision === expectedRevision;
    const missingInitializerMatches = !!initializing &&
      (current?.callbackRecoveryCursorRevision === undefined || current?.callbackRecoveryCursorRevision === 0);
    if (forceCursorCasLoss || (!revisionMatches && !missingInitializerMatches) || (!current && !options?.upsert)) {
      forceCursorCasLoss = false;
      return { matchedCount: 0, upsertedCount: 0 };
    }
    const next = {
      _id: id,
      ...(current ?? {}),
      ...(update.$set as Doc),
      callbackRecoveryCursorRevision:
        Number(current?.callbackRecoveryCursorRevision ?? 0) +
          Number((update.$inc as any)?.callbackRecoveryCursorRevision ?? 0),
    };
    fairnessDocs.set(id, next);
    return { matchedCount: current ? 1 : 0, upsertedCount: current ? 0 : 1 };
  },
  find: (filter: Doc) => ({
    toArray: async () => {
      const ids = (filter._id as Doc).$in as unknown[];
      return [...fairnessDocs.values()].filter((doc) => ids.includes(doc._id));
    },
  }),
};
const dbStub = {
  getDb: async () => ({
    collection: (name: string) =>
      name === "protractor_callback_fairness" ? fairnessCollection : fakeCollection,
  }),
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
  historyOutcomeReason: string | null;
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
  historyOutcomeReason: e.historyOutcomeReason ?? null,
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
  findPendingGetEvents: async (
    limit: number,
    maxAttempts: number,
    receivedNotBefore?: Date,
    recoveryLimit = 0,
  ) => {
    const eligible = pgRows
      .filter(
        (r) =>
          r.method === "GET" &&
          r.processed === false &&
          r.eventKey !== null &&
          (!receivedNotBefore || r.receivedAt >= receivedNotBefore) &&
            r.objectType !== "Contact" &&
           r.historyOutcomeReason !== "unsupported_contact" &&
          (r.attempts === null || r.attempts < maxAttempts),
      );
    const fresh = eligible
      .slice()
      .sort((a, b) =>
        (a.priority! - b.priority!) || (b.receivedAt.getTime() - a.receivedAt.getTime()),
      )
      .slice(0, limit);
    const freshKeys = new Set(fresh.map((r) => r.eventKey));
    const recovery = recoveryLimit > 0
      ? eligible
          .slice()
          .sort((a, b) =>
            (a.priority! - b.priority!) || (a.receivedAt.getTime() - b.receivedAt.getTime()),
          )
          .slice(0, recoveryLimit)
          .filter((r) => !freshKeys.has(r.eventKey))
      : [];
    return [...fresh, ...recovery]
      .map((r) => ({
        eventKey: r.eventKey,
        method: r.method,
        shopId: r.shopId,
        objectType: r.objectType,
        objectId: r.objectId,
        operation: r.operation,
        receivedAt: r.receivedAt,
        ...(recoveryLimit > 0 ? {
          selectionLane: freshKeys.has(r.eventKey) ? "fresh" as const : "recovery" as const,
        } : {}),
      }));
  },
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
  // Exercise PG -> public repository -> shared selection, including POST
  // formatting, so dropping the raw rank at the wrapper boundary is caught.
  const originalPendingRead = pgStub.findPendingGetEvents;
  try {
    (pgStub as any).findPendingGetEvents = async () => [
      { eventKey: "raw-older", method: "POST", shopId: 1, objectType: "WorkOrder",
        objectId: "rank-parity", operation: " CLOSED ", receivedAt: new Date(1000),
        terminalRank: 0, winnerTieBreaker: 1, terminalFromCoalesce: true },
      { eventKey: "raw-newer", method: "GET", shopId: 1, objectType: "WorkOrder",
        objectId: "rank-parity", operation: "Update", receivedAt: new Date(2000),
        terminalRank: 0, winnerTieBreaker: 2, terminalFromCoalesce: true },
    ];
    process.env.PROTRACTOR_OPS_PG_CANONICAL = "1";
    const mapped = await repo.findPendingGetEvents(10, 3);
    const chosen = replayableCallbackWindowWinners(mapped).winners;
    ok("PG raw terminal rank survives wrapper formatting and selection",
      mapped.every((row) => row.terminalRank === 0) &&
      chosen.length === 1 && chosen[0].key === "raw-newer");
  } finally {
    pgStub.findPendingGetEvents = originalPendingRead;
    delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
    fairnessDocs.clear();
  }

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
       "queue order identical: priority asc then fleet cursor (P2,P1,P4,C2,P5,P6)",
       JSON.stringify(mOrder) === JSON.stringify(["P2", "P1", "P4", "C2", "P5", "P6"]) && JSON.stringify(pOrder) === JSON.stringify(mOrder),
      `mongo=${mOrder.join(",")} pg=${pOrder.join(",")}`,
    );
    ok("at-cap (attempts=5) excluded in both arms", !mOrder.includes("P3") && !pOrder.includes("P3"));
    ok("missing-attempts doc included in both arms", mOrder.includes("P2") && pOrder.includes("P2"));
    ok(
       "exact-case pending Contact is excluded before the queue limit in both arms",
      !mOrder.includes("C1") && !pOrder.includes("C1"),
      `mongo=${mOrder.join(",")} pg=${pOrder.join(",")}`,
    );
    ok(
      "Contact exclusion uses the queue branch's exact-case semantics in both arms",
      mOrder.includes("C2") && pOrder.includes("C2"),
      `mongo=${mOrder.join(",")} pg=${pOrder.join(",")}`,
    );
    const replayCap = await bothArms(repo, (r) => r.findPendingGetEvents(10, 3));
    const replayMongo = replayCap.mongo.map((e) => e.objectId);
    const replayPg = replayCap.pg.map((e) => e.objectId);
    ok(
      "safety deferrals and missing_vin failures remain pending under maxAttempts=3",
      replayMongo.includes("P5") && replayMongo.includes("P6") &&
        JSON.stringify(replayMongo) === JSON.stringify(replayPg),
      `mongo=${replayMongo.join(",")} pg=${replayPg.join(",")}`,
    );
    ok(
      "processed GETs excluded in both arms",
      !mOrder.some((o) => ["O1", "O2", "O3"].includes(o!)) && !pOrder.some((o) => ["O1", "O2", "O3"].includes(o!)),
    );
    ok(
      "logical row fields identical across arms (store-local winner metadata ignored)",
      JSON.stringify(res.mongo.map(({ key, status: _status, winnerTieBreaker: _tie, terminalFromCoalesce: _terminal, ...rest }) => {
        delete (rest as Record<string, unknown>).terminalRank;
        return rest;
      })) ===
        JSON.stringify(res.pg.map(({ key, status: _status, winnerTieBreaker: _tie, terminalFromCoalesce: _terminal, ...rest }) => {
          delete (rest as Record<string, unknown>).terminalRank;
          return rest;
        })),
      JSON.stringify(res),
    );
    ok(
      "mongo keys are ObjectId hex, pg keys are event keys",
      res.mongo.every((e) => /^[0-9a-f]{24}$/.test(e.key)) && res.pg.every((e) => e.key.startsWith("key-")),
    );

    const limited = await bothArms(repo, (r) => r.findPendingGetEvents(2, 5));
    ok(
      "limit honored identically (P2,P1)",
      JSON.stringify(limited.mongo.map((e) => e.objectId)) === JSON.stringify(["P2", "P1"]) &&
        JSON.stringify(limited.pg.map((e) => e.objectId)) === JSON.stringify(["P2", "P1"]),
      JSON.stringify(limited),
    );

    const strictCap = await bothArms(repo, (r) => r.findPendingGetEvents(10, 2));
    const mStrict = strictCap.mongo.map((e) => e.objectId);
    const pStrict = strictCap.pg.map((e) => e.objectId);
    ok(
      "tighter cap (maxAttempts=2) drops attempts>=2 but keeps missing-attempts, identically",
       JSON.stringify(mStrict) === JSON.stringify(["P2", "P4", "C2"]) && JSON.stringify(pStrict) === JSON.stringify(mStrict),
      `mongo=${mStrict.join(",")} pg=${pStrict.join(",")}`,
    );
    const recovery = await bothArms(repo, (r) => r.findPendingGetEvents(2, 5, 10, undefined, 5));
    const recoveryMongo = recovery.mongo.filter((event) => event.selectionLane === "recovery");
    const recoveryPg = recovery.pg.filter((event) => event.selectionLane === "recovery");
    ok(
       "bounded oldest recovery lane preserves eligible safety/failure retries in both arms",
       recoveryMongo.some((event) => ["P5", "P6"].includes(event.objectId ?? "")) &&
         recoveryPg.some((event) => ["P5", "P6"].includes(event.objectId ?? "")),
      `mongo=${recoveryMongo.map((event) => event.objectId).join(",")} pg=${recoveryPg.map((event) => event.objectId).join(",")}`,
    );
    // Mongo's process-local tuple cursor moves past the first eligible page
    // even when that page is duplicated by the fresh window. This is what
    // prevents a terminal/duplicate-heavy old page from pinning recovery.
    delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
    fairnessDocs.clear();
    const firstRecoveryPage = await repo.findPendingGetEvents(2, 5, 10, undefined, 1);
    const secondRecoveryPage = await repo.findPendingGetEvents(2, 5, 10, undefined, 1);
    const thirdRecoveryPage = await repo.findPendingGetEvents(2, 5, 10, undefined, 1);
    ok(
      "Mongo recovery keyset advances beyond an already-fresh old page",
      secondRecoveryPage.some((event) => event.objectId === "P4" && event.selectionLane === "recovery") &&
        thirdRecoveryPage.some((event) =>
          ["P5", "P6"].includes(event.objectId ?? "") && event.selectionLane === "recovery",
        ),
      `first=${firstRecoveryPage.map((event) => event.objectId).join(",")} second=${secondRecoveryPage.map((event) => event.objectId).join(",")} third=${thirdRecoveryPage.map((event) => event.objectId).join(",")}`,
    );

    // The recovery read is intentionally raw: an exhausted/unsupported page
    // still advances its persisted tuple before replay eligibility is applied.
    // All 271 blockers share one timestamp, exercising the `_id` tie key.
    fairnessDocs.clear();
    const originalMongoDocCount = mongoDocs.length;
    const recoveryFloor = new Date("2027-01-01T00:00:00Z");
    const tiedAt = new Date("2027-01-01T00:00:01Z");
    for (let index = 0; index < 271; index += 1) {
      mongoDocs.push({
        _id: new ObjectId(),
        method: "GET",
        shopId: 88,
        objectType: "WorkOrder",
        objectId: `blocked-${index}`,
        operation: "Update",
        priority: 1,
        attempts: index % 2 === 0 ? 3 : 1,
        ...(index % 2 === 0
          ? {}
          : { historyOutcome: { category: "deferred", reason: "unsupported_contact" } }),
        receivedAt: tiedAt,
        processed: false,
      });
    }
    mongoDocs.push({
      _id: new ObjectId(),
      method: "GET",
      shopId: 88,
      objectType: "WorkOrder",
      objectId: "recovery-after-tied-blockers",
      operation: "Update",
      priority: 1,
      attempts: 1,
      historyOutcome: { category: "deferred", reason: "safety_boundary" },
      receivedAt: tiedAt,
      processed: false,
    });
    // Keep the useful recovery object out of the one-row fresh window.
    mongoDocs.push({
      _id: new ObjectId(),
      method: "GET",
      shopId: 89,
      objectType: "WorkOrder",
      objectId: "fresh-after-tied-blockers",
      operation: "Update",
      priority: 1,
      attempts: 0,
      receivedAt: new Date("2027-01-01T00:00:02Z"),
      processed: false,
    });
    const tiedRecovery = await repo.findPendingGetEvents(1, 3, 1, recoveryFloor, 270);
    const cursorDoc = fairnessDocs.get("protractor_callback_recovery_cursor:mongo:1798761600000");
    const persistedCursor = cursorDoc?.callbackRecoveryCursor as any;
    ok(
      "raw recovery cursor crosses >270 rejected equal-time rows without skipping safety retry",
      tiedRecovery.some((event) =>
        event.objectId === "recovery-after-tied-blockers" && event.selectionLane === "recovery",
      ) &&
        persistedCursor?.floorMs === recoveryFloor.getTime(),
      `recovery=${tiedRecovery.map((event) => event.objectId).join(",")}`,
    );
    ok(
      "Mongo recovery cursor is persisted in existing fairness metadata",
      persistedCursor?.id instanceof ObjectId,
    );
    // Simulate a new worker process: only the fairness document is supplied;
    // no module-local cursor state is available to the next recovery read.
    const cursorId = "protractor_callback_recovery_cursor:mongo:1798761600000";
    const firstTiedBlocker = mongoDocs.find((doc) => doc.objectId === "blocked-0")!;
    fairnessDocs.set(cursorId, {
      _id: cursorId,
      callbackRecoveryCursor: {
        method: "GET",
        priority: 1,
        receivedAt: tiedAt,
        id: firstTiedBlocker._id,
        floorMs: recoveryFloor.getTime(),
      },
    });
    const resumedRecovery = await repo.findPendingGetEvents(1, 3, 1, recoveryFloor, 270);
    ok(
      "persisted recovery tuple resumes after simulated process restart",
      resumedRecovery.some((event) => event.objectId === "recovery-after-tied-blockers"),
    );
    // A stale overlapping worker cannot move the shared cursor backward or
    // clear it during wrap; its recovery lane loses while fresh remains usable.
    fairnessDocs.set(cursorId, {
      _id: cursorId,
      callbackRecoveryCursorRevision: 9,
      callbackRecoveryCursor: {
        method: "GET",
        priority: 1,
        receivedAt: tiedAt,
        id: firstTiedBlocker._id,
        floorMs: recoveryFloor.getTime(),
      },
    });
    forceCursorCasLoss = true;
    const staleWriterRecovery = await repo.findPendingGetEvents(1, 3, 1, recoveryFloor, 270);
    const afterCasLoss = fairnessDocs.get(cursorId)!;
    ok(
      "Mongo stale recovery cursor writer loses CAS without clobbering progress",
      staleWriterRecovery.length === 1 &&
        staleWriterRecovery[0]?.objectId === "fresh-after-tied-blockers" &&
        afterCasLoss.callbackRecoveryCursorRevision === 9 &&
        (afterCasLoss.callbackRecoveryCursor as any)?.id.equals(firstTiedBlocker._id),
    );
    mongoDocs.splice(originalMongoDocCount);
    fairnessDocs.clear();
  }

  /* ============ durable Mongo recovery carry-over ======================= */
  {
    delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
    fairnessDocs.clear();
    const recoveryOriginalCount = mongoDocs.length;
    const carryFloor = new Date("2031-02-03T00:00:00Z");
    const carryAt = new Date("2031-02-03T00:00:01Z");
    const carryDocs: Doc[] = Array.from({ length: 6 }, (_, index) => ({
      _id: new ObjectId(),
      method: "GET",
      priority: 1,
      shopId: 777,
      objectType: "WorkOrder",
      objectId: `buffer-carry-over-${index}`,
      operation: index === 4 ? "DELETE" : "Update",
      attempts: 1,
      receivedAt: carryAt,
      processed: false,
    }));
    mongoDocs.push(...carryDocs);
    const carryId = `protractor_callback_recovery_cursor:mongo:${carryFloor.getTime()}`;
    const freshOnly = await repo.findPendingGetEvents(1, 3, 1, carryFloor);
    const carryFirst = await repo.findPendingGetEvents(1, 3, 1, carryFloor, 5);
    const carryState = fairnessDocs.get(carryId)!;
    const carryEntries = carryState.callbackRecoveryBuffer as Array<{ key: string; generation: string }>;
    const overlapKey = freshOnly[0]!.key;
    ok(
      "Mongo cursor and every eligible raw-page entry persist atomically",
      carryEntries.length === 6 && !!carryState.callbackRecoveryCursor &&
        typeof carryState.callbackRecoveryCursorRevision === "number",
    );
    ok(
      "fresh/recovery overlap is offered once as recovery",
      carryFirst.filter((event) => event.key === overlapKey).length === 1 &&
        carryFirst.find((event) => event.key === overlapKey)?.selectionLane === "recovery",
    );
    const firstEntry = carryEntries.find((entry) => entry.key === String(carryDocs[0]!._id))!;
    forceCursorCasLoss = true;
    await repo.acknowledgeRecoveryCandidate(firstEntry.key, firstEntry.generation, carryFloor);
    ok(
      "stale buffered ACK CAS loss retains work",
      (fairnessDocs.get(carryId)?.callbackRecoveryBuffer as Array<{ key: string }>).some(
        (entry) => entry.key === firstEntry.key,
      ),
    );
    await repo.acknowledgeRecoveryCandidate(firstEntry.key, firstEntry.generation, carryFloor);
    const afterAck = fairnessDocs.get(carryId)!;
    ok(
      "genuine ACK removes only its exact generation",
      !(afterAck.callbackRecoveryBuffer as Array<{ key: string }>).some(
        (entry) => entry.key === firstEntry.key,
      ),
    );
    carryDocs[0]!.processed = true;
    const nextBatch = await repo.findPendingGetEvents(1, 3, 1, carryFloor, 5);
    ok(
      "all five unselected distinct objects remain offered on the next invocation",
      carryDocs.slice(1).every((doc) => nextBatch.some((item) =>
        item.key === String(doc._id) && item.selectionLane === "recovery")),
    );
    fairnessDocs.set(carryId, {
      ...afterAck,
      callbackRecoveryBuffer: [
        ...(afterAck.callbackRecoveryBuffer as Array<{ key: string; generation: string }>),
        { key: firstEntry.key, generation: "newer-page-generation" },
      ],
    });
    await repo.acknowledgeRecoveryCandidate(firstEntry.key, firstEntry.generation, carryFloor);
    ok(
      "old-generation ACK cannot clear a newer page entry",
      (fairnessDocs.get(carryId)?.callbackRecoveryBuffer as Array<{ key: string; generation: string }>).some(
        (entry) => entry.key === firstEntry.key && entry.generation === "newer-page-generation",
      ),
    );
    await repo.acknowledgeRecoveryCandidate(firstEntry.key, "newer-page-generation", carryFloor);

    // A new invocation has no process-local state; it must reconstruct from
    // fairness metadata and recheck all ordinary eligibility guards.
    carryDocs[1]!.processed = true;
    carryDocs[2]!.attempts = 3;
    carryDocs[3]!.historyOutcome = { category: "deferred", reason: "unsupported_contact" };
    const resumed = await repo.findPendingGetEvents(1, 3, 1, carryFloor, 5);
    const resumedEntries = fairnessDocs.get(carryId)?.callbackRecoveryBuffer as Array<{ key: string; generation: string }>;
    ok(
      "restart retains unselected entries but prunes completed/exhausted/contact rows",
      resumed.some((event) => event.key === String(carryDocs[4]!._id)) &&
        !resumedEntries.some((entry) =>
          [String(carryDocs[1]!._id), String(carryDocs[2]!._id), String(carryDocs[3]!._id)]
            .includes(entry.key),
        ),
      `offered=${resumed.map((event) => event.key).join(",")} retained=${resumedEntries.map((entry) => entry.key).join(",")}`,
    );
    // Queue authority passes selected and in-memory-coalesced buffer entries
    // to this metadata-only prune; it must not complete the callback rows.
    await repo.pruneRecoveryCandidates(resumedEntries, carryFloor);
    ok(
      "authority-blocked coalesced prefix prunes metadata without completion",
      (fairnessDocs.get(carryId)?.callbackRecoveryBuffer as unknown[]).length === 0 &&
        carryDocs[4]!.processed === false,
    );
    mongoDocs.splice(recoveryOriginalCount);
    fairnessDocs.clear();
  }
  {
    delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
    fairnessDocs.clear();
    const originalLength = mongoDocs.length;
    const floor = new Date("2032-01-01T00:00:00Z");
    const waiting: Doc[] = Array.from({ length: 3 }, (_, index) => ({
      _id: new ObjectId(), method: "GET", priority: 1, shopId: 778,
      objectType: "WorkOrder", objectId: `successive-turn-${index}`,
      operation: "Update", attempts: 1, processed: false,
      receivedAt: new Date(floor.getTime() + 1000 + index),
    }));
    mongoDocs.push(...waiting);
    const offered = new Set<string>();
    for (let tick = 0; tick < waiting.length; tick++) {
      const batch = await repo.findPendingGetEvents(1, 3, 1, floor, 3);
      const recovery = batch.filter((item) => item.selectionLane === "recovery")
        .sort((a, b) => (a.recoveryBufferOrder ?? 0) - (b.recoveryBufferOrder ?? 0));
      ok(`batch ${tick + 1} retains every still-waiting candidate`,
        waiting.filter((doc) => !doc.processed).every((doc) =>
          recovery.some((item) => item.key === String(doc._id))));
      const selected = recovery[0]!;
      offered.add(selected.key);
      // Model one successful attempt/completion, never the whole selected page.
      waiting.find((doc) => String(doc._id) === selected.key)!.processed = true;
      await repo.acknowledgeRecoveryCandidate(
        selected.key, selected.recoveryBufferGeneration!, floor,
      );
    }
    ok("one recovery slot gives every eligible object its turn across three batches",
      offered.size === waiting.length);
    mongoDocs.splice(originalLength);
    fairnessDocs.clear();
  }
  {
    // Contacts must not fill the fixed 270-entry carry-over. In particular,
    // supported old work immediately following a full Contact prefix must be
    // retained, and Contacts accidentally persisted by an older scheduler must
    // be removed from metadata (not from callback records) on later reads.
    delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
    fairnessDocs.clear();
    const originalLength = mongoDocs.length;
    const contactFloor = new Date("2033-01-01T00:00:00Z");
    const contactAt = new Date("2033-01-01T00:00:01Z");
    const contactPrefix: Doc[] = Array.from({ length: 270 }, (_, index) => ({
      _id: new ObjectId(), method: "GET", priority: 1, shopId: 779,
      objectType: "Contact", objectId: `contact-prefix-${index}`,
      operation: "Update", attempts: 0, receivedAt: contactAt, processed: false,
    }));
    const workAfterContacts: Doc = {
      _id: new ObjectId(), method: "GET", priority: 1, shopId: 779,
      objectType: "WorkOrder", objectId: "work-after-contact-prefix",
      operation: "Update", attempts: 1,
      receivedAt: new Date(contactAt.getTime() + 1000), processed: false,
    };
    mongoDocs.push(...contactPrefix, workAfterContacts);
    const contactCursorId =
      `protractor_callback_recovery_cursor:mongo:${contactFloor.getTime()}`;
    const afterPrefix = await repo.findPendingGetEvents(0, 3, 0, contactFloor, 270);
    const afterPrefixState = fairnessDocs.get(contactCursorId)!;
    const afterPrefixEntries =
      afterPrefixState.callbackRecoveryBuffer as Array<{ key: string; generation: string }>;
    ok(
      "Mongo Contact prefix cannot consume recovery buffer capacity before supported work",
      afterPrefix.some((item) => item.key === String(workAfterContacts._id) &&
        item.selectionLane === "recovery") &&
        afterPrefixEntries.length === 1 &&
        afterPrefixEntries[0]?.key === String(workAfterContacts._id),
      `offered=${afterPrefix.map((item) => item.objectId).join(",")} retained=${afterPrefixEntries.map((entry) => entry.key).join(",")}`,
    );
    ok(
      "Mongo Contact prefix remains untouched notification records",
      contactPrefix.every((doc) => doc.processed === false && doc.attempts === 0),
    );
    fairnessDocs.set(contactCursorId, {
      ...afterPrefixState,
      callbackRecoveryBuffer: [
        { key: String(contactPrefix[0]!._id), generation: "stale-contact-one" },
        { key: String(contactPrefix[1]!._id), generation: "stale-contact-two" },
        ...afterPrefixEntries,
      ],
    });
    const afterBufferedContacts = await repo.findPendingGetEvents(0, 3, 0, contactFloor, 1);
    const afterBufferedState = fairnessDocs.get(contactCursorId)!;
    const afterBufferedEntries =
      afterBufferedState.callbackRecoveryBuffer as Array<{ key: string; generation: string }>;
    ok(
      "Mongo persisted Contact recovery entries are pruned across reads without evicting work",
      afterBufferedContacts.some((item) => item.key === String(workAfterContacts._id)) &&
        JSON.stringify(afterBufferedEntries.map((entry) => entry.key)) ===
          JSON.stringify([String(workAfterContacts._id)]),
      `offered=${afterBufferedContacts.map((item) => item.objectId).join(",")} retained=${afterBufferedEntries.map((entry) => entry.key).join(",")}`,
    );
    ok(
      "Mongo buffered Contact pruning never completes or resets Contact callbacks",
      contactPrefix.slice(0, 2).every((doc) => doc.processed === false && doc.attempts === 0),
    );
    mongoDocs.splice(originalLength);
    fairnessDocs.clear();
  }
  console.log("\ncountGetSince — webhook-health lag windows");
  {
     // GET events with receivedAt >= SINCE includes both Contact notifications;
    // webhook-health counts received callbacks even when queue replay omits it.
    const recv = await bothArms(repo, (r) => r.countGetSince("receivedAt", SINCE));
     ok("receivedAt window counts match", recv.mongo === recv.pg && recv.mongo === 10, JSON.stringify(recv));

    // GET events processed within window: O1, O2 (O3 processed BEFORE; pendings have no processedAt)
    const proc = await bothArms(repo, (r) => r.countGetSince("processedAt", SINCE));
    ok("processedAt window counts match (missing/NULL processedAt excluded)", proc.mongo === proc.pg && proc.mongo === 2, JSON.stringify(proc));

    // POST docs (no method field / NULL method) never counted
    const all = await bothArms(repo, (r) => r.countGetSince("receivedAt", BEFORE));
     ok("POST events never counted as GET in either arm", all.mongo === all.pg && all.mongo === 11, JSON.stringify(all));
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
