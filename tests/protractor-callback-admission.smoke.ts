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
const callbackEvents = new Map<string, Doc>();
const quarantine = new Map<string, Doc>();
let capRaceKey: string | null = null;

function eventKeyFromFilter(filter: Doc): string | null {
  if (filter._id instanceof ObjectId) return filter._id.toHexString();
  return typeof filter.eventKey === "string" ? filter.eventKey : null;
}

function matchesEvent(event: Doc, filter: Doc): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "$or") {
      if (!(expected as Doc[]).some((part) => matchesEvent(event, part))) return false;
      continue;
    }
    if (key === "historyOutcome.reason") {
      const actual = event.historyOutcome?.reason;
      if (expected?.$ne !== undefined && actual === expected.$ne) return false;
      continue;
    }
    const actual = event[key];
    if (expected?.$in && !(expected.$in as unknown[]).includes(actual)) return false;
    if (expected?.$exists !== undefined && (expected.$exists ? actual === undefined : actual !== undefined)) return false;
    if (expected?.$lt !== undefined && !(typeof actual === "number" && actual < expected.$lt)) return false;
    if (expected instanceof RegExp && !expected.test(String(actual ?? ""))) return false;
    if (expected !== null && typeof expected !== "object" && actual !== expected) return false;
    if (expected === false && actual !== false) return false;
  }
  return true;
}

const eventCollection = {
  insertOne: async () => ({ insertedId: new ObjectId() }),
  findOne: async (filter: Doc) => {
    const key = eventKeyFromFilter(filter);
    const event = key ? callbackEvents.get(key) : undefined;
    if (event) return matchesEvent(event, filter) ? event : null;
    // Existing admission assertions exercise the coordinator with synthetic
    // keys and do not seed event documents.
    return key ? { _id: new ObjectId(key), processed: false } : null;
  },
  find: (filter: Doc) => {
    let rows = [...callbackEvents.values()].filter((event) => matchesEvent(event, filter));
    return {
      sort(spec: Doc) {
        rows = rows.slice().sort((a, b) => {
          for (const [field, direction] of Object.entries(spec)) {
            const av = a[field] instanceof Date ? a[field].getTime() : String(a[field] ?? "");
            const bv = b[field] instanceof Date ? b[field].getTime() : String(b[field] ?? "");
            if (av < bv) return -1 * Number(direction);
            if (av > bv) return 1 * Number(direction);
          }
          return 0;
        });
        return this;
      },
      limit(limit: number) {
        rows = rows.slice(0, limit);
        return this;
      },
      async next() {
        return rows[0] ?? null;
      },
    };
  },
  updateOne: async (filter: Doc, update: Doc) => {
    eventUpdates.push({ filter, update });
    const key = eventKeyFromFilter(filter);
    const event = key ? callbackEvents.get(key) : undefined;
    if (!event) return { matchedCount: 1 };
    if (!matchesEvent(event, filter)) return { matchedCount: 0 };
    if (update.$set) Object.assign(event, update.$set);
    for (const field of Object.keys(update.$unset ?? {})) delete event[field];
    return { matchedCount: 1 };
  },
  updateMany: async () => {
    return { matchedCount: 0 };
  },
};

const admissionCollection = {
  updateOne: async (filter: Doc, update: Doc) => {
    const id = String(filter._id);
    const current = coordinators.get(id);
    if (!current || current.activeEventKey !== filter.activeEventKey) {
      return { matchedCount: 0 };
    }
    coordinators.set(id, { ...current, ...update.$set });
    if (update.$set?.activeOwnerToken && capRaceKey) {
      const event = callbackEvents.get(capRaceKey);
      if (event) event.attempts = 3;
      capRaceKey = null;
    }
    return { matchedCount: 1 };
  },
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
    eventUpdates.some((entry) => entry.update?.$set?.processed === true),
    false,
    "admission never pre-marks siblings processed",
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
  const crossObject = {
    objectType: "WorkOrder",
    objectId: "cross-method",
    operation: "*" as const,
  };
  assert.equal(
    await repo.admitCallbackEvent(new ObjectId().toHexString(), {
      shopId: 42,
      method: "POST",
      ...crossObject,
      terminal: false,
    }),
    true,
    "cross-method object starts one worker",
  );
  assert.equal(
    await repo.admitCallbackEvent(new ObjectId().toHexString(), {
      shopId: 42,
      method: "GET",
      ...crossObject,
      terminal: true,
    }),
    false,
    "terminal callback cannot execute concurrently across methods",
  );

  coordinators.clear();
  callbackEvents.clear();
  eventUpdates.length = 0;
  const contactIdentity = {
    shopId: 42,
    method: "GET" as const,
    objectType: "Contact",
    objectId: "contact-1",
    operation: "Update",
  };
  const contactKeys = [new ObjectId(), new ObjectId(), new ObjectId()].map((id) =>
    id.toHexString(),
  );
  const contactReceivedAt = new Date("2026-06-01T00:00:00Z");
  callbackEvents.set(contactKeys[0], {
    _id: new ObjectId(contactKeys[0]),
    shopId: 42,
    objectType: "Contact",
    objectId: "contact-1",
    operation: "Update",
    receivedAt: contactReceivedAt,
    processed: false,
  });
  for (const [index, key] of contactKeys.slice(1).entries()) {
    callbackEvents.set(key, {
      _id: new ObjectId(key),
      shopId: 42,
      objectType: "Contact",
      objectId: "contact-1",
      operation: "Update",
      receivedAt: new Date(contactReceivedAt.getTime() + (index + 1) * 1_000),
      processed: false,
      historyOutcome: { category: "deferred", reason: "unsupported_contact" },
    });
  }
  const contactAdmissionCount = coordinators.size;
  assert.equal(
    await repo.admitCallbackEvent(contactKeys[2], contactIdentity),
    false,
    "Mongo admission rejects an already-held unsupported Contact generation",
  );
  assert.equal(
    coordinators.size,
    contactAdmissionCount,
    "Mongo unsupported Contact admission does not create a coordinator slot",
  );
  assert.equal(
    await repo.claimCallbackEvent(contactKeys[2], contactIdentity),
    null,
    "newer unsupported Contact generations never consume an admission slot",
  );
  assert.equal(
    coordinators.size,
    contactAdmissionCount,
    "unsupported Contact winner is ignored rather than blocking older work",
  );
  const olderContactOwner = await repo.claimCallbackEvent(contactKeys[0], contactIdentity);
  assert.equal(
    typeof olderContactOwner,
    "string",
    "older pending Contact remains claimable when newer rows are held",
  );
  assert.equal(
    callbackEvents.get(contactKeys[0])?.processingStartedAt instanceof Date,
    true,
    "older Contact receives the admission claim",
  );
  await repo.recordCallbackOutcome(
    contactKeys[0],
    olderContactOwner!,
    { category: "deferred", reason: "unsupported_contact" },
  );
  await repo.releaseCallbackEventAdmission(contactKeys[0], contactIdentity, olderContactOwner!);
  assert.equal(
    [...callbackEvents.values()].every((event) => event.processed === false),
    true,
    "Contact generations remain retained and unprocessed",
  );

  coordinators.clear();
  callbackEvents.clear();
  const capRaceId = new ObjectId();
  const capRaceHex = capRaceId.toHexString();
  callbackEvents.set(capRaceHex, {
    _id: capRaceId,
    shopId: 42,
    objectType: "WorkOrder",
    objectId: "cap-race",
    operation: "Update",
    receivedAt: new Date("2026-06-01T00:00:10Z"),
    processed: false,
    attempts: 2,
  });
  capRaceKey = capRaceHex;
  const capRaceIdentity = {
    shopId: 42,
    method: "GET" as const,
    objectType: "WorkOrder",
    objectId: "cap-race",
    operation: "*",
  };
  assert.equal(
    await repo.claimCallbackEvent(capRaceHex, capRaceIdentity, undefined, 3),
    null,
    "cap crossing after admission cannot receive an owner token",
  );
  const capRaceEvent = callbackEvents.get(capRaceHex)!;
  assert.equal(capRaceEvent.attempts, 3, "cap race preserves the observed attempt count");
  assert.equal(capRaceEvent.processingStartedAt, undefined, "cap-race cleanup removes admission timestamp");
  assert.equal(capRaceEvent.processingOwnerToken, undefined, "cap-race cleanup removes owner token");
  assert.equal(coordinators.size, 0, "cap-race cleanup releases its coordinator lease");

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
  assert.match(
    pgSource,
    /function replayCandidateWhere[\s\S]*\n\}/,
    "PG admission predicates exclude unsupported Contact generations",
  );
  assert.match(pgSource, /UNSUPPORTED_CONTACT_REASON = "unsupported_contact"/);

  console.log("protractor callback admission smoke: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});