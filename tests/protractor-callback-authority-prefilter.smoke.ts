/**
 * Offline Mongo-canonical coverage for the bounded exact-identity authority
 * prefilter. No database or provider connection is opened.
 */
import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import Module from "node:module";
import { ObjectId } from "mongodb";

type Doc = Record<string, any>;
const docs: Doc[] = [];
const aggregateCalls: Array<{ pipeline: Doc[]; options: Doc }> = [];
let failAuthorityRead = false;
const terminal = (doc: Doc) => /^(DELETE|INVOICED|INVOICE|CLOSED|VOID)$/i.test(
  String(doc.operation || ""),
) || /^(DELETE|INVOICED|INVOICE|CLOSED|VOID)$/i.test(String(doc.status || ""));
const key = (doc: Doc) => doc._id.toHexString();

const callbackEvents = {
  aggregate: (pipeline: Doc[], options: Doc) => ({
    toArray: async () => {
      aggregateCalls.push({ pipeline, options });
      if (failAuthorityRead) throw new Error("authority read timed out");
      const match = pipeline[0].$match;
      const floor = match.receivedAt?.$gte as Date | undefined;
      const matches = docs.filter((doc) =>
        doc.processed === false &&
        doc.historyOutcome?.reason !== "unsupported_contact" &&
        (!floor || doc.receivedAt >= floor) &&
        match.$or.some((identity: Doc) =>
          identity.objectId === doc.objectId &&
          identity.objectType === doc.objectType &&
          identity.shopId.$in.some((shopId: unknown) => shopId === doc.shopId),
        ),
      );
      const byIdentity = new Map<string, Doc>();
      for (const doc of matches) {
        const identity = JSON.stringify([doc.shopId, doc.objectType, doc.objectId]);
        const prior = byIdentity.get(identity);
        if (!prior ||
          Number(terminal(doc)) > Number(terminal(prior)) ||
          (terminal(doc) === terminal(prior) &&
            (doc.receivedAt > prior.receivedAt ||
              (doc.receivedAt.getTime() === prior.receivedAt.getTime() && key(doc) > key(prior))))) {
          byIdentity.set(identity, doc);
        }
      }
      return [...byIdentity.values()].map((doc) => ({
        ...doc,
        _callbackTerminal: terminal(doc),
      }));
    },
  }),
};
const dbStub = { getDb: async () => ({ collection: () => callbackEvents }) };
const originalLoad = (Module as any)._load;
(Module as any)._load = function(request: string, parent: any, isMain: boolean) {
  if (request === "@/lib/data/db" || request.endsWith("/lib/data/db")) return dbStub;
  return originalLoad.call(this, request, parent, isMain);
};

const time = (seconds: number) => new Date(Date.UTC(2026, 7, 31, 0, 0, seconds));
function add(
  shopId: number | string,
  objectId: string,
  operation: string,
  receivedAt: Date,
  attempts: number,
  status?: string,
): Doc {
  const doc = {
    _id: new ObjectId(),
    method: "GET",
    shopId,
    objectType: "WorkOrder",
    objectId,
    operation,
    ...(status ? { status } : {}),
    receivedAt,
    attempts,
    processed: false,
  };
  docs.push(doc);
  return doc;
}
function candidate(doc: Doc) {
  return {
    key: key(doc),
    method: "GET" as const,
    shopId: Number(doc.shopId),
    objectType: doc.objectType,
    objectId: doc.objectId,
    operation: doc.operation,
    status: doc.status ?? null,
    receivedAt: doc.receivedAt,
    winnerTieBreaker: key(doc),
  };
}

async function main() {
  const repo = await import("../lib/data/repositories/protractor-callback-events");
  // This intentionally models an exhausted terminal much older than the
  // normal 4,500-row newest candidate window. Exact identity lookup still
  // sees it, unlike the abandoned global recent-authority approach.
  const exhaustedTerminal = add("42", "old-terminal", "Update", time(1), 3, "CLOSED");
  const sibling = add(42, "old-terminal", "Update", time(20), 0);
  const before = JSON.stringify(exhaustedTerminal);
  assert.deepEqual(
    (await repo.filterPendingCallbackCandidatesByAuthority([candidate(sibling)])).map((item) => item.key),
    [],
    "old exhausted terminal suppresses newer retryable sibling",
  );
  assert.equal(JSON.stringify(exhaustedTerminal), before, "authority prefilter never changes exhausted evidence");
  assert.deepEqual(
    (await repo.filterPendingCallbackCandidatesByAuthority([candidate(sibling)])).map((item) => item.key),
    [],
    "a later invocation rereads authority and does not select the sibling",
  );

  const statusOnlyTerminal = add(43, "status-only", "", time(21), 3, "CLOSED");
  const statusOnlySibling = add(43, "status-only", "Update", time(22), 0);
  assert.deepEqual(
    await repo.filterPendingCallbackCandidatesByAuthority([candidate(statusOnlySibling)]),
    [],
    "raw status-only terminal suppresses its retryable sibling",
  );
  void statusOnlyTerminal;

  const exhaustedNew = add(5, "new-nonterminal", "Update", time(40), 3);
  const older = add(5, "new-nonterminal", "Update", time(30), 0);
  assert.deepEqual(
    await repo.filterPendingCallbackCandidatesByAuthority([candidate(older)]),
    [],
    "exhausted newest non-terminal also suppresses its older sibling",
  );
  const exhaustedOld = add(6, "genuine-new", "Update", time(50), 3);
  const genuineNew = add(6, "genuine-new", "Update", time(60), 0);
  assert.deepEqual(
    (await repo.filterPendingCallbackCandidatesByAuthority([candidate(genuineNew)])).map((item) => item.key),
    [key(genuineNew)],
    "genuinely newer retryable update still wins over exhausted old non-terminal",
  );

  const tieRetryable = add(9, "tie", "Update", time(65), 0);
  const tieExhausted = add(9, "tie", "Update", time(65), 3);
  assert.deepEqual(
    await repo.filterPendingCallbackCandidatesByAuthority([candidate(tieRetryable)]),
    [],
    "equal-time ObjectId-desc exhausted winner suppresses the lower retryable sibling",
  );
  void tieExhausted;

  const whitespaceTerminal = add(10, "whitespace", " CLOSED ", time(66), 3);
  const whitespaceNewer = add(10, "whitespace", "Update", time(67), 0);
  assert.deepEqual(
    (await repo.filterPendingCallbackCandidatesByAuthority([candidate(whitespaceNewer)])).map((item) => item.key),
    [key(whitespaceNewer)],
    "raw Mongo terminal regex does not trim whitespace before ranking",
  );
  void whitespaceTerminal;

  const oldTerminal = add(7, "floor", "DELETE", time(70), 3);
  const activated = add(7, "floor", "Update", time(80), 0);
  assert.deepEqual(
    (await repo.filterPendingCallbackCandidatesByAuthority([candidate(activated)], time(80))).map((item) => item.key),
    [key(activated)],
    "activation floor isolates the later generation",
  );
  void oldTerminal;

  // A changed winner is picked up on the next read; final claim remains the
  // race fence after this advisory prefilter.
  const raced = add(8, "race", "Update", time(90), 0);
  assert.deepEqual(
    (await repo.filterPendingCallbackCandidatesByAuthority([candidate(raced)])).map((item) => item.key),
    [key(raced)],
  );
  add(8, "race", "VOID", time(91), 3);
  assert.deepEqual(
    await repo.filterPendingCallbackCandidatesByAuthority([candidate(raced)]),
    [],
    "changed exhausted terminal winner suppresses candidate on reread",
  );

  failAuthorityRead = true;
  await assert.rejects(
    () => repo.filterPendingCallbackCandidatesByAuthority([candidate(genuineNew)]),
    /authority read timed out/,
    "authority-read failure is fail-closed; no partial candidate list escapes",
  );
  failAuthorityRead = false;
  assert.ok(
    aggregateCalls.every((call) =>
      call.options.hint === "dedup_lookup" &&
      call.options.maxTimeMS === 5_000 &&
      call.pipeline.some((stage) => "$group" in stage),
    ),
    "each fixed identity chunk selects its winner in Mongo with the existing lookup index",
  );
  console.log("protractor callback authority prefilter: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});