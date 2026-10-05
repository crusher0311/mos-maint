/**
 * Direct, offline regression coverage for the PG recovery carry-over path.
 *
 * Unlike the read-parity fixture, this imports the real PG repository and
 * replaces only its Drizzle and existing fairness-Mongo seams.  No database,
 * migration, credential, or network connection is involved.
 */
import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";

type Column = { kind: "column"; name: string };
type Expression =
  | { kind: "and" | "or"; values: Array<Expression | undefined> }
  | { kind: "eq" | "gte" | "lt" | "in"; column: Column; value: unknown }
  | { kind: "notNull"; column: Column }
  | { kind: "order"; direction: "asc" | "desc"; column: Column }
  | SqlFragment;
type SqlFragment = { kind: "sql"; text: string; params: unknown[] };

const column = (name: string): Column => ({ kind: "column", name });
const schema = {
  id: column("id"), eventKey: column("eventKey"), method: column("method"),
  shopId: column("shopId"), objectType: column("objectType"), objectId: column("objectId"),
  operation: column("operation"), status: column("status"), receivedAt: column("receivedAt"),
  attempts: column("attempts"), processed: column("processed"), priority: column("priority"),
  payload: column("payload"),
};

function rendered(value: unknown): { text: string; params: unknown[] } {
  if (value && typeof value === "object" && (value as SqlFragment).kind === "sql") {
    return value as SqlFragment;
  }
  if (value && typeof value === "object" && (value as Column).kind === "column") {
    return { text: (value as Column).name, params: [] };
  }
  return { text: "?", params: [value] };
}

const sql = ((strings: TemplateStringsArray, ...values: unknown[]): SqlFragment => {
  let text = "";
  const params: unknown[] = [];
  strings.forEach((part, index) => {
    text += part;
    if (index < values.length) {
      const value = rendered(values[index]);
      text += value.text;
      params.push(...value.params);
    }
  });
  return { kind: "sql", text, params };
}) as {
  <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment;
};

const drizzleStub = {
  and: (...values: Array<Expression | undefined>) => ({ kind: "and", values }) as Expression,
  or: (...values: Array<Expression | undefined>) => ({ kind: "or", values }) as Expression,
  eq: (column: Column, value: unknown) => ({ kind: "eq", column, value }) as Expression,
  gte: (column: Column, value: unknown) => ({ kind: "gte", column, value }) as Expression,
  lt: (column: Column, value: unknown) => ({ kind: "lt", column, value }) as Expression,
  inArray: (column: Column, value: unknown) => ({ kind: "in", column, value }) as Expression,
  isNotNull: (column: Column) => ({ kind: "notNull", column }) as Expression,
  asc: (column: Column) => ({ kind: "order", direction: "asc", column }) as Expression,
  desc: (column: Column) => ({ kind: "order", direction: "desc", column }) as Expression,
  count: () => sql`count(*)`,
  max: () => sql`max(*)`,
  sql,
};

type Row = {
  id: number; eventKey: string; method: "GET" | "POST"; priority: 0 | 1;
  receivedAt: Date; processed: boolean; attempts: number | null;
  recoveryOutcomeReason: string | null; shopId: number; objectType: string;
  objectId: string; operation: string | null; status: string | null;
};
const rows: Row[] = [];
const floor = new Date("2026-09-01T00:00:00.000Z");
const at = (id: number) => new Date(floor.getTime() + id * 1000);
function add(id: number, patch: Partial<Row> = {}) {
  rows.push({
    id, eventKey: `event-${id}`, method: "GET", priority: 0, receivedAt: at(id),
    processed: false, attempts: 0, recoveryOutcomeReason: null, shopId: 7,
    objectType: "WorkOrder", objectId: `WO-${id}`, operation: "Update", status: null,
    ...patch,
  });
}

// The first three raw records must advance the stream but cannot enter the
// carry-over.  The remaining records make four bounded raw reads observable.
add(1, { attempts: 3 });
add(2, { recoveryOutcomeReason: "unsupported_contact" });
add(3, { processed: true });
for (let id = 4; id <= 13; id += 1) add(id);
add(14, { receivedAt: new Date(floor.getTime() - 1000) }); // below the floor

function valueEquals(left: unknown, right: unknown) {
  return left instanceof Date && right instanceof Date
    ? left.getTime() === right.getTime()
    : left === right;
}

function matches(row: Row, expression: Expression | undefined): boolean {
  if (!expression) return true;
  if (expression.kind === "and") return expression.values.every((value) => matches(row, value));
  if (expression.kind === "or") return expression.values.some((value) => !!value && matches(row, value));
  if (expression.kind === "eq") return valueEquals(row[expression.column.name as keyof Row], expression.value);
  if (expression.kind === "gte") return (row[expression.column.name as keyof Row] as any) >= (expression.value as any);
  if (expression.kind === "lt") return (row[expression.column.name as keyof Row] as any) < (expression.value as any);
  if (expression.kind === "in") return (expression.value as unknown[]).includes(row[expression.column.name as keyof Row]);
  if (expression.kind === "notNull") return row[expression.column.name as keyof Row] != null;
  if (expression.kind === "order") return true;
  // These are the SQL-only predicates used by findPendingGetEvents.
  const statement = expression as SqlFragment;
  if (statement.text.includes("attempts IS NULL")) return row.attempts == null;
  if (statement.text.includes("historyOutcome") && statement.text.includes("IS NULL")) {
    return row.recoveryOutcomeReason == null;
  }
  if (statement.text.includes("historyOutcome") && statement.text.includes("<>")) {
    return row.recoveryOutcomeReason !== statement.params.at(-1);
  }
  if (statement.text.includes("objectType IS NULL")) return row.objectType == null;
  if (statement.text.includes("objectType <>")) {
    return row.objectType !== statement.params.at(-1);
  }
  if (statement.text.includes("receivedAt >") || statement.text.includes("received_at >")) {
    return row.receivedAt > (statement.params[0] as Date);
  }
  if (statement.text.includes("id >")) return row.id > Number(statement.params.at(-1));
  // terminal-rank SQL and other projections are not predicates.
  return true;
}

const timeoutStatements: SqlFragment[] = [];
const rawReadLimits: number[] = [];
class SelectQuery {
  private predicate: Expression | undefined;
  private ordering: Expression[] = [];
  constructor(private readonly fields: Record<string, unknown>) {}
  from() { return this; }
  where(predicate: Expression) { this.predicate = predicate; return this; }
  orderBy(...ordering: Expression[]) { this.ordering = ordering; return this; }
  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return this.limit(Number.MAX_SAFE_INTEGER).then(onfulfilled, onrejected);
  }
  limit(limit: number) {
    const isRawRecoveryRead = this.ordering.some((entry) =>
      entry.kind === "order" && entry.direction === "asc" && entry.column.name === "receivedAt");
    if (isRawRecoveryRead) rawReadLimits.push(limit);
    const selected = rows.filter((row) => {
      try {
        return matches(row, this.predicate);
      } catch (error) {
        console.error("fake PG predicate failed", error, this.predicate);
        throw error;
      }
    }).sort((left, right) => {
      for (const order of this.ordering) {
        if (order.kind !== "order") continue;
        const a = left[order.column.name as keyof Row] as any;
        const b = right[order.column.name as keyof Row] as any;
        const delta = a instanceof Date && b instanceof Date ? a.getTime() - b.getTime() : a - b;
        if (delta) return order.direction === "asc" ? delta : -delta;
      }
      return 0;
    }).slice(0, limit);
    return Promise.resolve(selected.map((row) => {
      const result: Record<string, unknown> = {};
      for (const [name, source] of Object.entries(this.fields)) {
        if ((source as Column)?.kind === "column") result[name] = row[(source as Column).name as keyof Row];
        else if ((source as SqlFragment)?.text.includes("CASE WHEN")) {
          result[name] = ["DELETE", "INVOICED", "INVOICE", "CLOSED", "VOID"].includes(
            String(row.operation ?? row.status ?? "").toUpperCase(),
          ) ? 1 : 0;
        } else if ((source as SqlFragment)?.text.includes("historyOutcome")) {
          result[name] = row.recoveryOutcomeReason;
        }
      }
      return result;
    }));
  }
}

const transaction = {
  execute: async (statement: SqlFragment) => {
    if (statement.text.includes("SET LOCAL statement_timeout")) timeoutStatements.push(statement);
    return [];
  },
  select: (fields: Record<string, unknown>) => new SelectQuery(fields),
};
const db = {
  select: (fields: Record<string, unknown>) => new SelectQuery(fields),
  transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
};

type FairnessDoc = Record<string, any>;
const fairnessDocs = new Map<string, FairnessDoc>();
const fairnessWrites: FairnessDoc[] = [];
const fairnessCollection = {
  findOne: async (filter: Record<string, unknown>) => fairnessDocs.get(String(filter._id)) ?? null,
  updateOne: async (filter: Record<string, any>, update: Record<string, any>, options?: Record<string, any>) => {
    const id = String(filter._id);
    const current = fairnessDocs.get(id);
    const revision = current?.callbackRecoveryCursorRevision;
    const initialize = (filter.$or as Array<Record<string, any>> | undefined)?.some((part) =>
      part.callbackRecoveryCursorRevision === 0 || part.callbackRecoveryCursorRevision?.$exists === false,
    );
    if ((!current && !options?.upsert) || (current && filter.callbackRecoveryCursorRevision !== undefined &&
        filter.callbackRecoveryCursorRevision !== revision) || (!current && !initialize)) {
      return { matchedCount: 0, upsertedCount: 0 };
    }
    const next = {
      _id: id, ...(current ?? {}), ...(update.$set ?? {}),
      callbackRecoveryCursorRevision: Number(revision ?? 0) +
        Number(update.$inc?.callbackRecoveryCursorRevision ?? 0),
    };
    fairnessDocs.set(id, next);
    fairnessWrites.push(next);
    return { matchedCount: current ? 1 : 0, upsertedCount: current ? 0 : 1 };
  },
};
const mongoStub = {
  getDb: async () => ({ collection: (name: string) => {
    assert.equal(name, "protractor_callback_fairness");
    return fairnessCollection;
  } }),
};

const originalLoad = (Module as any)._load;
(Module as any)._load = function(request: string, parent: any, isMain: boolean) {
  if (request === "drizzle-orm") return drizzleStub;
  if (request === "@/lib/db/drizzle" || request.endsWith("/lib/db/drizzle")) return { getDb: () => db };
  if (request === "@/lib/data/db" || request.endsWith("/lib/data/db")) return mongoStub;
  if (request === "@/lib/db/schema/wave3" || request.endsWith("/lib/db/schema/wave3")) {
    return { protractorCallbackEvents: schema };
  }
  if (request.includes("callback-outcomes")) {
    return {
      DEFAULT_CALLBACK_HISTORY_OUTCOME: { category: "completed", reason: "processed" },
      normalizeCallbackHistoryOutcome: (outcome: unknown) => outcome,
      parseCallbackHistoryOutcome: () => null,
    };
  }
  if (request.includes("callback-claim-telemetry")) return { logCallbackClaimRejection: () => undefined };
  return originalLoad.call(this, request, parent, isMain);
};

const requireHere = createRequire(import.meta.url);
const repoPath = requireHere.resolve("../lib/data/repositories/pg/protractor-callback-events");
function loadRepository() {
  delete requireHere.cache[repoPath];
  return requireHere("../lib/data/repositories/pg/protractor-callback-events") as typeof import("../lib/data/repositories/pg/protractor-callback-events");
}
const cursorId = `protractor_callback_recovery_cursor:pg:${floor.getTime()}`;

async function main() {
  let repo = loadRepository();
  const first = await repo.findPendingGetEvents(0, 3, floor, 3);
  assert.deepEqual(first.map((row) => row.eventKey), Array.from({ length: 10 }, (_, i) => `event-${i + 4}`));
  const initial = fairnessDocs.get(cursorId)!;
  assert.deepEqual(initial.callbackRecoveryBuffer.map((entry: any) => entry.key),
    Array.from({ length: 10 }, (_, i) => `event-${i + 4}`));
  assert.equal(initial.callbackRecoveryCursor.id, 13, "raw rejected entries still advance the cursor");
  assert.ok(fairnessWrites.some((write) => write.callbackRecoveryCursor?.id === 13 &&
    write.callbackRecoveryBuffer?.length === 10), "cursor and multi-entry buffer are persisted together");
  assert.ok(timeoutStatements.length >= 4 && timeoutStatements.every((statement) =>
    statement.text.includes("5000ms")), "every raw PG stream read installs the hard statement timeout");
  assert.ok(rawReadLimits.length >= 4 && rawReadLimits.every((limit) => limit <= 3),
    "raw recovery reads retain the caller's bounded page limit");

  const acknowledged = first[0];
  await repo.acknowledgeRecoveryCandidate(
    acknowledged.eventKey, acknowledged.recoveryBufferGeneration!, floor,
  );
  rows.find((row) => row.id === 5)!.processed = true;
  rows.find((row) => row.id === 6)!.attempts = 3;
  rows.find((row) => row.id === 7)!.recoveryOutcomeReason = "unsupported_contact";
  // A stale persisted entry must also honour the activation floor on restart.
  fairnessDocs.get(cursorId)!.callbackRecoveryBuffer.push({
    key: "event-14", generation: "below-floor-generation",
  });

  // Simulate a process restart: module state disappears, while the existing
  // fairness collection remains the sole recovery carry-over.
  repo = loadRepository();
  const afterRestart = await repo.findPendingGetEvents(0, 3, floor, 1);
  assert.deepEqual(afterRestart.map((row) => row.eventKey),
    ["event-8", "event-9", "event-10", "event-11", "event-12", "event-13"]);
  assert.ok(!afterRestart.some((row) => row.eventKey === "event-14"),
    "floor is revalidated for persisted recovery work");

  // A buffered key overlaps the fresh query. It stays reserved by recovery,
  // rather than being duplicated or reclassified as a fresh candidate.
  const overlap = await repo.findPendingGetEvents(30, 3, floor, 1);
  assert.deepEqual(overlap.filter((row) => row.eventKey === "event-8").map((row) => row.selectionLane),
    ["recovery"]);
  assert.ok(fairnessDocs.get(cursorId)!.callbackRecoveryBuffer.some((entry: any) => entry.key === "event-8"),
    "fresh overlap cannot steal a recovery reservation");

  const staleDoc = fairnessDocs.get(cursorId)!;
  staleDoc.callbackRecoveryBuffer = [{ key: "event-8", generation: "new-generation" }];
  staleDoc.callbackRecoveryCursorRevision += 1;
  await repo.acknowledgeRecoveryCandidate("event-8", "old-generation", floor);
  assert.deepEqual(fairnessDocs.get(cursorId)!.callbackRecoveryBuffer,
    [{ key: "event-8", generation: "new-generation" }],
    "a stale-generation acknowledgement cannot clear a newer reservation");

  // Exact-case Contacts are excluded before a raw recovery page is limited, so
  // a full Contact prefix cannot fill the durable 270-entry carry-over or keep
  // older supported work out of recovery. Existing Contact entries are later
  // removed as scheduler metadata only.
  const originalLength = rows.length;
  const contactPrefix = Array.from({ length: 270 }, (_, index) => 100 + index);
  for (const id of contactPrefix) {
    add(id, {
      objectType: "Contact",
      objectId: `contact-prefix-${id}`,
      receivedAt: at(id),
    });
  }
  const workId = 370;
  add(workId, {
    objectType: "WorkOrder",
    objectId: "work-after-contact-prefix",
    receivedAt: at(workId),
  });
  fairnessDocs.clear();
  repo = loadRepository();
  const afterPrefix = await repo.findPendingGetEvents(0, 3, floor, 270);
  const prefixState = fairnessDocs.get(cursorId)!;
  assert.ok(
    afterPrefix.some((row) => row.eventKey === "event-370"),
    "PG recovery offers supported work after a full Contact prefix",
  );
  assert.ok(
    prefixState.callbackRecoveryBuffer.some((entry: any) => entry.key === "event-370") &&
      !prefixState.callbackRecoveryBuffer.some((entry: any) =>
        /^event-(?:[12]\d\d|3[0-6]\d)$/.test(entry.key)),
    "PG Contact prefix consumes no durable recovery-buffer capacity",
  );
  assert.ok(
    rows.filter((row) => row.objectType === "Contact").every((row) =>
      row.processed === false && row.attempts === 0),
    "PG Contact exclusion preserves notification records",
  );
  fairnessDocs.set(cursorId, {
    ...prefixState,
    callbackRecoveryBuffer: [
      { key: "event-100", generation: "stale-contact-one" },
      { key: "event-101", generation: "stale-contact-two" },
      ...prefixState.callbackRecoveryBuffer,
    ],
  });
  repo = loadRepository();
  const afterBufferedContacts = await repo.findPendingGetEvents(0, 3, floor, 1);
  assert.ok(
    afterBufferedContacts.some((row) => row.eventKey === "event-370"),
    "PG retains supported recovery work when persisted Contacts are encountered",
  );
  assert.ok(
    fairnessDocs.get(cursorId)!.callbackRecoveryBuffer.some((entry: any) => entry.key === "event-370") &&
      !fairnessDocs.get(cursorId)!.callbackRecoveryBuffer.some((entry: any) =>
        entry.key === "event-100" || entry.key === "event-101"),
    "PG prunes persisted Contact entries from scheduler metadata across reads",
  );
  assert.ok(
    rows.filter((row) => row.eventKey === "event-100" || row.eventKey === "event-101")
      .every((row) => row.processed === false && row.attempts === 0),
    "PG metadata pruning never completes or resets Contacts",
  );
  rows.splice(originalLength);
  fairnessDocs.clear();

  console.log("protractor PG callback recovery carry-over: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});