/**
 * Offline PG repository coverage for the bounded callback authority prefilter.
 *
 * This test replaces only the Drizzle database seam.  The fake executor
 * evaluates the same identity and winner rules as the SQL fixture rows, so no
 * provider or database connection is opened.
 */
import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import Module from "node:module";

type Query = { text: string; params: unknown[] };

class QueryFragment {
  constructor(
    readonly text: string,
    readonly params: unknown[],
  ) {}
}

type SqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): QueryFragment;
  join(parts: QueryFragment[], separator: QueryFragment): QueryFragment;
};

const sql = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]): QueryFragment => {
    let text = "";
    const params: unknown[] = [];
    for (let index = 0; index < strings.length; index += 1) {
      text += strings[index];
      if (index >= values.length) continue;
      const value = values[index];
      if (value instanceof QueryFragment) {
        text += value.text;
        params.push(...value.params);
      } else {
        text += "?";
        params.push(value);
      }
    }
    return new QueryFragment(text, params);
  },
  {
    // Keep the separator's bound values (normally none) in the generated
    // query.
    join: (parts: QueryFragment[], separator: QueryFragment): QueryFragment => {
      const text: string[] = [];
      const params: unknown[] = [];
      parts.forEach((part, index) => {
        if (index > 0) {
          text.push(separator.text);
          params.push(...separator.params);
        }
        text.push(part.text);
        params.push(...part.params);
      });
      return new QueryFragment(text.join(""), params);
    },
  },
) as SqlTag;

const drizzleStub = {
  and: () => undefined,
  asc: () => undefined,
  count: () => undefined,
  desc: () => undefined,
  eq: () => undefined,
  gte: () => undefined,
  inArray: () => undefined,
  isNotNull: () => undefined,
  lt: () => undefined,
  max: () => undefined,
  or: () => undefined,
  sql,
};

type Fixture = {
  key: string;
  id: number;
  method: "GET" | "POST" | null;
  shopId: number;
  objectType: string | null;
  objectId: string | null;
  workOrderId: string | null;
  operation: string | null;
  status: string | null;
  receivedAt: Date;
  processed: boolean;
  attempts?: number;
  historyOutcomeReason?: string;
};

const fixtures: Fixture[] = [];
const authorityQueries: Query[] = [];
const timeoutStatements: Query[] = [];
let callbackRowWrites = 0;
let failAuthorityRead = false;

function fixture(
  row: Omit<Fixture, "processed"> & { processed?: boolean },
): Fixture {
  const value = { processed: false, ...row };
  fixtures.push(value);
  return value;
}

function at(seconds: number): Date {
  return new Date(Date.UTC(2026, 7, 31, 0, 0, seconds));
}

function isTerminalRank(row: Fixture): number {
  return new Set(["DELETE", "INVOICED", "INVOICE", "CLOSED", "VOID"]).has(
    String(row.operation ?? row.status ?? "").toUpperCase(),
  ) ? 1 : 0;
}

type RequestedIdentity = {
  method: "GET" | "POST";
  shopId: number;
  objectType: string;
  objectId: string;
};

function matchesIdentity(row: Fixture, requested: RequestedIdentity): boolean {
  // Queue claims use operation "*" and authority spans callback methods.
  if (row.shopId !== requested.shopId) return false;
  if (requested.objectType === "WorkOrder") {
    return row.workOrderId === requested.objectId ||
      (row.objectType === "WorkOrder" && row.objectId === requested.objectId);
  }
  if (requested.method === "POST") return row.workOrderId === requested.objectId;
  return row.objectType === requested.objectType && row.objectId === requested.objectId;
}

function executeAuthority(statement: Query): Array<{ eventKey: string }> {
  authorityQueries.push(statement);
  if (failAuthorityRead) throw new Error("authority read timed out");
  assert.match(statement.text, /VALUES/);
  assert.match(statement.text, /CROSS JOIN LATERAL/);
  assert.match(statement.text, /LIMIT 1/);
  assert.doesNotMatch(statement.text, /e\.method\s*(?:=|IS)/,
    "wildcard authority must not be restricted by delivery method");
  assert.match(
    statement.text,
    /upper\(coalesce\(e\.operation, e\.status, ''\)\)/,
    "the PG claim coalesce terminal expression must stay raw",
  );

  const floor = statement.params.at(-1) instanceof Date
    ? statement.params.at(-1) as Date
    : undefined;
  const paramsWithoutFloor = floor ? statement.params.slice(0, -1) : statement.params;
  const requestedCount = (paramsWithoutFloor.length - 1) / 4;
  assert.equal(
    Number.isInteger(requestedCount) && requestedCount <= 90,
    true,
    "each lateral read is bounded to at most 90 requested identities",
  );
  const requested: RequestedIdentity[] = [];
  for (let index = 0; index < requestedCount; index += 1) {
    const offset = index * 4;
    requested.push({
      method: paramsWithoutFloor[offset] as "GET" | "POST",
      shopId: Number(paramsWithoutFloor[offset + 1]),
      objectType: String(paramsWithoutFloor[offset + 2]),
      objectId: String(paramsWithoutFloor[offset + 3]),
    });
  }
  // The remaining bound value is the unsupported-contact reason predicate.
  assert.equal(paramsWithoutFloor.at(-1), "unsupported_contact");
  return requested.flatMap((identity) => {
    const winner = fixtures
      .filter((row) =>
        row.key !== null &&
        row.processed === false &&
        row.historyOutcomeReason !== "unsupported_contact" &&
        (!floor || row.receivedAt >= floor) &&
        matchesIdentity(row, identity),
      )
      .sort((left, right) =>
        isTerminalRank(right) - isTerminalRank(left) ||
        right.receivedAt.getTime() - left.receivedAt.getTime() ||
        right.id - left.id,
      )[0];
    return winner ? [{ eventKey: winner.key }] : [];
  });
}

const transaction = {
  execute: async (statement: Query): Promise<unknown[]> => {
    if (statement.text.includes("SET LOCAL statement_timeout")) {
      timeoutStatements.push(statement);
      return [];
    }
    if (!statement.text.includes("CROSS JOIN LATERAL")) {
      callbackRowWrites += 1;
      throw new Error("unexpected callback-row operation");
    }
    return executeAuthority(statement);
  },
};

const db = {
  transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
};

const originalLoad = (Module as any)._load;
(Module as any)._load = function(request: string, parent: any, isMain: boolean) {
  if (request === "drizzle-orm") return drizzleStub;
  if (request === "@/lib/db/drizzle" || request.endsWith("/lib/db/drizzle")) {
    return { getDb: () => db };
  }
  if (
    request === "@/lib/db/schema/wave3" ||
    request.endsWith("/lib/db/schema/wave3")
  ) {
    return { protractorCallbackEvents: {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

type Candidate = {
  key: string;
  method: "GET" | "POST";
  shopId: number;
  objectType: string | null;
  objectId: string | null;
  operation: string | null;
  status?: string | null;
  receivedAt?: Date;
  winnerTieBreaker?: number;
};

function candidate(row: Fixture): Candidate {
  return {
    key: row.key,
    method: row.method === "POST" ? "POST" : "GET",
    shopId: row.shopId,
    objectType: row.objectType,
    objectId: row.objectId,
    operation: row.operation,
    status: row.status,
    receivedAt: row.receivedAt,
    winnerTieBreaker: row.id,
  };
}

async function main() {
  const repo = await import("../lib/data/repositories/pg/protractor-callback-events");

  // The same eligible key is returned by the DB top-1 and remains eligible.
  const same = fixture({
    key: "same-key",
    id: 10,
    method: "GET",
    shopId: 1,
    objectType: "WorkOrder",
    objectId: "same",
    workOrderId: null,
    operation: "Update",
    status: null,
    receivedAt: at(10),
  });
  assert.deepEqual(
    (await repo.filterPendingCallbackCandidatesByAuthority([candidate(same)])).map((row) => row.key),
    ["same-key"],
  );
  for (const method of ["GET", "POST"] as const) {
    const waiting = fixture({
      ...same, key: `cross-${method}`, id: method === "GET" ? 1001 : 1003,
      method, objectId: `cross-${method}`, workOrderId: `cross-${method}`,
    });
    const blocker = fixture({
      ...waiting, key: `blocker-${method}`, id: waiting.id + 1,
      method: method === "GET" ? "POST" : "GET",
      operation: "CLOSED", attempts: 3, receivedAt: at(1),
    });
    const unchanged = JSON.stringify(blocker);
    assert.deepEqual(
      await repo.filterPendingCallbackCandidatesByAuthority([candidate(waiting)]),
      [],
      "exhausted terminal authority spans GET and POST",
    );
    assert.equal(JSON.stringify(blocker), unchanged);
  }

  // A terminal row well outside the initial 4,500-row queue window remains
  // authoritative because this is an exact identity lookup, not a global scan.
  const oldTerminal = fixture({
    key: "old-terminal",
    id: 11,
    method: "GET",
    shopId: 2,
    objectType: "WorkOrder",
    objectId: "old-terminal",
    workOrderId: null,
    operation: "DELETE",
    status: "CLOSED",
    receivedAt: new Date(at(1).getTime() - 4_500_000),
    attempts: 3,
  });
  const terminalRetry = fixture({
    key: "terminal-retry",
    id: 12,
    method: "GET",
    shopId: 2,
    objectType: "WorkOrder",
    objectId: "old-terminal",
    workOrderId: null,
    operation: "Update",
    status: null,
    receivedAt: at(20),
    attempts: 0,
  });
  assert.deepEqual(
    await repo.filterPendingCallbackCandidatesByAuthority([candidate(terminalRetry)]),
    [],
    "an exhausted old terminal winner blocks its newer retryable sibling",
  );
  void oldTerminal;

  // A newer update beats an older exhausted non-terminal row.
  const exhaustedUpdate = fixture({
    key: "old-update",
    id: 13,
    method: "GET",
    shopId: 3,
    objectType: "WorkOrder",
    objectId: "new-update",
    workOrderId: null,
    operation: "Update",
    status: null,
    receivedAt: at(30),
    attempts: 3,
  });
  const newerUpdate = fixture({
    key: "new-update",
    id: 14,
    method: "GET",
    shopId: 3,
    objectType: "WorkOrder",
    objectId: "new-update",
    workOrderId: null,
    operation: "Update",
    status: null,
    receivedAt: at(40),
    attempts: 0,
  });
  assert.deepEqual(
    (await repo.filterPendingCallbackCandidatesByAuthority([candidate(newerUpdate)])).map(
      (row) => row.key,
    ),
    ["new-update"],
  );
  void exhaustedUpdate;

  // Whitespace is not trimmed by upper(coalesce(...)); it is non-terminal.
  const whitespace = fixture({
    key: "whitespace",
    id: 15,
    method: "GET",
    shopId: 4,
    objectType: "WorkOrder",
    objectId: "whitespace",
    workOrderId: null,
    operation: " CLOSED ",
    status: null,
    receivedAt: at(50),
    attempts: 3,
  });
  const whitespaceNewer = fixture({
    key: "whitespace-newer",
    id: 16,
    method: "GET",
    shopId: 4,
    objectType: "WorkOrder",
    objectId: "whitespace",
    workOrderId: null,
    operation: "Update",
    status: null,
    receivedAt: at(51),
    attempts: 0,
  });
  assert.deepEqual(
    (await repo.filterPendingCallbackCandidatesByAuthority([candidate(whitespaceNewer)])).map(
      (row) => row.key,
    ),
    ["whitespace-newer"],
  );
  void whitespace;

  // PG coalesce intentionally ignores a terminal status when operation is
  // non-terminal (unlike Mongo's operation OR status predicate).
  const operationWinsCoalesce = fixture({
    key: "operation-wins-coalesce",
    id: 17,
    method: "GET",
    shopId: 5,
    objectType: "WorkOrder",
    objectId: "coalesce",
    workOrderId: null,
    operation: "Update",
    status: "CLOSED",
    receivedAt: at(60),
    attempts: 3,
  });
  const coalesceNewer = fixture({
    key: "coalesce-newer",
    id: 18,
    method: "GET",
    shopId: 5,
    objectType: "WorkOrder",
    objectId: "coalesce",
    workOrderId: null,
    operation: "Update",
    status: null,
    receivedAt: at(61),
    attempts: 0,
  });
  assert.deepEqual(
    (await repo.filterPendingCallbackCandidatesByAuthority([candidate(coalesceNewer)])).map(
      (row) => row.key,
    ),
    ["coalesce-newer"],
  );
  void operationWinsCoalesce;

  // WorkOrder wildcard fallback matches both nullable and non-null legacy
  // object fields through work_order_id.
  const nullableFallback = fixture({
    key: "nullable-fallback",
    id: 19,
    method: null,
    shopId: 6,
    objectType: null,
    objectId: null,
    workOrderId: "legacy-null",
    operation: "DELETE",
    status: null,
    receivedAt: at(70),
    attempts: 3,
  });
  const nullableCandidate = fixture({
    key: "nullable-candidate",
    id: 20,
    method: "POST",
    shopId: 6,
    objectType: "WorkOrder",
    objectId: "legacy-null",
    workOrderId: null,
    operation: "Update",
    status: null,
    receivedAt: at(71),
    attempts: 0,
  });
  const nonNullFallback = fixture({
    key: "nonnull-fallback",
    id: 21,
    method: "GET",
    shopId: 7,
    objectType: "Invoice",
    objectId: "not-the-work-order",
    workOrderId: "legacy-nonnull",
    operation: "DELETE",
    status: null,
    receivedAt: at(72),
    attempts: 3,
  });
  const nonNullCandidate = fixture({
    key: "nonnull-candidate",
    id: 22,
    method: "GET",
    shopId: 7,
    objectType: "WorkOrder",
    objectId: "legacy-nonnull",
    workOrderId: null,
    operation: "Update",
    status: null,
    receivedAt: at(73),
    attempts: 0,
  });
  assert.deepEqual(
    await repo.filterPendingCallbackCandidatesByAuthority([
      candidate(nullableCandidate),
      candidate(nonNullCandidate),
    ]),
    [],
    "legacy work_order_id fallback is not lost when object fields are null or non-null",
  );
  void nullableFallback;
  void nonNullFallback;

  // Equal timestamps still use the DB id tie breaker.
  const tieLow = fixture({
    key: "tie-low",
    id: 30,
    method: "GET",
    shopId: 8,
    objectType: "WorkOrder",
    objectId: "tie",
    workOrderId: null,
    operation: "Update",
    status: null,
    receivedAt: at(80),
    attempts: 0,
  });
  const tieHigh = fixture({
    key: "tie-high",
    id: 31,
    method: "GET",
    shopId: 8,
    objectType: "WorkOrder",
    objectId: "tie",
    workOrderId: null,
    operation: "Update",
    status: null,
    receivedAt: at(80),
    attempts: 3,
  });
  assert.deepEqual(
    await repo.filterPendingCallbackCandidatesByAuthority([candidate(tieLow)]),
    [],
  );
  void tieHigh;

  // Activation floors isolate a later generation from held terminal history.
  const floorOld = fixture({
    key: "floor-old",
    id: 32,
    method: "GET",
    shopId: 9,
    objectType: "WorkOrder",
    objectId: "floor",
    workOrderId: null,
    operation: "DELETE",
    status: null,
    receivedAt: at(90),
    attempts: 3,
  });
  const floorNew = fixture({
    key: "floor-new",
    id: 33,
    method: "GET",
    shopId: 9,
    objectType: "WorkOrder",
    objectId: "floor",
    workOrderId: null,
    operation: "Update",
    status: null,
    receivedAt: at(100),
    attempts: 0,
  });
  assert.deepEqual(
    (await repo.filterPendingCallbackCandidatesByAuthority(
      [candidate(floorNew)],
      at(100),
    )).map((row) => row.key),
    ["floor-new"],
  );
  void floorOld;

  // Legacy candidates without object identity retain the direct queue path.
  const direct = candidate({
    key: "legacy-direct",
    id: 34,
    method: null,
    shopId: 10,
    objectType: null,
    objectId: null,
    workOrderId: "direct",
    operation: null,
    status: null,
    receivedAt: at(101),
    processed: false,
  });
  assert.deepEqual(
    (await repo.filterPendingCallbackCandidatesByAuthority([direct])).map((row) => row.key),
    ["legacy-direct"],
  );

  // A 91-identity read is two bounded, parameterized lateral queries, not a
  // query with an unbounded OR list or one query per candidate.
  authorityQueries.length = 0;
  timeoutStatements.length = 0;
  callbackRowWrites = 0;
  const chunkCandidates: Candidate[] = [];
  for (let index = 0; index < 91; index += 1) {
    const row = fixture({
      key: `chunk-key-${index}`,
      id: 1000 + index,
      method: "GET",
      shopId: 1000 + index,
      objectType: "ServiceItem",
      objectId: `chunk-id-${index}`,
      workOrderId: null,
      operation: "Update",
      status: null,
      receivedAt: at(110 + index),
      attempts: 0,
    });
    chunkCandidates.push(candidate(row));
  }
  assert.equal(
    (await repo.filterPendingCallbackCandidatesByAuthority(chunkCandidates)).length,
    91,
  );
  assert.equal(authorityQueries.length, 2);
  assert.equal(timeoutStatements.length, 2);
  assert.ok(
    timeoutStatements.every((statement) => statement.text.includes("5000ms")),
    "each authority read transaction installs the hard 5s statement timeout",
  );
  assert.equal(callbackRowWrites, 0);
  for (const query of authorityQueries) {
    assert.ok(query.params.length <= 90 * 4 + 1);
    assert.ok(query.text.includes("VALUES"));
    assert.ok(query.text.includes("CROSS JOIN LATERAL"));
    assert.ok(!query.text.includes("chunk-id-"));
    assert.ok(query.params.some((value) => String(value).startsWith("chunk-id-")));
  }

  // Read timeout is fail-closed and never changes callback rows.
  failAuthorityRead = true;
  await assert.rejects(
    () => repo.filterPendingCallbackCandidatesByAuthority([candidate(same)]),
    /authority read timed out/,
  );
  failAuthorityRead = false;
  assert.equal(callbackRowWrites, 0);

  console.log("protractor PG callback authority prefilter: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});