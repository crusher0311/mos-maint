/**
 * Task #1244 — deterministic distributed callback admission/coalescing.
 * Run: npx tsx tests/protractor-callback-admission.smoke.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import { ObjectId } from "mongodb";

type Doc = Record<string, any>;
const coordinators = new Map<string, Doc>();
const eventUpdates: Array<{ filter: Doc; update: Doc }> = [];
const quarantine = new Map<string, Doc>();

const eventCollection = {
  insertOne: async () => ({ insertedId: new ObjectId() }),
  updateOne: async (filter: Doc, update: Doc) => {
    eventUpdates.push({ filter, update });
    return { matchedCount: 1 };
  },
};

const admissionCollection = {
  findOneAndUpdate: async (filter: Doc, update: any, options: Doc) => {
    const id = String(filter._id);
    const prior = coordinators.get(id);

    if (Array.isArray(update) && !("activeEventKey" in filter)) {
      // Admission pipeline: no/fresh active claims; otherwise latest wins.
      const incoming = update[0].$set.activeEventKey.$cond[1];
      const staleBefore = update[0].$set.activeEventKey.$cond[0].$or.find(
        (term: Doc) => term.$lt,
      ).$lt[1] as Date;
      const activeIsFresh =
        prior?.activeEventKey &&
        prior.activeStartedAt instanceof Date &&
        prior.activeStartedAt >= staleBefore;
      coordinators.set(
        id,
        activeIsFresh
          ? { ...prior, pendingEventKey: incoming }
          : {
              _id: id,
              activeEventKey: incoming,
              activeStartedAt: update[0].$set.updatedAt,
            },
      );
    } else if (Array.isArray(update)) {
      // Initial worker release: promote exactly the latest pending callback.
      if (prior?.activeEventKey === filter.activeEventKey) {
        const held = prior as Doc;
        coordinators.set(
          id,
          held.pendingEventKey
            ? {
                _id: id,
                activeEventKey: held.pendingEventKey,
                activeStartedAt: update[0].$set.updatedAt,
              }
            : { _id: id },
        );
      }
    } else if (prior?.activeEventKey === filter.activeEventKey) {
      // Follow-up release: do not promote another callback.
      coordinators.set(id, { _id: id });
    }
    return options.returnDocument === "before" ? prior ?? null : coordinators.get(id);
  },
  deleteOne: async (filter: Doc) => {
    const id = String(filter._id);
    const current = coordinators.get(id);
    if (
      current &&
      !current.activeEventKey &&
      !current.activeStartedAt &&
      !current.pendingEventKey
    ) {
      coordinators.delete(id);
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  },
};
const quarantineCollection = {
  updateOne: async (filter: Doc, update: Doc) => {
    const id = String(filter._id);
    const prior = quarantine.get(id);
    quarantine.set(id, {
      _id: id,
      ...(prior ?? update.$setOnInsert),
      ...update.$set,
      count: (prior?.count ?? 0) + update.$inc.count,
    });
    return { matchedCount: prior ? 1 : 0, upsertedCount: prior ? 0 : 1 };
  },
};

const dbStub = {
  getDb: async () => ({
    collection: (name: string) =>
      name === "protractor_callback_admissions"
        ? admissionCollection
        : name === "protractor_callback_quarantine"
          ? quarantineCollection
          : eventCollection,
  }),
};
const pgStub = {
  __esModule: true,
  admitCallbackEvent: async () => {
    throw new Error("PG must not be touched in Mongo canonical mode");
  },
  finishCallbackEventAdmission: async () => {
    throw new Error("PG must not be touched in Mongo canonical mode");
  },
};

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request.includes("pg/protractor-callback-events")) return pgStub;
  if (request === "@/lib/data/db" || request.endsWith("/lib/data/db")) return dbStub;
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  delete process.env.PROTRACTOR_OPS_PG_CANONICAL;
  const repo = await import("../lib/data/repositories/protractor-callback-events");
  const identity = {
    shopId: 42,
    objectType: "WorkOrder",
    objectId: "wo-1",
    operation: "Update",
  };
  const keys = [new ObjectId(), new ObjectId(), new ObjectId(), new ObjectId()].map(
    (id) => id.toHexString(),
  );

  assert.equal(await repo.admitGetEvent(keys[0], identity), true, "first callback owns worker");
  assert.equal(await repo.admitGetEvent(keys[1], identity), false, "second callback queues");
  assert.equal(await repo.admitGetEvent(keys[2], identity), false, "third callback replaces second");
  assert.equal(
    (eventUpdates[0].filter._id as ObjectId).toHexString(),
    keys[1],
    "replaced pending callback is coalesced",
  );

  const followUp = await repo.finishGetEventAdmission(keys[0], identity, true);
  assert.equal(followUp?.key, keys[2], "initial worker promotes only the latest callback");

  assert.equal(
    await repo.admitGetEvent(keys[3], identity),
    false,
    "arrival during follow-up remains pending",
  );
  assert.equal(await repo.finishGetEventAdmission(keys[2], identity, false), null);
  assert.equal(
    (eventUpdates.at(-1)!.filter._id as ObjectId).toHexString(),
    keys[3],
    "follow-up release coalesces arrivals instead of starting an unbounded worker",
  );
  assert.equal(
    coordinators.size,
    0,
    "idle coordinator is deleted after the bounded follow-up",
  );
  assert.equal(
    await repo.admitGetEvent(new ObjectId().toHexString(), identity),
    true,
    "a callback after release can own a new worker",
  );

  const postIdentity = {
    shopId: 42,
    method: "POST" as const,
    objectType: "WorkOrder",
    objectId: "wo-post",
    operation: "OPEN",
  };
  const postKeys = [new ObjectId(), new ObjectId(), new ObjectId()].map((id) =>
    id.toHexString(),
  );
  const postAdmission = await Promise.all(
    postKeys.map((key) => repo.admitCallbackEvent(key, postIdentity)),
  );
  assert.deepEqual(
    postAdmission,
    [true, false, false],
    "concurrent duplicate POST delivery admits exactly one enrichment",
  );
  const postFollowUp = await repo.finishCallbackEventAdmission(
    postKeys[0],
    postIdentity,
    true,
  );
  assert.equal(postFollowUp?.key, postKeys[2], "POST burst promotes latest delivery only");
  await repo.finishCallbackEventAdmission(postKeys[2], postIdentity, false);
  assert.equal(
    [...coordinators.values()].some((doc) => !doc.activeEventKey && !doc.pendingEventKey),
    false,
    "POST release retains no idle coordinator",
  );

  const quarantineRepo = await import(
    "../lib/data/repositories/protractor-callback-quarantine"
  );
  const rawUnknownId = "credential-like-unknown-id";
  const admissionCountBeforeUnknown = coordinators.size;
  await quarantineRepo.recordUnknownCallback({
    method: "POST",
    sourceRoute: "/api/callbacks/protractor",
    connectionId: rawUnknownId,
    now: new Date("2026-05-22T10:00:00Z"),
  });
  await quarantineRepo.recordUnknownCallback({
    method: "POST",
    sourceRoute: "/api/callbacks/protractor",
    connectionId: rawUnknownId,
    now: new Date("2026-05-22T10:01:00Z"),
  });
  const quarantineDoc = [...quarantine.values()][0];
  assert.equal(quarantineDoc.count, 2, "repeated unknown ids increment one quarantine bucket");
  assert.equal(
    JSON.stringify(quarantineDoc).includes(rawUnknownId),
    false,
    "quarantine never stores the raw connection id",
  );
  assert.equal(
    coordinators.size,
    admissionCountBeforeUnknown,
    "repeated unknown ids create zero enrichment admissions",
  );

  const routeSource = fs.readFileSync("app/api/callbacks/protractor/route.ts", "utf8");
  const postUnknownBranch = routeSource.slice(
    routeSource.indexOf("if (!shop)"),
    routeSource.indexOf("if (!workOrderId)"),
  );
  assert.match(postUnknownBranch, /recordUnknownCallback/, "unknown POST is quarantined");
  assert.doesNotMatch(
    postUnknownBranch,
    /admitCallbackEvent|enrichOpenWorkOrderInBackground/,
    "unknown POST admits zero enrichment",
  );
  const postHandler = routeSource.slice(
    routeSource.indexOf("export async function POST"),
    routeSource.indexOf("export async function GET"),
  );
  assert.doesNotMatch(
    postHandler,
    /hasRecentProcessedPost/,
    "POST duplicate handling has no read-then-act admission race",
  );
  assert.doesNotMatch(
    postHandler,
    /Raw (?:text|body)|Received:",\s*JSON\.stringify\(payload\)/,
    "POST logs never emit raw callback payloads",
  );
  const getStart = routeSource.indexOf("export async function GET");
  const getUnknownStart = routeSource.indexOf("if (!shop)", getStart);
  const getUnknownEnd = routeSource.indexOf("const shopId", getUnknownStart);
  const getUnknownBranch = routeSource.slice(getUnknownStart, getUnknownEnd);
  assert.match(getUnknownBranch, /recordUnknownCallback/, "unknown GET is quarantined");
  assert.doesNotMatch(
    getUnknownBranch,
    /insertGetEvent|admitGetEvent/,
    "unknown GET admits zero processing",
  );

  const pgSource = fs.readFileSync(
    "lib/data/repositories/pg/protractor-callback-events.ts",
    "utf8",
  );
  assert.match(pgSource, /pg_advisory_xact_lock/, "PG serializes admission across instances");
  assert.match(pgSource, /\.transaction\(async \(tx\)/, "PG claim and coalesce share a transaction");
  assert.match(pgSource, /processingStartedAt/, "PG reuses existing runtime columns");

  console.log("protractor callback admission smoke: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});