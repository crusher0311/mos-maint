/**
 * Repository for the `protractor_callback_events` store — the webhook
 * event records threaded across the Protractor callback request path
 * (app/api/callbacks/protractor) and the protractor-sync /
 * protractor-webhook-health / protractor-af-log-tail crons.
 *
 * Task #1006 (finishing task #999): the old flow threaded a Mongo
 * ObjectId across ~40 call sites, which the PG table (serial id) could
 * not honor. The contract is now a store-agnostic string key
 * (`CallbackEventKey`):
 *
 *   - Mongo-canonical (default, PROTRACTOR_OPS_PG_CANONICAL unset/0):
 *     the key is the inserted ObjectId's 24-char hex, and every update
 *     targets `_id` — byte-identical documents and query shapes to the
 *     pre-task behavior.
 *   - PG-canonical (flag =1): the key is an app-generated UUID stored in
 *     the `event_key` column; reads/writes go to Postgres with a
 *     non-fatal Mongo shadow write (WRITE_MONGO_PROTRACTOR_OPS) during
 *     the soak. Shadow docs carry `eventKey` so shadow updates can
 *     target the same logical event without an ObjectId.
 */
import { randomUUID } from "node:crypto";
import { ObjectId, type Collection, type Db, type Document } from "mongodb";
import { getDb, getMongoClient } from "@/lib/data/db";
import {
  isProtractorOpsPgCanonical,
  shouldShadowWriteMongoProtractorOps,
  shadowWriteMongoIntegrationOps,
} from "@/lib/db/integration-ops-write-mode";
import {
  DEFAULT_CALLBACK_HISTORY_OUTCOME,
  normalizeCallbackHistoryOutcome,
  parseCallbackHistoryOutcome,
  type CallbackHistoryOutcome,
} from "@/lib/integrations/protractor/callback-outcomes";
import { callbackWindowWinners } from "@/lib/integrations/protractor/callback-selection";
import {
  logCallbackClaimRejection,
  type CallbackClaimTelemetryContext,
} from "@/lib/integrations/protractor/callback-claim-telemetry";
import * as pg from "./pg/protractor-callback-events";

const COLLECTION = "protractor_callback_events";
const ADMISSION_COLLECTION = "protractor_callback_admissions";
const UNSUPPORTED_CONTACT_REASON = "unsupported_contact";
// This is deliberately case-sensitive: it must match the queue's
// `item.objectType === "Contact"` safety boundary exactly.
const UNSUPPORTED_CONTACT_OBJECT_TYPE = "Contact";
const TERMINAL_OPERATION = /^(DELETE|INVOICED|INVOICE|CLOSED|VOID)$/i;

function mongoTerminalRank(doc: Document): 0 | 1 {
  return TERMINAL_OPERATION.test(String(doc.operation ?? "")) ||
    TERMINAL_OPERATION.test(String(doc.status ?? ""))
    ? 1
    : 0;
}

/** Queue-owned DB accessor for the dedicated callback drain worker. */
export async function getCallbackQueueDb() {
  return getDb();
}
const ADMISSION_LEASE_MS = 10 * 60 * 1000;
const RECOVERY_PRIORITIES = [0, 1] as const;
const RECOVERY_METHODS = ["GET", "POST"] as const;
const RECOVERY_CURSOR_PREFIX = "protractor_callback_recovery_cursor";
const RECOVERY_BUFFER_LIMIT = 270;
type MongoRecoveryCursor = {
  method: "GET" | "POST";
  priority: 0 | 1;
  receivedAt: Date;
  id: ObjectId;
  floorMs: number | null;
};
type MongoRecoveryBufferEntry = { key: string; generation: string };
type MongoRecoveryCursorState = {
  cursor: MongoRecoveryCursor | null;
  buffer: MongoRecoveryBufferEntry[];
  revision: number;
};

function recoveryCursorDocumentId(store: "mongo" | "pg", floorMs: number | null): string {
  return `${RECOVERY_CURSOR_PREFIX}:${store}:${floorMs ?? "none"}`;
}

async function readMongoRecoveryCursor(floorMs: number | null): Promise<MongoRecoveryCursorState> {
  const db = await getDb();
  const doc = await db.collection<Document>("protractor_callback_fairness").findOne({
    _id: recoveryCursorDocumentId("mongo", floorMs),
  } as Document);
  const cursor = doc?.callbackRecoveryCursor as Partial<MongoRecoveryCursor> | undefined;
  const validCursor = cursor?.id instanceof ObjectId &&
    (cursor.method === "GET" || cursor.method === "POST") &&
    (cursor.priority === 0 || cursor.priority === 1) &&
    cursor.receivedAt instanceof Date &&
    cursor.floorMs === floorMs
    ? cursor as MongoRecoveryCursor
    : null;
  return {
    cursor: validCursor,
    buffer: Array.isArray(doc?.callbackRecoveryBuffer)
      ? doc.callbackRecoveryBuffer.filter((entry: unknown): entry is MongoRecoveryBufferEntry =>
          !!entry && typeof (entry as MongoRecoveryBufferEntry).key === "string" &&
          typeof (entry as MongoRecoveryBufferEntry).generation === "string",
        ).slice(0, RECOVERY_BUFFER_LIMIT)
      : [],
    revision: typeof doc?.callbackRecoveryCursorRevision === "number"
      ? doc.callbackRecoveryCursorRevision
      : 0,
  };
}

async function writeMongoRecoveryCursor(
  cursor: MongoRecoveryCursor | null,
  buffer: MongoRecoveryBufferEntry[],
  floorMs: number | null,
  revision: number,
): Promise<boolean> {
  const db = await getDb();
  try {
    const result = await db.collection<Document>("protractor_callback_fairness").updateOne(
      {
        _id: recoveryCursorDocumentId("mongo", floorMs),
        ...(revision === 0
          ? { $or: [
              { callbackRecoveryCursorRevision: { $exists: false } },
              { callbackRecoveryCursorRevision: 0 },
            ] }
          : { callbackRecoveryCursorRevision: revision }),
      } as Document,
      {
        $set: {
          callbackRecoveryCursor: cursor,
          callbackRecoveryBuffer: buffer,
          updatedAt: new Date(),
        },
        $inc: { callbackRecoveryCursorRevision: 1 },
      },
      { upsert: revision === 0 },
    );
    return result.matchedCount === 1 || result.upsertedCount === 1;
  } catch (error: any) {
    // A simultaneous missing-document initializer can raise duplicate _id.
    // Treat it exactly as a CAS loss; fresh work must continue.
    if (error?.code === 11000 || /duplicate key/i.test(String(error?.message))) return false;
    throw error;
  }
}

/** Opaque per-event key: ObjectId hex (Mongo mode) or UUID (PG mode). */
export type CallbackEventKey = string;

export interface GetEventIdentity {
  shopId: number;
  objectType: string;
  objectId: string;
  operation: string | null;
}

export interface AdmittedGetEvent extends GetEventIdentity {
  key: CallbackEventKey;
}

export interface CallbackAdmissionIdentity {
  shopId: number;
  method: "GET" | "POST";
  objectType: string;
  objectId: string;
  operation: string | null;
  /** Coordinator metadata; deliberately excluded from the admission id. */
  terminal?: boolean;
}

export interface AdmittedCallbackEvent extends CallbackAdmissionIdentity {
  key: CallbackEventKey;
}

async function collection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(COLLECTION);
}

/**
 * Mongo filter for a key. ObjectId-hex keys target `_id` (canonical
 * Mongo mode); any other shape (PG-mode UUID) targets the `eventKey`
 * field carried by shadow-written docs — so a mid-request flag flip
 * degrades to a no-op update instead of a crash.
 */
function mongoKeyFilter(key: CallbackEventKey): Document {
  return ObjectId.isValid(key) && String(new ObjectId(key)) === key
    ? { _id: new ObjectId(key) }
    : { eventKey: key };
}

function mongoKeyExclusion(key: CallbackEventKey): Document {
  return ObjectId.isValid(key) && String(new ObjectId(key)) === key
    ? { _id: { $ne: new ObjectId(key) } }
    : { eventKey: { $ne: key } };
}

function mongoReplayCandidateFilter(): Document {
  return { "historyOutcome.reason": { $ne: UNSUPPORTED_CONTACT_REASON } };
}

function admissionId(identity: CallbackAdmissionIdentity): string {
  return JSON.stringify([
    identity.shopId,
    identity.objectType,
    identity.objectId,
  ]);
}

async function coalesceMongoEvent(
  key: unknown,
  outcome: CallbackHistoryOutcome = { category: "coalesced", reason: "superseded" },
): Promise<void> {
  if (typeof key !== "string") return;
  const col = await collection();
  await col.updateOne(
    {
      ...mongoKeyFilter(key),
      processed: false,
      ...mongoReplayCandidateFilter(),
    } as Document,
    {
      $set: {
        processed: true,
        processedAt: new Date(),
        noAction: true,
        historyOutcome: normalizeCallbackHistoryOutcome(outcome),
      },
      $unset: { processingOwnerToken: "", processingStartedAt: "" },
    },
  );
}

/**
 * Atomically admits one GET callback per (shop, object, operation).  Mongo
 * uses a tiny coordinator document in a separate collection, so the legacy
 * event documents and all event scans retain their canonical shape.  PG uses
 * an advisory-lock transaction over the existing event rows (no migration).
 */
export async function admitCallbackEvent(
  key: CallbackEventKey,
  identity: CallbackAdmissionIdentity,
  maxAttempts = 3,
  claimContext?: CallbackClaimTelemetryContext,
): Promise<boolean> {
  if (isProtractorOpsPgCanonical()) {
    return pg.admitCallbackEvent(
      key,
      identity,
      ADMISSION_LEASE_MS,
      undefined,
      maxAttempts,
      claimContext,
    );
  }

  const db = await getDb();
  const col = db.collection<Document>(ADMISSION_COLLECTION);
  const eventCol = await collection();
  const candidate = await eventCol.findOne({
    ...mongoKeyFilter(key),
    processed: false,
    ...mongoReplayCandidateFilter(),
    $or: [{ attempts: { $exists: false } }, { attempts: { $lt: maxAttempts } }],
  } as Document);
  if (!candidate) {
    if (claimContext) {
      logCallbackClaimRejection(claimContext, "candidate_unavailable");
    }
    return false;
  }
  const now = new Date();
  const staleBefore = new Date(now.getTime() - ADMISSION_LEASE_MS);
  const prior = await col.findOneAndUpdate(
    { _id: admissionId(identity) } as Document,
    [
      {
        $set: {
          activeEventKey: {
            $cond: [
              {
                $or: [
                  { $eq: [{ $ifNull: ["$activeEventKey", null] }, null] },
                  { $eq: [{ $ifNull: ["$activeStartedAt", null] }, null] },
                  { $lt: ["$activeStartedAt", staleBefore] },
                ],
              },
              key,
              "$activeEventKey",
            ],
          },
          activeStartedAt: {
            $cond: [
              {
                $or: [
                  { $eq: [{ $ifNull: ["$activeEventKey", null] }, null] },
                  { $eq: [{ $ifNull: ["$activeStartedAt", null] }, null] },
                  { $lt: ["$activeStartedAt", staleBefore] },
                ],
              },
              now,
              "$activeStartedAt",
            ],
          },
          pendingEventKey: {
            $cond: [
              {
                $or: [
                  { $eq: [{ $ifNull: ["$activeEventKey", null] }, null] },
                  { $eq: [{ $ifNull: ["$activeStartedAt", null] }, null] },
                  { $lt: ["$activeStartedAt", staleBefore] },
                ],
              },
              "$$REMOVE",
              {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$pendingIsTerminal", true] },
                      { $eq: [identity.terminal === true, false] },
                    ],
                  },
                  "$pendingEventKey",
                  key,
                ],
              },
            ],
          },
          pendingIsTerminal: {
            $cond: [
              {
                $or: [
                  { $eq: [{ $ifNull: ["$activeEventKey", null] }, null] },
                  { $eq: [{ $ifNull: ["$activeStartedAt", null] }, null] },
                  { $lt: ["$activeStartedAt", staleBefore] },
                ],
              },
              "$$REMOVE",
              {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$pendingIsTerminal", true] },
                      { $eq: [identity.terminal === true, false] },
                    ],
                  },
                  true,
                  identity.terminal === true,
                ],
              },
            ],
          },
          updatedAt: now,
        },
      },
    ],
    { upsert: true, returnDocument: "before" },
  );

  const previous = prior as Document | null;
  const hadFreshWorker =
    typeof previous?.activeEventKey === "string" &&
    previous.activeStartedAt instanceof Date &&
    previous.activeStartedAt >= staleBefore;
  if (hadFreshWorker) {
    if (claimContext) {
      logCallbackClaimRejection(claimContext, "fresh_ownership");
    }
    return false;
  }
  const owned = await eventCol.updateOne(
    {
      ...mongoKeyFilter(key),
      processed: false,
      ...mongoReplayCandidateFilter(),
      $or: [{ attempts: { $exists: false } }, { attempts: { $lt: maxAttempts } }],
    } as Document,
    { $set: { processingStartedAt: now } },
  );
  if (owned.matchedCount !== 1) {
    if (claimContext) {
      logCallbackClaimRejection(claimContext, "event_fence");
    }
    await col.deleteOne({ _id: admissionId(identity), activeEventKey: key } as Document);
    return false;
  }
  return true;
}

export async function admitGetEvent(
  key: CallbackEventKey,
  identity: GetEventIdentity,
): Promise<boolean> {
  return admitCallbackEvent(key, { ...identity, method: "GET" });
}

export async function claimCallbackEvent(
  key: CallbackEventKey,
  identity: CallbackAdmissionIdentity,
  receivedNotBefore?: Date,
  maxAttempts = 3,
): Promise<string | null> {
  const claimContext: CallbackClaimTelemetryContext = {
    store: "mongo",
    eventKey: key,
    shopId: identity.shopId,
    objectType: identity.objectType,
    objectId: identity.objectId,
  };
  if (isProtractorOpsPgCanonical()) {
    return pg.claimCallbackEvent(
      key,
      identity,
      ADMISSION_LEASE_MS,
      receivedNotBefore,
      maxAttempts,
      { ...claimContext, store: "pg" },
    );
  }
  const events = await collection();
  const validReceivedNotBefore =
    receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
      ? receivedNotBefore
      : undefined;
  const objectFilter = {
    shopId: { $in: [identity.shopId, String(identity.shopId)] },
    objectType: identity.objectType,
    objectId: identity.objectId,
    processed: false,
    ...mongoReplayCandidateFilter(),
    ...(validReceivedNotBefore ? { receivedAt: { $gte: validReceivedNotBefore } } : {}),
  };
  const terminal = TERMINAL_OPERATION;
  const terminalWinner = await events.find({
    ...objectFilter,
    $or: [{ operation: { $regex: terminal } }, { status: { $regex: terminal } }],
  } as Document).sort({ receivedAt: -1, _id: -1 }).limit(1).next();
  const winner = terminalWinner ?? await events.find(objectFilter as Document)
    .sort({ receivedAt: -1, _id: -1 }).limit(1).next();
  if (!winner) {
    logCallbackClaimRejection(claimContext, "winner_absent");
    return null;
  }
  if (!mongoKeyFilter(key)._id ||
      String(winner._id) !== String(mongoKeyFilter(key)._id)) {
    logCallbackClaimRejection(claimContext, "winner_mismatch");
    return null;
  }
  if (!(await admitCallbackEvent(key, identity, maxAttempts, claimContext))) return null;
  const claimedWinner = await events.find({
    ...objectFilter,
    ...(terminalWinner ? {
      $or: [{ operation: { $regex: terminal } }, { status: { $regex: terminal } }],
    } : {}),
  } as Document).sort({ receivedAt: -1, _id: -1 }).limit(1).next();
  if (!claimedWinner || String(claimedWinner._id) !== String(mongoKeyFilter(key)._id)) {
    logCallbackClaimRejection(claimContext, "winner_changed");
    await events.updateOne(
      {
        ...mongoKeyFilter(key),
        processed: false,
      } as Document,
      { $unset: { processingStartedAt: "", processingOwnerToken: "" } },
    );
    await releaseCallbackEventAdmission(key, identity);
    return null;
  }
  const token = randomUUID();
  const db = await getDb();
  const coordinator = await db.collection<Document>(ADMISSION_COLLECTION).updateOne(
    { _id: admissionId(identity), activeEventKey: key } as Document,
    { $set: { activeOwnerToken: token } },
  );
  const event = await (await collection()).updateOne(
    {
      ...mongoKeyFilter(key),
      processed: false,
      ...mongoReplayCandidateFilter(),
      $or: [{ attempts: { $exists: false } }, { attempts: { $lt: maxAttempts } }],
    } as Document,
    { $set: { processingOwnerToken: token } },
  );
  if (coordinator.matchedCount !== 1) {
    logCallbackClaimRejection(claimContext, "coordinator_fence");
    await releaseCallbackEventAdmission(key, identity);
    return null;
  }
  if (event.matchedCount !== 1) {
    logCallbackClaimRejection(claimContext, "event_fence");
    await events.updateOne(
      {
        ...mongoKeyFilter(key),
        processed: false,
      } as Document,
      { $unset: { processingStartedAt: "", processingOwnerToken: "" } },
    );
    await releaseCallbackEventAdmission(key, identity);
    return null;
  }
  return token;
}

/**
 * Releases an admitted event.  The initial worker may atomically promote the
 * single latest pending event; the promoted worker releases with
 * claimFollowUp=false, coalescing arrivals during that fetch.  Consequently a
 * burst performs at most the initial fetch plus one latest-state follow-up.
 */
export async function finishCallbackEventAdmission(
  key: CallbackEventKey,
  identity: CallbackAdmissionIdentity,
  claimFollowUp: boolean,
): Promise<AdmittedCallbackEvent | null> {
  if (isProtractorOpsPgCanonical()) {
    return pg.finishCallbackEventAdmission(key, identity, claimFollowUp);
  }

  const db = await getDb();
  const col = db.collection<Document>(ADMISSION_COLLECTION);
  const now = new Date();
  const prior = await col.findOneAndUpdate(
    { _id: admissionId(identity), activeEventKey: key } as Document,
    claimFollowUp
      ? [
          {
            $set: {
              activeEventKey: { $ifNull: ["$pendingEventKey", "$$REMOVE"] },
              activeStartedAt: {
                $cond: [
                  { $ne: [{ $ifNull: ["$pendingEventKey", null] }, null] },
                  now,
                  "$$REMOVE",
                ],
              },
              pendingEventKey: "$$REMOVE",
              pendingIsTerminal: "$$REMOVE",
              updatedAt: now,
            },
          },
        ]
      : {
          $unset: {
            activeEventKey: "",
            activeStartedAt: "",
            pendingEventKey: "",
            pendingIsTerminal: "",
          },
          $set: { updatedAt: now },
        },
    { returnDocument: "before" },
  );

  const pendingKey = (prior as Document | null)?.pendingEventKey;
  if (!claimFollowUp) {
    await coalesceMongoEvent(pendingKey);
    await col.deleteOne({
      _id: admissionId(identity),
      activeEventKey: { $exists: false },
      activeStartedAt: { $exists: false },
      pendingEventKey: { $exists: false },
      pendingIsTerminal: { $exists: false },
    } as Document);
    return null;
  }
  if (typeof pendingKey === "string") {
    return { ...identity, key: pendingKey };
  }
  await col.deleteOne({
    _id: admissionId(identity),
    activeEventKey: { $exists: false },
    activeStartedAt: { $exists: false },
    pendingEventKey: { $exists: false },
    pendingIsTerminal: { $exists: false },
  } as Document);
  return null;
}

export async function finishGetEventAdmission(
  key: CallbackEventKey,
  identity: GetEventIdentity,
  claimFollowUp: boolean,
): Promise<AdmittedGetEvent | null> {
  const result = await finishCallbackEventAdmission(
    key,
    { ...identity, method: "GET" },
    claimFollowUp,
  );
  if (!result) return null;
  const { method: _method, ...event } = result;
  return event;
}

/**
 * Queue workers release without coalescing arrivals that landed while the
 * provider read was in flight. They remain pending for the next fair drain.
 */
export async function releaseCallbackEventAdmission(
  key: CallbackEventKey,
  identity: CallbackAdmissionIdentity,
  ownerToken?: string,
): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.releaseCallbackEventAdmission(key, identity, ownerToken);
    return;
  }
  const db = await getDb();
  const col = db.collection<Document>(ADMISSION_COLLECTION);
  await col.findOneAndUpdate(
    {
      _id: admissionId(identity),
      activeEventKey: key,
      ...(ownerToken ? { activeOwnerToken: ownerToken } : {}),
    } as Document,
    {
      $unset: {
        activeEventKey: "",
        activeStartedAt: "",
        pendingEventKey: "",
        pendingIsTerminal: "",
      },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: "before" },
  );
  await col.deleteOne({
    _id: admissionId(identity),
    activeEventKey: { $exists: false },
    activeStartedAt: { $exists: false },
    pendingEventKey: { $exists: false },
    pendingIsTerminal: { $exists: false },
  } as Document);
}

/**
 * Called only after the winner completed successfully. This is intentionally
 * separate from admission: siblings remain replayable until an atomically
 * owned winner has finished, so a racing drain cannot discard its work.
 */
export async function completeCallbackGeneration(
  key: CallbackEventKey,
  identity: CallbackAdmissionIdentity,
  ownerToken: string,
  ownerReceivedAt: Date,
  outcome: CallbackHistoryOutcome = DEFAULT_CALLBACK_HISTORY_OUTCOME,
  /**
   * An activation's persisted callback floor.  A winner from a new
   * generation must never mark older, deliberately-held callbacks completed
   * merely because they share the same object identity.
   */
  coalesceNotBefore?: Date,
): Promise<boolean> {
  if (isProtractorOpsPgCanonical()) {
    return pg.completeCallbackGeneration(
      key, identity, ownerToken, ownerReceivedAt, outcome, coalesceNotBefore,
    );
  }
  const ownerOutcome = normalizeCallbackHistoryOutcome(outcome);
  const coalescedOutcome: CallbackHistoryOutcome = {
    category: "coalesced",
    reason: "superseded",
  };
  const terminalOps = /^(DELETE|INVOICED|INVOICE|CLOSED|VOID)$/i;
  const validCoalesceNotBefore =
    coalesceNotBefore instanceof Date && Number.isFinite(coalesceNotBefore.getTime())
      ? coalesceNotBefore
      : undefined;
  const sibling = {
    shopId: { $in: [identity.shopId, String(identity.shopId)] },
    objectType: identity.objectType,
    objectId: identity.objectId,
    receivedAt: {
      $lte: ownerReceivedAt,
      ...(validCoalesceNotBefore ? { $gte: validCoalesceNotBefore } : {}),
    },
    ...(identity.terminal ? {} : {
      $nor: [
        { operation: { $regex: terminalOps } },
        { status: { $regex: terminalOps } },
      ],
    }),
  };
  const client = await getMongoClient();
  const session = client.startSession();
  let completed = false;
  try {
    await session.withTransaction(async () => {
      const db = await getDb();
      const coordinator = await db.collection<Document>(ADMISSION_COLLECTION).findOne(
        { _id: admissionId(identity), activeEventKey: key, activeOwnerToken: ownerToken } as Document,
        { session },
      );
      const owner = await db.collection<Document>(COLLECTION).findOne(
        {
          ...mongoKeyFilter(key),
          processed: false,
          processingOwnerToken: ownerToken,
          ...mongoReplayCandidateFilter(),
        } as Document,
        { session },
      );
      if (!coordinator || !owner) return;
      const completedOwner = await db.collection<Document>(COLLECTION).updateOne(
        {
          ...mongoKeyFilter(key),
          processed: false,
          processingOwnerToken: ownerToken,
          ...mongoReplayCandidateFilter(),
        } as Document,
        {
          $set: {
            processed: true,
            processedAt: new Date(),
            noAction: true,
            historyOutcome: ownerOutcome,
          },
          $unset: { processingOwnerToken: "", processingStartedAt: "" },
        },
        { session },
      );
      if (completedOwner.matchedCount !== 1) return;
      await db.collection<Document>(COLLECTION).updateMany(
        {
          ...mongoKeyExclusion(key),
          processed: false,
          ...mongoReplayCandidateFilter(),
          $or: [sibling],
        } as Document,
        {
          $set: {
            processed: true,
            processedAt: new Date(),
            noAction: true,
            historyOutcome: coalescedOutcome,
          },
          $unset: { processingOwnerToken: "", processingStartedAt: "" },
        },
        { session },
      );
      await db.collection<Document>(ADMISSION_COLLECTION).deleteOne(
        { _id: admissionId(identity), activeEventKey: key, activeOwnerToken: ownerToken } as Document,
        { session },
      );
      completed = true;
    });
  } finally {
    await session.endSession();
  }
  return completed;
}

/* ------------------------------------------------------------------ */
/* Inserts                                                             */
/* ------------------------------------------------------------------ */

export async function insertPostEvent(fields: {
  payload: unknown;
  workOrderId: string;
  status: string | null;
  connectionId: string;
  shopId: number | string | null | undefined;
  /** Retained for call-site compatibility; POST callbacks are always replayable. */
  deferredForReplay?: boolean;
}): Promise<CallbackEventKey> {
  const receivedAt = new Date();
  if (isProtractorOpsPgCanonical()) {
    const eventKey = randomUUID();
    const shopIdNum = fields.shopId == null ? null : Number(fields.shopId);
    await pg.insertPostEvent({
      eventKey,
      receivedAt,
      payload: fields.payload,
      workOrderId: fields.workOrderId,
      status: fields.status,
      connectionId: fields.connectionId,
      shopId: Number.isFinite(shopIdNum as number) ? (shopIdNum as number) : null,
      deferredForReplay: fields.deferredForReplay,
    });
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.insertPost",
      async () => {
        const col = await collection();
        await col.insertOne({
          eventKey,
          receivedAt,
          ...(fields.deferredForReplay ? {
            method: "POST",
            objectType: "WorkOrder",
            objectId: fields.workOrderId,
            operation: fields.status,
            attempts: 0,
            priority: 1,
            deferredByInstancePolicy: true,
          } : {}),
          payload: fields.payload,
          historyOutcome: { category: "deferred", reason: "pending_replay" },
          workOrderId: fields.workOrderId,
          status: fields.status,
          connectionId: fields.connectionId,
          shopId: fields.shopId,
          processed: false,
        });
      },
    );
    return eventKey;
  }
  const col = await collection();
  const res = await col.insertOne({
    receivedAt,
    ...(fields.deferredForReplay ? {
      method: "POST",
      objectType: "WorkOrder",
      objectId: fields.workOrderId,
      operation: fields.status,
      attempts: 0,
      priority: 1,
      deferredByInstancePolicy: true,
    } : {}),
    payload: fields.payload,
    historyOutcome: { category: "deferred", reason: "pending_replay" },
    workOrderId: fields.workOrderId,
    status: fields.status,
    connectionId: fields.connectionId,
    shopId: fields.shopId,
    processed: false,
  });
  return res.insertedId.toHexString();
}

export async function insertGetEvent(fields: {
  connectionId: string;
  objectType: string;
  objectId: string;
  operation: string | null;
  shopId: number;
}): Promise<CallbackEventKey> {
  const receivedAt = new Date();
  if (isProtractorOpsPgCanonical()) {
    const eventKey = randomUUID();
    await pg.insertGetEvent({
      eventKey,
      receivedAt,
      connectionId: fields.connectionId,
      objectType: fields.objectType,
      objectId: fields.objectId,
      operation: fields.operation,
      shopId: fields.shopId,
    });
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.insertGet",
      async () => {
        const col = await collection();
        await col.insertOne({
          eventKey,
          receivedAt,
          method: "GET",
          connectionId: fields.connectionId,
          objectType: fields.objectType,
          objectId: fields.objectId,
          operation: fields.operation,
          shopId: fields.shopId,
          historyOutcome: { category: "deferred", reason: "pending_replay" },
          processed: false,
          attempts: 0,
          priority: 1,
        });
      },
    );
    return eventKey;
  }
  const col = await collection();
  const res = await col.insertOne({
    receivedAt,
    method: "GET",
    connectionId: fields.connectionId,
    objectType: fields.objectType,
    objectId: fields.objectId,
    operation: fields.operation,
    shopId: fields.shopId,
    historyOutcome: { category: "deferred", reason: "pending_replay" },
    processed: false,
    attempts: 0,
    priority: 1,
  });
  return res.insertedId.toHexString();
}

/* ------------------------------------------------------------------ */
/* Dedup / rate-limit reads                                            */
/* ------------------------------------------------------------------ */

export async function countRecentByConnection(
  connectionId: string,
  windowStart: Date,
): Promise<number> {
  if (isProtractorOpsPgCanonical()) {
    return pg.countRecentByConnection(connectionId, windowStart);
  }
  const col = await collection();
  return col.countDocuments({ connectionId, receivedAt: { $gte: windowStart } });
}

export async function hasRecentProcessedPost(
  workOrderId: string,
  status: string | null,
  since: Date,
): Promise<boolean> {
  if (isProtractorOpsPgCanonical()) {
    return pg.hasRecentProcessedPost(workOrderId, status, since);
  }
  const col = await collection();
  const doc = await col.findOne({
    workOrderId,
    status,
    processed: true,
    processedAt: { $gte: since },
  });
  return !!doc;
}

export async function findRecentProcessedGet(
  shopId: number,
  objectType: string,
  objectId: string,
  operation: string | null,
  since: Date,
): Promise<{ processedAt: Date } | null> {
  if (isProtractorOpsPgCanonical()) {
    return pg.findRecentProcessedGet(shopId, objectType, objectId, operation, since);
  }
  const col = await collection();
  const doc = await col.findOne({
    shopId,
    objectType,
    objectId,
    operation,
    processed: true,
    processedAt: { $gte: since },
  });
  return doc?.processedAt ? { processedAt: doc.processedAt as Date } : null;
}

/* ------------------------------------------------------------------ */
/* Status updates                                                      */
/* ------------------------------------------------------------------ */

export interface ProcessedFields {
  vin?: string;
  workOrderNumber?: string | number | null;
  noAction?: boolean;
  deletedFromDashboard?: boolean;
  historyOutcome?: CallbackHistoryOutcome;
}

export async function markProcessed(
  key: CallbackEventKey,
  fields: ProcessedFields = {},
): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.markProcessedByKey(key, fields);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.markProcessed",
      () => markProcessedMongo(key, fields),
    );
    return;
  }
  await markProcessedMongo(key, fields);
}

async function markProcessedMongo(
  key: CallbackEventKey,
  fields: ProcessedFields,
): Promise<void> {
  const col = await collection();
  await col.updateOne(mongoKeyFilter(key), {
    $set: {
      processed: true,
      processedAt: new Date(),
      ...(fields.vin !== undefined ? { vin: fields.vin } : {}),
      ...(fields.workOrderNumber !== undefined
        ? { workOrderNumber: fields.workOrderNumber }
        : {}),
      ...(fields.noAction !== undefined ? { noAction: fields.noAction } : {}),
      ...(fields.deletedFromDashboard !== undefined
        ? { deletedFromDashboard: fields.deletedFromDashboard }
        : {}),
      ...(fields.historyOutcome !== undefined
        ? { historyOutcome: normalizeCallbackHistoryOutcome(fields.historyOutcome) }
        : {}),
    },
  });
}

/** POST closed-WO path: stamp one unprocessed event for (workOrderId, status). */
export async function markOneProcessedByWorkOrderStatus(
  workOrderId: string,
  status: string | null,
): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.markOneProcessedByWorkOrderStatus(workOrderId, status);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.markOneByWoStatus",
      async () => {
        const col = await collection();
        await col.updateOne(
          { workOrderId, status, processed: false },
          { $set: { processed: true, processedAt: new Date() } },
        );
      },
    );
    return;
  }
  const col = await collection();
  await col.updateOne(
    { workOrderId, status, processed: false },
    { $set: { processed: true, processedAt: new Date() } },
  );
}

/** Queue-drain path: stamp one unprocessed event for (objectId, objectType). */
export async function markOneProcessedByObject(
  objectId: string,
  objectType: string,
  fields: { vin?: string; workOrderNumber?: string | number | null } = {},
): Promise<void> {
  const set = {
    processed: true,
    processedAt: new Date(),
    ...(fields.vin !== undefined ? { vin: fields.vin } : {}),
    ...(fields.workOrderNumber !== undefined
      ? { workOrderNumber: fields.workOrderNumber }
      : {}),
  };
  if (isProtractorOpsPgCanonical()) {
    await pg.markOneProcessedByObject(objectId, objectType, fields);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.markOneByObject",
      async () => {
        const col = await collection();
        await col.updateOne({ objectId, objectType, processed: false }, { $set: set });
      },
    );
    return;
  }
  const col = await collection();
  await col.updateOne({ objectId, objectType, processed: false }, { $set: set });
}

/** `$set lastAttemptAt [,lastError]` + `$inc attempts`. */
export async function recordAttempt(
  key: CallbackEventKey,
  lastError?: string,
): Promise<void> {
  const doMongo = async () => {
    const col = await collection();
    await col.updateOne(mongoKeyFilter(key), {
      $set: {
        lastAttemptAt: new Date(),
        ...(lastError !== undefined ? { lastError: lastError.slice(0, 500) } : {}),
      },
      $inc: { attempts: 1 },
    });
  };
  if (isProtractorOpsPgCanonical()) {
    await pg.recordAttempt(key, lastError);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.recordAttempt",
      doMongo,
    );
    return;
  }
  await doMongo();
}

/** Make a denied POST callback visible to the ordinary allowed-replica drain. */
/** `$set processingStartedAt` + `$inc attempts` (queue-drain start stamp). */
export async function recordProcessingStarted(key: CallbackEventKey): Promise<void> {
  const doMongo = async () => {
    const col = await collection();
    await col.updateOne(mongoKeyFilter(key), {
      $set: { lastAttemptAt: new Date() },
      $inc: { attempts: 1 },
    });
  };
  if (isProtractorOpsPgCanonical()) {
    await pg.recordProcessingStarted(key);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.recordProcessingStarted",
      doMongo,
    );
    return;
  }
  await doMongo();
}

/** `$set lastError, lastErrorAt` (queue-drain failure stamp; no attempt inc). */
export async function recordError(
  key: CallbackEventKey,
  message: string,
  ownerToken?: string,
): Promise<void> {
  const doMongo = async () => {
    const col = await collection();
    await col.updateOne({
      ...mongoKeyFilter(key),
      ...(ownerToken
        ? {
            processed: false,
            processingOwnerToken: ownerToken,
          }
        : {}),
    } as Document, {
      $set: { lastError: message, lastErrorAt: new Date() },
    });
  };
  if (isProtractorOpsPgCanonical()) {
    await pg.recordError(key, message, ownerToken);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.recordError",
      doMongo,
    );
    return;
  }
  await doMongo();
}

/**
 * Fenced queue-failure evidence.  A failed owner may leave the event
 * replayable, but it must not be able to overwrite a newer owner or an
 * already-completed generation.
 */
export async function recordCallbackOutcome(
  key: CallbackEventKey,
  ownerToken: string,
  outcome: CallbackHistoryOutcome,
): Promise<void> {
  const safeOutcome = normalizeCallbackHistoryOutcome(outcome, {
    category: "failed",
    reason: "dispatch_failed",
  });
  const doMongo = async () => {
    const col = await collection();
    await col.updateOne(
      {
        ...mongoKeyFilter(key),
        processed: false,
        processingOwnerToken: ownerToken,
      } as Document,
      { $set: { historyOutcome: safeOutcome } },
    );
  };
  if (isProtractorOpsPgCanonical()) {
    await pg.recordCallbackOutcome(key, ownerToken, safeOutcome);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.recordOutcome",
      doMongo,
    );
    return;
  }
  await doMongo();
}

/**
 * Leave a safety-boundary callback replayable without charging the queue
 * attempt that was only spent reaching the boundary.  This is deliberately
 * separate from `recordCallbackOutcome`: callers use it only after
 * `recordProcessingStarted`, and the admission claim remains owned until the
 * normal release path runs.  In particular, this does not refund admission.
 */
export async function recordCallbackDeferral(
  key: CallbackEventKey,
  ownerToken: string,
  outcome: CallbackHistoryOutcome,
): Promise<void> {
  const safeOutcome = normalizeCallbackHistoryOutcome(outcome);
  const doMongo = async () => {
    const col = await collection();
    await col.updateOne(
      {
        ...mongoKeyFilter(key),
        processed: false,
        processingOwnerToken: ownerToken,
        callbackDeferralOwnerToken: { $ne: ownerToken },
      } as Document,
      [
        {
          $set: {
            historyOutcome: safeOutcome,
            callbackDeferralOwnerToken: ownerToken,
            attempts: {
              $max: [
                {
                  $subtract: [
                    { $ifNull: ["$attempts", 0] },
                    1,
                  ],
                },
                0,
              ],
            },
          },
        },
      ],
    );
  };
  if (isProtractorOpsPgCanonical()) {
    await pg.recordCallbackDeferral(key, ownerToken, safeOutcome);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.callback_events.recordDeferral",
      doMongo,
    );
    return;
  }
  await doMongo();
}

/* ------------------------------------------------------------------ */
/* Queue / cron reads                                                  */
/* ------------------------------------------------------------------ */

export interface PendingGetEvent {
  key: CallbackEventKey;
  method: "GET" | "POST";
  shopId: number;
  objectType: string | null;
  objectId: string | null;
  operation: string | null;
  status?: string | null;
  receivedAt?: Date;
  /** Internal bounded-window authority marker; never true for exhausted rows. */
  replayEligible?: boolean;
  /** Store-local deterministic final winner ordering. */
  winnerTieBreaker?: string | number;
  /** PG claim's terminal expression is coalesce(operation, status). */
  terminalFromCoalesce?: boolean;
  /** Raw Mongo terminal classification retained through POST normalization. */
  terminalRank?: 0 | 1;
  /** Opaque generation fencing a durable recovery-buffer acknowledgement. */
  recoveryBufferGeneration?: string;
  /** Durable carry-over order; only used to order recovery peers of one shop. */
  recoveryBufferOrder?: number;
  /**
   * A bounded oldest-first read kept separately from the normal newest window.
   * This is advisory scheduling metadata only; durable claim remains authority.
   */
  selectionLane?: "fresh" | "recovery";
}

async function rotatePendingByFleetCursor(
  items: PendingGetEvent[],
  _servedShopBudget: number,
): Promise<PendingGetEvent[]> {
  const shopIds = [...new Set(items.map((item) => Number(item.shopId)))].sort((a, b) => a - b);
  if (shopIds.length < 2) return items;
  const db = await getDb();
  const fairness = db.collection<Document>("protractor_callback_fairness");
  const states = await fairness.find({ _id: { $in: shopIds } } as Document).toArray();
  const lastServed = new Map(states.map((state) => [
    Number(state._id),
    state.lastSuccessfullyServedAt instanceof Date
      ? state.lastSuccessfullyServedAt.getTime()
      : Number.NEGATIVE_INFINITY,
  ]));
  const leastRecentlyServed = shopIds.slice().sort((a, b) =>
    (lastServed.get(a) ?? Number.NEGATIVE_INFINITY) -
      (lastServed.get(b) ?? Number.NEGATIVE_INFINITY) || a - b);
  const rank = new Map(leastRecentlyServed.map((id, index) => [id, index]));
  const ordered = items.slice().sort((a, b) =>
    (rank.get(Number(a.shopId)) ?? 0) - (rank.get(Number(b.shopId)) ?? 0));
  return ordered;
}

/** Advance fairness only after a fenced generation completion succeeds. */
export async function markCallbackShopSuccessfullyServed(
  shopId: number,
  eventKey: CallbackEventKey,
): Promise<void> {
  const db = await getDb();
  await db.collection<Document>("protractor_callback_fairness").updateOne(
    { _id: shopId } as Document,
    [{
      $set: {
        lastSuccessfullyServedAt: "$$NOW",
        lastSuccessfullyServedEventKey: eventKey,
      },
    }],
    { upsert: true },
  );
}

export async function findPendingGetEvents(
  limit: number,
  maxAttempts: number,
  servedShopBudget = limit,
  receivedNotBefore?: Date,
  recoveryLimit = 0,
): Promise<PendingGetEvent[]> {
  if (isProtractorOpsPgCanonical()) {
    const rows = await pg.findPendingGetEvents(
      limit,
      maxAttempts,
      receivedNotBefore,
      recoveryLimit,
    );
    return rotatePendingByFleetCursor(rows.map((r) => ({
      key: r.eventKey,
      method: r.method,
      shopId: Number(r.shopId),
      objectType: r.objectType,
      objectId: r.objectId,
      operation: r.method === "POST"
        ? String(r.operation || "").trim().toUpperCase()
        : r.operation,
      status: r.status,
      receivedAt: r.receivedAt,
      winnerTieBreaker: r.winnerTieBreaker,
      terminalFromCoalesce: r.terminalFromCoalesce,
      terminalRank: r.terminalRank,
      ...(recoveryLimit > 0 && r.selectionLane ? { selectionLane: r.selectionLane } : {}),
    })), servedShopBudget);
  }
  const col = await collection();
  const validReceivedNotBefore =
    receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
      ? receivedNotBefore
      : undefined;
  const matchBase = {
    method: { $in: ["GET", "POST"] },
    processed: false,
    // Do this in the indexed fresh read rather than after its limit. Contact
    // notifications remain unresolved records, but cannot spend a fresh slot.
    objectType: { $ne: UNSUPPORTED_CONTACT_OBJECT_TYPE },
    ...(validReceivedNotBefore ? { receivedAt: { $gte: validReceivedNotBefore } } : {}),
    $and: [
      {
        $or: [{ attempts: { $exists: false } }, { attempts: { $lt: maxAttempts } }],
      },
      { "historyOutcome.reason": { $ne: "unsupported_contact" } },
    ],
  };
  // Keep retrieval bounded to the newest indexed callback window. Fleet
  // fairness and generation coalescing happen in memory over this oversized
  // window; do not rank the entire historical queue on every minute tick.
  const fetchPriority = (
    priority: number,
    rowLimit: number,
    direction: 1 | -1 = -1,
  ) => col.find(
    { ...matchBase, priority },
    {
      hint: "method_1_processed_1_priority_1_receivedAt_1",
      maxTimeMS: 5_000,
    },
  ).sort({ receivedAt: direction }).limit(rowLimit).toArray();
  // Callback writers use priority 1; priority 0 is the supported urgent lane.
  // Missing or unknown priorities are intentionally not replayed by this
  // rollout path because they do not satisfy the current queue contract.
  const urgent = await fetchPriority(0, limit);
  const normal = urgent.length >= limit ? [] : await fetchPriority(1, limit - urgent.length);
  /*
   * The live queue index orders the equality prefix
   * (method, processed, priority) by receivedAt. Exact method/priority
   * streams traverse that same index oldest-first; do not predicate on
   * attempts/processingStartedAt, for which production has no queue index.
   * It intentionally includes safety-boundary rows as well as ordinary
   * failed attempts. Exact-case unsupported Contacts are the one known
   * non-replayable type excluded before this bounded read.
   */
  const recoveryFloorMs = validReceivedNotBefore?.getTime() ?? null;
  const fetchRecoveryPage = async (): Promise<{
    docs: Document[];
    generations: Map<string, string>;
    orders: Map<string, number>;
  }> => {
    if (recoveryLimit <= 0) return { docs: [], generations: new Map(), orders: new Map() };
    const cursorState = await readMongoRecoveryCursor(recoveryFloorMs);
    let cursor = cursorState.cursor;
    let buffer = cursorState.buffer;
    let revision = cursorState.revision;
    const rawBase = {
      method: { $in: RECOVERY_METHODS },
      processed: false,
      // Contacts have no replay handler. Exclude them before the bounded raw
      // page so they cannot fill carry-over capacity or delay older work.
      objectType: { $ne: UNSUPPORTED_CONTACT_OBJECT_TYPE },
      ...(validReceivedNotBefore ? { receivedAt: { $gte: validReceivedNotBefore } } : {}),
    };
    const replayableRaw = (doc: Document): boolean =>
      (doc.attempts === undefined || (typeof doc.attempts === "number" && doc.attempts < maxAttempts)) &&
      doc.objectType !== UNSUPPORTED_CONTACT_OBJECT_TYPE &&
      doc.historyOutcome?.reason !== UNSUPPORTED_CONTACT_REASON;
    // Buffered keys are re-read by _id every invocation. The buffer is only a
    // scheduling carry-over, never authority: completion, attempt, contact and
    // activation-floor changes prune it before it can be offered again.
    const bufferedIds = buffer
      .filter((entry) => ObjectId.isValid(entry.key))
      .map((entry) => new ObjectId(entry.key));
    const currentByKey = new Map<string, Document>();
    if (bufferedIds.length > 0) {
      const current = await col.find({
        ...rawBase,
        _id: { $in: bufferedIds },
      } as Document, { maxTimeMS: 5_000 }).toArray();
      for (const doc of current) {
        if (replayableRaw(doc)) currentByKey.set(String(doc._id), doc);
      }
    }
    const liveBuffer = buffer.filter((entry) => currentByKey.has(entry.key));
    if (liveBuffer.length !== buffer.length) {
      if (!(await writeMongoRecoveryCursor(cursor, liveBuffer, recoveryFloorMs, revision))) {
        return { docs: [], generations: new Map(), orders: new Map() };
      }
      buffer = liveBuffer;
      revision += 1;
    }
    // Four raw pages is a fixed per-invocation bound. Keep reading the same
    // stream after a rejected page so its cursor advances before moving on.
    const streams = RECOVERY_PRIORITIES.flatMap((priority) =>
      RECOVERY_METHODS.map((method) => ({ priority, method })));
    let index = cursor
      ? streams.findIndex((stream) =>
          stream.priority === cursor!.priority && stream.method === cursor!.method)
      : 0;
    for (let reads = 0;
      reads < 4 && index >= 0 && index < streams.length && buffer.length < RECOVERY_BUFFER_LIMIT;
    ) {
      const { priority, method } = streams[index];
        const after = cursor?.priority === priority && cursor.method === method
          ? {
              $or: [
                { receivedAt: { $gt: cursor.receivedAt } },
                { receivedAt: cursor.receivedAt, _id: { $gt: cursor.id } },
              ],
            }
          : {};
        const page = await col.find(
          { ...rawBase, method, priority, ...after },
          {
            hint: "method_1_processed_1_priority_1_receivedAt_1",
            maxTimeMS: 5_000,
          },
        /*
         * `_id` makes the persisted keyset total. The deployed index ends at
         * receivedAt, so this bounded 270-result tie sort may need an
         * in-memory DB sort; maxTimeMS keeps that index gap fail-closed.
         */
        ).sort({ receivedAt: 1, _id: 1 })
          .limit(Math.min(recoveryLimit, RECOVERY_BUFFER_LIMIT - buffer.length)).toArray();
      reads += 1;
      if (page.length === 0) {
        index += 1;
        continue;
      }
        const last = page.at(-1)!;
        cursor = {
          method,
          priority,
          receivedAt: last.receivedAt as Date,
          id: last._id as ObjectId,
          floorMs: recoveryFloorMs,
        };
        const knownKeys = new Set(buffer.map((entry) => entry.key));
        const additions = page
          .filter(replayableRaw)
          .filter((doc) => !knownKeys.has(String(doc._id)))
          .map((doc) => ({ key: String(doc._id), generation: randomUUID() }));
        for (const doc of page) {
          if (replayableRaw(doc)) currentByKey.set(String(doc._id), doc);
        }
        const nextBuffer = [...buffer, ...additions].slice(0, RECOVERY_BUFFER_LIMIT);
        if (!(await writeMongoRecoveryCursor(cursor, nextBuffer, recoveryFloorMs, revision))) {
          return { docs: [], generations: new Map(), orders: new Map() };
        }
        buffer = nextBuffer;
        revision += 1;
    }
    if (index >= streams.length &&
        !(await writeMongoRecoveryCursor(null, buffer, recoveryFloorMs, revision))) {
      return { docs: [], generations: new Map(), orders: new Map() };
    }
    const retained = buffer.filter((entry) => currentByKey.has(entry.key));
    return {
      docs: retained.map((entry) => currentByKey.get(entry.key)!),
      generations: new Map(retained.map((entry) => [entry.key, entry.generation])),
      orders: new Map(retained.map((entry, index) => [entry.key, index])),
    };
  };
  let recoveryDocs: Document[] = [];
  let recoveryGenerations = new Map<string, string>();
  let recoveryOrders = new Map<string, number>();
  try {
    const recovery = await fetchRecoveryPage();
    recoveryDocs = recovery.docs;
    recoveryGenerations = recovery.generations;
    recoveryOrders = recovery.orders;
  } catch {
    // Recovery is advisory. Preserve the already-bounded fresh window when
    // its cursor metadata/read times out; do not emit callback identifiers.
    console.warn("[ProtractorCallbackQueue] recovery lane unavailable");
  }
  // A buffered key owns the recovery lane even when the newest snapshot also
  // contains it. Otherwise overlap would silently consume a fresh slot and a
  // full fresh preselection could defer the one reserved recovery turn.
  const docs = [
    ...[...urgent, ...normal]
      .filter((d) => !recoveryGenerations.has(String(d._id)))
      .map((d) => ({
        doc: d,
        selectionLane: "fresh" as const,
        recoveryBufferGeneration: undefined as string | undefined,
        recoveryBufferOrder: undefined as number | undefined,
      })),
    ...recoveryDocs
      .map((d) => ({
        doc: d,
        selectionLane: "recovery" as const,
        recoveryBufferGeneration: recoveryGenerations.get(String(d._id)),
        recoveryBufferOrder: recoveryOrders.get(String(d._id)),
      })),
  ];
  return rotatePendingByFleetCursor(docs.map(({
    doc: d, selectionLane, recoveryBufferGeneration, recoveryBufferOrder,
  }) => ({
    key: (d._id as ObjectId).toHexString(),
    method: d.method as "GET" | "POST",
    shopId: d.shopId as number,
    objectType: (d.objectType as string) ?? null,
    objectId: (d.objectId as string) ?? null,
    operation: d.method === "POST"
      ? String(d.operation || "").trim().toUpperCase()
      : ((d.operation as string) ?? null),
    status: (d.status as string) ?? null,
    receivedAt: d.receivedAt as Date | undefined,
    winnerTieBreaker: (d._id as ObjectId).toHexString(),
    terminalRank: mongoTerminalRank(d),
    ...(recoveryLimit > 0 ? { selectionLane } : {}),
    ...(recoveryBufferGeneration ? { recoveryBufferGeneration } : {}),
    ...(recoveryBufferOrder !== undefined ? { recoveryBufferOrder } : {}),
  })), servedShopBudget);
}

/**
 * Acknowledge a recovery-buffer generation only after queue admission. This is
 * intentionally independent from callback completion: failed admitted work is
 * still discoverable on a later raw recovery pass.
 */
export async function acknowledgeRecoveryCandidate(
  key: CallbackEventKey,
  generation: string,
  receivedNotBefore?: Date,
): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.acknowledgeRecoveryCandidate(key, generation, receivedNotBefore);
    return;
  }
  const floorMs = receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
    ? receivedNotBefore.getTime()
    : null;
  const state = await readMongoRecoveryCursor(floorMs);
  const buffer = state.buffer.filter((entry) =>
    !(entry.key === key && entry.generation === generation));
  if (buffer.length === state.buffer.length) return;
  await writeMongoRecoveryCursor(state.cursor, buffer, floorMs, state.revision);
}

/**
 * A rejected authority snapshot does not alter event state; it just evicts the
 * exact carry-over generation so a permanently blocked prefix cannot consume
 * the bounded recovery slot. CAS loss is fail-safe retention.
 */
export async function pruneRecoveryCandidates(
  entries: Array<{ key: CallbackEventKey; generation: string }>,
  receivedNotBefore?: Date,
): Promise<void> {
  if (entries.length === 0) return;
  if (isProtractorOpsPgCanonical()) {
    await pg.pruneRecoveryCandidates(entries, receivedNotBefore);
    return;
  }
  const floorMs = receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
    ? receivedNotBefore.getTime()
    : null;
  const rejected = new Set(entries.map((entry) => `${entry.key}\u0000${entry.generation}`));
  const state = await readMongoRecoveryCursor(floorMs);
  const buffer = state.buffer.filter((entry) =>
    !rejected.has(`${entry.key}\u0000${entry.generation}`));
  if (buffer.length === state.buffer.length) return;
  await writeMongoRecoveryCursor(state.cursor, buffer, floorMs, state.revision);
}

/** Keep a live but unclaimed recovery candidate, rotating it behind peers. */
export async function rotateRecoveryCandidate(
  key: CallbackEventKey,
  generation: string,
  receivedNotBefore?: Date,
): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.rotateRecoveryCandidate(key, generation, receivedNotBefore);
    return;
  }
  const floorMs = receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
    ? receivedNotBefore.getTime()
    : null;
  const state = await readMongoRecoveryCursor(floorMs);
  const entry = state.buffer.find((item) =>
    item.key === key && item.generation === generation);
  if (!entry) return;
  const buffer = [...state.buffer.filter((item) => item !== entry), entry];
  await writeMongoRecoveryCursor(state.cursor, buffer, floorMs, state.revision);
}

/**
 * Read exact authoritative histories for a bounded fair candidate subset.
 * This intentionally has no writes: exhausted notifications and rejected
 * siblings remain unresolved exactly as before. The final durable claim still
 * fences arrivals and recovery races after this advisory read.
 */
export async function filterPendingCallbackCandidatesByAuthority(
  candidates: PendingGetEvent[],
  receivedNotBefore?: Date,
): Promise<PendingGetEvent[]> {
  if (isProtractorOpsPgCanonical()) {
    return pg.filterPendingCallbackCandidatesByAuthority(candidates, receivedNotBefore);
  }
  if (candidates.length === 0) return [];
  const col = await collection();
  const validReceivedNotBefore =
    receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
      ? receivedNotBefore
      : undefined;
  const chunks: PendingGetEvent[][] = [];
  for (let index = 0; index < candidates.length; index += 90) {
    chunks.push(candidates.slice(index, index + 90));
  }
  const authoritative: PendingGetEvent[] = [];
  for (const chunk of chunks) {
    const uniqueItems = new Map<string, PendingGetEvent>();
    for (const item of chunk) {
      if (item.objectType && item.objectId) {
        uniqueItems.set(JSON.stringify([
          Number(item.shopId), item.objectType, item.objectId,
        ]), item);
      }
    }
    const identities = [...uniqueItems.values()].map((item) => ({
        shopId: { $in: [Number(item.shopId), String(Number(item.shopId))] },
        objectType: item.objectType,
        objectId: item.objectId,
      }));
    if (identities.length === 0) continue;
    const docs = await col.aggregate([
      {
        $match: {
          processed: false,
          ...mongoReplayCandidateFilter(),
          ...(validReceivedNotBefore ? { receivedAt: { $gte: validReceivedNotBefore } } : {}),
          $or: identities,
        } as Document,
      },
      {
        $set: {
          _callbackTerminal: {
            $or: [
              {
                $regexMatch: {
                  input: { $convert: { input: "$operation", to: "string", onNull: "", onError: "" } },
                  regex: "^(DELETE|INVOICED|INVOICE|CLOSED|VOID)$",
                  options: "i",
                },
              },
              {
                $regexMatch: {
                  input: { $convert: { input: "$status", to: "string", onNull: "", onError: "" } },
                  regex: "^(DELETE|INVOICED|INVOICE|CLOSED|VOID)$",
                  options: "i",
                },
              },
            ],
          },
        },
      },
      { $sort: { _callbackTerminal: -1, receivedAt: -1, _id: -1 } },
      {
        $group: {
          _id: {
            shopId: { $convert: { input: "$shopId", to: "string", onNull: "", onError: "" } },
            objectType: "$objectType",
            objectId: "$objectId",
          },
          winner: { $first: "$$ROOT" },
        },
      },
      { $replaceRoot: { newRoot: "$winner" } },
      {
        $project: {
          _id: 1, method: 1, shopId: 1, objectType: 1, objectId: 1,
          operation: 1, status: 1, receivedAt: 1, _callbackTerminal: 1,
        },
      },
    ], {
      hint: "dedup_lookup",
      maxTimeMS: 5_000,
    }).toArray();
    authoritative.push(...docs.map((d) => {
      const key = (d._id as ObjectId).toHexString();
      return {
      key,
      method: d.method as "GET" | "POST",
      shopId: Number(d.shopId),
      objectType: (d.objectType as string) ?? null,
      objectId: (d.objectId as string) ?? null,
      operation: (d.operation as string) ?? null,
      status: (d.status as string) ?? null,
      receivedAt: d.receivedAt as Date | undefined,
      winnerTieBreaker: key,
      terminalRank: d._callbackTerminal ? 1 as const : 0 as const,
    };
    }));
  }
  const winners = callbackWindowWinners(
    authoritative,
    validReceivedNotBefore,
  );
  const winningKeys = new Set(winners.map((item) => item.key));
  return candidates.filter((item) => winningKeys.has(item.key));
}

/**
 * Webhook-health: per-shop received counts since `since`.
 *
 * `dbOverride` exists solely for the webhook-health route's `__deps`
 * test seam (fake Mongo db); production callers pass nothing.
 */
export async function countsByShopSince(
  shopIds: number[],
  since: Date,
  dbOverride?: Db,
): Promise<Array<{ shopId: number; count: number }>> {
  if (isProtractorOpsPgCanonical()) {
    return pg.countsByShopSince(shopIds, since);
  }
  const col = dbOverride ? dbOverride.collection(COLLECTION) : await collection();
  const rows = await col
    .aggregate([
      { $match: { receivedAt: { $gte: since }, shopId: { $in: shopIds } } },
      { $group: { _id: "$shopId", count: { $sum: 1 } } },
    ])
    .toArray();
  return (rows as Array<{ _id: number; count: number }>).map((r) => ({
    shopId: Number(r._id),
    count: r.count,
  }));
}

/** Webhook-health processing-lag: GET events by receivedAt/processedAt window. */
export async function countGetSince(
  field: "receivedAt" | "processedAt",
  since: Date,
  dbOverride?: Db,
): Promise<number> {
  if (isProtractorOpsPgCanonical()) {
    return pg.countGetSince(field, since);
  }
  const col = dbOverride ? dbOverride.collection(COLLECTION) : await collection();
  return col.countDocuments({ method: "GET", [field]: { $gte: since } });
}

/** af-log-tail: (connectionId, shopId) pairs with most-recent receivedAt. */
export async function connectionShopPairs(): Promise<
  Array<{ connectionId: string; shopId: number; last: Date | null }>
> {
  if (isProtractorOpsPgCanonical()) {
    return pg.connectionShopPairs();
  }
  const col = await collection();
  const rows = await col
    .aggregate([
      { $match: { connectionId: { $exists: true, $ne: null }, shopId: { $exists: true, $ne: null } } },
      { $group: { _id: { cid: "$connectionId", shopId: "$shopId" }, last: { $max: "$receivedAt" } } },
    ])
    .toArray();
  return rows
    .map((row: any) => ({
      connectionId: row?._id?.cid,
      shopId: row?._id?.shopId,
      last: row?.last ? new Date(row.last) : null,
    }))
    .filter(
      (r: any): r is { connectionId: string; shopId: number; last: Date | null } =>
        typeof r.connectionId === "string" && typeof r.shopId === "number",
    );
}

export interface CallbackOutcomeReportRow {
  method: "GET" | "POST";
  shopId: number;
  receivedAt: string | null;
  category: string;
  reason: string;
  indexedJobs?: number;
  changedJobs?: number;
}

export interface CallbackOutcomeReport {
  sampleLimit: 200;
  windowHours: 24;
  sampled: number;
  counts: Record<string, number>;
  rows: CallbackOutcomeReportRow[];
}

function reportReceivedAt(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function reportOutcome(value: unknown): {
  category: string;
  reason: string;
  indexedJobs?: number;
  changedJobs?: number;
} {
  const parsed = parseCallbackHistoryOutcome(value);
  if (!parsed) return { category: "unknown", reason: "unknown" };
  return parsed;
}

/**
 * Return only a recent, bounded, redacted sample. The Mongo read is pinned to
 * the existing receivedAt_-1 index; the projection excludes raw payloads,
 * identifiers, VINs, customer fields, and error strings. Legacy rows remain
 * `unknown` rather than being treated as successful applications.
 */
export async function getCallbackOutcomeReport(
  dbOverride?: Db,
): Promise<CallbackOutcomeReport> {
  if (isProtractorOpsPgCanonical()) {
    return pg.getCallbackOutcomeReport();
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const col = dbOverride ? dbOverride.collection(COLLECTION) : await collection();
  const docs = await col.find(
    { receivedAt: { $gte: since } } as Document,
    {
      projection: { method: 1, shopId: 1, receivedAt: 1, historyOutcome: 1 },
      maxTimeMS: 5_000,
      hint: "receivedAt_-1",
    },
  ).sort({ receivedAt: -1 }).limit(200).toArray();
  const counts: Record<string, number> = {};
  const rows = docs.map((doc: Document) => {
    const outcome = reportOutcome(doc.historyOutcome);
    counts[outcome.category] = (counts[outcome.category] ?? 0) + 1;
    const shopId = Number(doc.shopId);
    return {
      method: doc.method === "GET" ? "GET" as const : "POST" as const,
      shopId: Number.isFinite(shopId) ? shopId : 0,
      receivedAt: reportReceivedAt(doc.receivedAt),
      category: outcome.category,
      reason: outcome.reason,
      ...(outcome.indexedJobs === undefined ? {} : { indexedJobs: outcome.indexedJobs }),
      ...(outcome.changedJobs === undefined ? {} : { changedJobs: outcome.changedJobs }),
    };
  });
  return {
    sampleLimit: 200,
    windowHours: 24,
    sampled: rows.length,
    counts,
    rows,
  };
}

/**
 * Mongo-only index ensure used by the webhook-health cron. No-op when
 * PG is canonical (PG indexes ship in drizzle/0024).
 */
export async function ensureHealthScanIndexes(dbOverride?: Db): Promise<void> {
  if (isProtractorOpsPgCanonical()) return;
  const col = dbOverride ? dbOverride.collection(COLLECTION) : await collection();
  await col.createIndex({ receivedAt: -1 }, { name: "receivedAt_-1" }).catch(() => {});
  await col
    .createIndex({ method: 1, receivedAt: -1 }, { name: "method_1_receivedAt_-1" })
    .catch(() => {});
  await col
    .createIndex({ method: 1, processedAt: -1 }, { name: "method_1_processedAt_-1" })
    .catch(() => {});
}
