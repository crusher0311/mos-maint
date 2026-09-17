/**
 * Postgres-backed `protractor_callback_events` — the read/write surface
 * used by `lib/data/repositories/protractor-callback-events.ts` when
 * `PROTRACTOR_OPS_PG_CANONICAL=1` (task #1006, finishing task #999).
 *
 * The webhook request path threads a stable per-event key across the
 * request. In PG that key is the app-generated UUID stored in
 * `event_key` (unique index) — the serial `id` PK never leaves this
 * module, so the ObjectId-shaped contract the Mongo flow relied on is
 * replaced by an app-generated key that works identically in both
 * stores.
 *
 * The dispatcher (PG-vs-Mongo + Mongo shadow write) lives in the repo
 * next to the call sites — this file has no knowledge of the
 * kill-switch flag.
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, max, or, sql } from "drizzle-orm";
import type { Document } from "mongodb";
import { getDb } from "@/lib/db/drizzle";
import { getDb as getMongoDb } from "@/lib/data/db";
import { protractorCallbackEvents as t } from "@/lib/db/schema/wave3";
import {
  DEFAULT_CALLBACK_HISTORY_OUTCOME,
  normalizeCallbackHistoryOutcome,
  parseCallbackHistoryOutcome,
  type CallbackHistoryOutcome,
} from "@/lib/integrations/protractor/callback-outcomes";
import {
  logCallbackClaimRejection,
  type CallbackClaimTelemetryContext,
} from "@/lib/integrations/protractor/callback-claim-telemetry";

const CALLBACK_OUTCOME_JSON_KEY = "historyOutcome";
const CALLBACK_OUTCOME_COALESCED: CallbackHistoryOutcome = {
  category: "coalesced",
  reason: "superseded",
};
const UNSUPPORTED_CONTACT_REASON = "unsupported_contact";
const RECOVERY_PRIORITIES = [0, 1] as const;
const RECOVERY_METHODS = ["GET", "POST"] as const;
const RECOVERY_CURSOR_PREFIX = "protractor_callback_recovery_cursor";
const RECOVERY_BUFFER_LIMIT = 270;
type PgRecoveryCursor = {
  method: "GET" | "POST";
  priority: 0 | 1;
  receivedAt: Date;
  id: number;
  floorMs: number | null;
};
type PgRecoveryBufferEntry = { key: string; generation: string };
type PgRecoveryCursorState = {
  cursor: PgRecoveryCursor | null;
  buffer: PgRecoveryBufferEntry[];
  revision: number;
};

function recoveryCursorDocumentId(floorMs: number | null): string {
  return `${RECOVERY_CURSOR_PREFIX}:pg:${floorMs ?? "none"}`;
}

async function readPgRecoveryCursor(floorMs: number | null): Promise<PgRecoveryCursorState> {
  const doc = await (await getMongoDb()).collection<Document>("protractor_callback_fairness").findOne({
    _id: recoveryCursorDocumentId(floorMs),
  } as Document);
  const cursor = doc?.callbackRecoveryCursor as Partial<PgRecoveryCursor> | undefined;
  const validCursor = typeof cursor?.id === "number" &&
    (cursor.method === "GET" || cursor.method === "POST") &&
    (cursor.priority === 0 || cursor.priority === 1) &&
    cursor.receivedAt instanceof Date &&
    cursor.floorMs === floorMs
    ? cursor as PgRecoveryCursor
    : null;
  return {
    cursor: validCursor,
    buffer: Array.isArray(doc?.callbackRecoveryBuffer)
      ? doc.callbackRecoveryBuffer.filter((entry: unknown): entry is PgRecoveryBufferEntry =>
          !!entry && typeof (entry as PgRecoveryBufferEntry).key === "string" &&
          typeof (entry as PgRecoveryBufferEntry).generation === "string",
        ).slice(0, RECOVERY_BUFFER_LIMIT)
      : [],
    revision: typeof doc?.callbackRecoveryCursorRevision === "number"
      ? doc.callbackRecoveryCursorRevision
      : 0,
  };
}

async function writePgRecoveryCursor(
  cursor: PgRecoveryCursor | null,
  buffer: PgRecoveryBufferEntry[],
  floorMs: number | null,
  revision: number,
): Promise<boolean> {
  try {
    const result = await (await getMongoDb()).collection<Document>("protractor_callback_fairness").updateOne(
      {
        _id: recoveryCursorDocumentId(floorMs),
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
    if (error?.code === 11000 || /duplicate key/i.test(String(error?.message))) return false;
    throw error;
  }
}

export interface InsertPostEventFields {
  eventKey: string;
  receivedAt: Date;
  payload: unknown;
  workOrderId: string;
  status: string | null;
  connectionId: string;
  shopId: number | null;
  deferredForReplay?: boolean;
}

export interface InsertGetEventFields {
  eventKey: string;
  receivedAt: Date;
  connectionId: string;
  objectType: string;
  objectId: string;
  operation: string | null;
  shopId: number;
}

export interface CallbackAdmissionIdentity {
  shopId: number;
  method: "GET" | "POST";
  objectType: string;
  objectId: string;
  operation: string | null;
  terminal?: boolean;
}

/** Pure counterpart to the SQL POST admission predicate (regression-testable). */
export function isPostAdmissionMatch(
  row: { method: string | null; shopId: number | null; workOrderId: string | null; status: string | null },
  identity: CallbackAdmissionIdentity,
): boolean {
  return identity.method === "POST" &&
    (row.method === null || row.method === "POST") &&
    row.shopId === identity.shopId &&
    row.workOrderId === identity.objectId &&
    (
      identity.operation === "*" ||
      (row.status || "").toUpperCase() === (identity.operation || "")
    );
}

function identityWhere(identity: CallbackAdmissionIdentity) {
  const methodWhere = identity.operation === "*"
    ? sql`TRUE`
    : identity.method === "POST"
      ? or(sql`${t.method} IS NULL`, eq(t.method, "POST"))
      : eq(t.method, "GET");
  const objectWhere = identity.operation === "*" && identity.objectType === "WorkOrder"
    ? or(
        eq(t.workOrderId, identity.objectId),
        and(eq(t.objectType, "WorkOrder"), eq(t.objectId, identity.objectId)),
      )
    : identity.method === "POST"
      ? eq(t.workOrderId, identity.objectId)
      : and(eq(t.objectType, identity.objectType), eq(t.objectId, identity.objectId));
  if (identity.method === "POST") {
    return and(
      methodWhere,
      eq(t.shopId, identity.shopId),
      objectWhere!,
      identity.operation === "*"
        ? sql`TRUE`
        : sql`upper(coalesce(${t.status}, '')) = ${identity.operation ?? ""}`,
    );
  }
  return and(
    methodWhere,
    eq(t.shopId, identity.shopId),
    objectWhere!,
    identity.operation === "*"
      ? sql`TRUE`
      : identity.operation == null
      ? sql`${t.operation} IS NULL`
      : eq(t.operation, identity.operation),
  );
}

function identityLockKey(identity: CallbackAdmissionIdentity): string {
  return JSON.stringify([
    identity.shopId,
    identity.objectType,
    identity.objectId,
  ]);
}

function outcomePayload(payload: unknown, outcome: CallbackHistoryOutcome): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      ...(payload as Record<string, unknown>),
      [CALLBACK_OUTCOME_JSON_KEY]: outcome,
    };
  }
  return {
    callbackPayload: payload ?? null,
    [CALLBACK_OUTCOME_JSON_KEY]: outcome,
  };
}

function setOutcomeSql(outcome: CallbackHistoryOutcome) {
  return sql`
    jsonb_set(
      CASE
        WHEN jsonb_typeof(coalesce(${t.payload}, '{}'::jsonb)) = 'object'
          THEN coalesce(${t.payload}, '{}'::jsonb)
        ELSE '{}'::jsonb
      END,
      '{historyOutcome}',
      ${JSON.stringify(outcome)}::jsonb,
      true
    )
  `;
}

function setOutcomeAndDeferralOwnerSql(
  outcome: CallbackHistoryOutcome,
  ownerToken: string,
) {
  return sql`
    jsonb_set(
      ${setOutcomeSql(outcome)},
      '{callbackDeferralOwnerToken}',
      ${JSON.stringify(ownerToken)}::jsonb,
      true
    )
  `;
}

function replayCandidateWhere() {
  return or(
    sql`(${t.payload} -> 'historyOutcome' ->> 'reason') IS NULL`,
    sql`(${t.payload} -> 'historyOutcome' ->> 'reason') <> ${UNSUPPORTED_CONTACT_REASON}`,
  );
}

export async function admitCallbackEvent(
  eventKey: string,
  identity: CallbackAdmissionIdentity,
  leaseMs: number,
  receivedNotBefore?: Date,
  maxAttempts = 3,
  claimContext?: CallbackClaimTelemetryContext,
): Promise<boolean> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - leaseMs);
  const validReceivedNotBefore =
    receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
      ? receivedNotBefore
      : undefined;
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey(identity)}, 0))`,
    );
    const winner = await tx
      .select({ eventKey: t.eventKey })
      .from(t)
      .where(and(
        identityWhere(identity),
        eq(t.processed, false),
        replayCandidateWhere(),
        ...(validReceivedNotBefore ? [gte(t.receivedAt, validReceivedNotBefore)] : []),
      ))
      .orderBy(
        desc(sql`CASE WHEN upper(coalesce(${t.operation}, ${t.status}, '')) IN ('DELETE','INVOICED','INVOICE','CLOSED','VOID') THEN 1 ELSE 0 END`),
        desc(t.receivedAt),
        desc(t.id),
      )
      .limit(1);
    if (winner[0]?.eventKey !== eventKey) {
      if (claimContext) {
        logCallbackClaimRejection(claimContext, "winner_changed");
      }
      return false;
    }
    const active = await tx
      .select({ eventKey: t.eventKey })
      .from(t)
      .where(
        and(
          identityWhere(identity),
          replayCandidateWhere(),
          ...(validReceivedNotBefore ? [gte(t.receivedAt, validReceivedNotBefore)] : []),
          isNotNull(t.processingStartedAt),
          gte(t.processingStartedAt, staleBefore),
        ),
      )
      .limit(1);
    if (active.length > 0) {
      if (claimContext) {
        logCallbackClaimRejection(claimContext, "fresh_ownership");
      }
      return false;
    }

    const claimed = await tx
      .update(t)
      .set({ processingStartedAt: now })
      .where(and(
        eq(t.eventKey, eventKey),
        eq(t.processed, false),
        replayCandidateWhere(),
        or(sql`${t.attempts} IS NULL`, lt(t.attempts, maxAttempts)),
        ...(validReceivedNotBefore ? [gte(t.receivedAt, validReceivedNotBefore)] : []),
      ))
      .returning({ eventKey: t.eventKey });
    if (claimed.length === 0) {
      if (claimContext) {
        logCallbackClaimRejection(claimContext, "candidate_unavailable");
      }
      return false;
    }
    return true;
  });
}

export async function claimCallbackEvent(
  eventKey: string,
  identity: CallbackAdmissionIdentity,
  leaseMs: number,
  receivedNotBefore?: Date,
  maxAttempts = 3,
  claimContext?: CallbackClaimTelemetryContext,
): Promise<string | null> {
  const telemetryContext: CallbackClaimTelemetryContext = claimContext ?? {
    store: "pg",
    eventKey,
    shopId: identity.shopId,
    objectType: identity.objectType,
    objectId: identity.objectId,
  };
  const validReceivedNotBefore =
    receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
      ? receivedNotBefore
      : undefined;
  const winner = await getDb()
    .select({ eventKey: t.eventKey })
    .from(t)
    .where(and(
      identityWhere(identity),
      eq(t.processed, false),
      replayCandidateWhere(),
      ...(validReceivedNotBefore ? [gte(t.receivedAt, validReceivedNotBefore)] : []),
    ))
    .orderBy(
      desc(sql`CASE WHEN upper(coalesce(${t.operation}, ${t.status}, '')) IN ('DELETE','INVOICED','INVOICE','CLOSED','VOID') THEN 1 ELSE 0 END`),
      desc(t.receivedAt),
      desc(t.id),
    )
    .limit(1);
  if (!winner[0]) {
    logCallbackClaimRejection(telemetryContext, "winner_absent");
    return null;
  }
  if (winner[0].eventKey !== eventKey) {
    logCallbackClaimRejection(telemetryContext, "winner_mismatch");
    return null;
  }
  if (!(await admitCallbackEvent(
    eventKey,
    identity,
    leaseMs,
    validReceivedNotBefore,
    maxAttempts,
    telemetryContext,
  ))) return null;
  const rows = await getDb()
    .select({ processingStartedAt: t.processingStartedAt })
    .from(t)
    .where(and(
      eq(t.eventKey, eventKey),
      eq(t.processed, false),
      replayCandidateWhere(),
      ...(validReceivedNotBefore ? [gte(t.receivedAt, validReceivedNotBefore)] : []),
    ))
    .limit(1);
  if (!rows[0]?.processingStartedAt) {
    logCallbackClaimRejection(telemetryContext, "event_fence");
    return null;
  }
  return rows[0].processingStartedAt.toISOString();
}

export async function finishCallbackEventAdmission(
  eventKey: string,
  identity: CallbackAdmissionIdentity,
  claimFollowUp: boolean,
): Promise<(CallbackAdmissionIdentity & { key: string }) | null> {
  const now = new Date();
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey(identity)}, 0))`,
    );
    await tx
      .update(t)
      .set({ processingStartedAt: null })
      .where(and(
        eq(t.eventKey, eventKey),
        isNotNull(t.processingStartedAt),
        replayCandidateWhere(),
      ));

    const pending = claimFollowUp
      ? await tx
          .select({ eventKey: t.eventKey })
          .from(t)
          .where(
            and(
              identityWhere(identity),
              eq(t.processed, false),
              replayCandidateWhere(),
              sql`${t.eventKey} <> ${eventKey}`,
            ),
          )
          .orderBy(desc(t.receivedAt), desc(t.id))
          .limit(1)
      : [];
    const pendingKey = pending[0]?.eventKey;

    await tx
      .update(t)
      .set({
        processed: true,
        processedAt: now,
        noAction: true,
        processingStartedAt: null,
        payload: setOutcomeSql(CALLBACK_OUTCOME_COALESCED),
      })
      .where(
        and(
          identityWhere(identity),
          eq(t.processed, false),
          replayCandidateWhere(),
          sql`${t.eventKey} <> ${eventKey}`,
          ...(pendingKey ? [sql`${t.eventKey} <> ${pendingKey}`] : []),
        ),
      );
    if (!pendingKey) return null;
    await tx
      .update(t)
      .set({ processingStartedAt: now })
      .where(eq(t.eventKey, pendingKey));
    return { ...identity, key: pendingKey };
  });
}

/** Release a queue worker claim without consuming callbacks that arrived in-flight. */
export async function releaseCallbackEventAdmission(
  eventKey: string,
  identity: CallbackAdmissionIdentity,
  ownerToken?: string,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey(identity)}, 0))`,
    );
    await tx
      .update(t)
      .set({ processingStartedAt: null })
      .where(and(
        eq(t.eventKey, eventKey),
        ...(ownerToken ? [eq(t.processingStartedAt, new Date(ownerToken))] : []),
      ));
  });
}

export async function completeCallbackGeneration(
  eventKey: string,
  identity: CallbackAdmissionIdentity,
  ownerToken: string,
  ownerReceivedAt: Date,
  outcome: CallbackHistoryOutcome = DEFAULT_CALLBACK_HISTORY_OUTCOME,
  coalesceNotBefore?: Date,
): Promise<boolean> {
  const db = getDb();
  const ownerOutcome = normalizeCallbackHistoryOutcome(outcome);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey(identity)}, 0))`,
    );
    const terminalPredicate = sql`
      upper(coalesce(${t.operation}, ${t.status}, '')) IN
      ('DELETE','INVOICED','INVOICE','CLOSED','VOID')
    `;
    const owner = await tx
      .select({ eventKey: t.eventKey })
      .from(t)
      .where(and(
        eq(t.eventKey, eventKey),
        eq(t.processed, false),
        eq(t.processingStartedAt, new Date(ownerToken)),
        replayCandidateWhere(),
      ))
      .limit(1);
    if (owner.length !== 1) return false;
    const completedOwner = await tx
      .update(t)
      .set({
        processed: true,
        processedAt: new Date(),
        noAction: true,
        processingStartedAt: null,
        payload: setOutcomeSql(ownerOutcome),
      })
      .where(and(
        eq(t.eventKey, eventKey),
        eq(t.processed, false),
        eq(t.processingStartedAt, new Date(ownerToken)),
        replayCandidateWhere(),
      ))
      .returning({ eventKey: t.eventKey });
    if (completedOwner.length !== 1) return false;
    await tx
      .update(t)
      .set({
        processed: true,
        processedAt: new Date(),
        noAction: true,
        processingStartedAt: null,
        payload: setOutcomeSql(CALLBACK_OUTCOME_COALESCED),
      })
      .where(and(
        identityWhere(identity),
        eq(t.processed, false),
        replayCandidateWhere(),
        sql`${t.eventKey} <> ${eventKey}`,
        sql`${t.receivedAt} <= ${ownerReceivedAt}`,
        ...(coalesceNotBefore instanceof Date && Number.isFinite(coalesceNotBefore.getTime())
          ? [sql`${t.receivedAt} >= ${coalesceNotBefore}`]
          : []),
        ...(identity.terminal ? [] : [sql`NOT (${terminalPredicate})`]),
      ));
    return true;
  });
}

export async function insertPostEvent(f: InsertPostEventFields): Promise<void> {
  await getDb().insert(t).values({
    eventKey: f.eventKey,
    receivedAt: f.receivedAt,
    ...(f.deferredForReplay ? {
      method: "POST" as const,
      objectType: "WorkOrder",
      objectId: f.workOrderId,
      operation: f.status ?? null,
      attempts: 0,
      priority: 1,
    } : {}),
    payload: outcomePayload(f.payload, {
      category: "deferred",
      reason: "pending_replay",
    }),
    workOrderId: f.workOrderId,
    status: f.status ?? null,
    connectionId: f.connectionId,
    shopId: f.shopId,
    processed: false,
  });
}

export async function insertGetEvent(f: InsertGetEventFields): Promise<void> {
  await getDb().insert(t).values({
    eventKey: f.eventKey,
    receivedAt: f.receivedAt,
    method: "GET",
    connectionId: f.connectionId,
    objectType: f.objectType,
    objectId: f.objectId,
    operation: f.operation ?? null,
    shopId: f.shopId,
    processed: false,
    attempts: 0,
    priority: 1,
    payload: outcomePayload(null, {
      category: "deferred",
      reason: "pending_replay",
    }),
  });
}

/** Rate-limit helper: events for this connectionId since `windowStart`. */
export async function countRecentByConnection(
  connectionId: string,
  windowStart: Date,
): Promise<number> {
  const rows = await getDb()
    .select({ n: count() })
    .from(t)
    .where(and(eq(t.connectionId, connectionId), gte(t.receivedAt, windowStart)));
  return Number(rows[0]?.n ?? 0);
}

/** POST dedup: a processed event for (workOrderId, status) since `since`. */
export async function hasRecentProcessedPost(
  workOrderId: string,
  status: string | null,
  since: Date,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.workOrderId, workOrderId),
        status == null ? sql`${t.status} IS NULL` : eq(t.status, status),
        eq(t.processed, true),
        gte(t.processedAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** GET dedup: returns processedAt of a recent processed duplicate, or null. */
export async function findRecentProcessedGet(
  shopId: number,
  objectType: string,
  objectId: string,
  operation: string | null,
  since: Date,
): Promise<{ processedAt: Date } | null> {
  const rows = await getDb()
    .select({ processedAt: t.processedAt })
    .from(t)
    .where(
      and(
        eq(t.shopId, shopId),
        eq(t.objectType, objectType),
        eq(t.objectId, objectId),
        operation == null ? sql`${t.operation} IS NULL` : eq(t.operation, operation),
        eq(t.processed, true),
        gte(t.processedAt, since),
      ),
    )
    .limit(1);
  const p = rows[0]?.processedAt;
  return p ? { processedAt: p } : null;
}

export async function markProcessedByKey(
  eventKey: string,
  fields: {
    vin?: string;
    workOrderNumber?: string | number | null;
    noAction?: boolean;
    deletedFromDashboard?: boolean;
    historyOutcome?: CallbackHistoryOutcome;
  } = {},
): Promise<void> {
  await getDb()
    .update(t)
    .set({
      processed: true,
      processedAt: new Date(),
      ...(fields.vin !== undefined ? { vin: fields.vin } : {}),
      ...(fields.workOrderNumber !== undefined
        ? { workOrderNumber: fields.workOrderNumber == null ? null : String(fields.workOrderNumber) }
        : {}),
      ...(fields.noAction !== undefined ? { noAction: fields.noAction } : {}),
      ...(fields.deletedFromDashboard !== undefined
        ? { deletedFromDashboard: fields.deletedFromDashboard }
        : {}),
      ...(fields.historyOutcome !== undefined
        ? { payload: setOutcomeSql(normalizeCallbackHistoryOutcome(fields.historyOutcome)) }
        : {}),
    })
    .where(eq(t.eventKey, eventKey));
}

/**
 * Mirrors the Mongo `updateOne({workOrderId, status, processed:false})`
 * shape used on the POST closed-WO path: stamp exactly ONE unprocessed
 * event for this (workOrderId, status) — oldest first for determinism.
 */
export async function markOneProcessedByWorkOrderStatus(
  workOrderId: string,
  status: string | null,
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.workOrderId, workOrderId),
        status == null ? sql`${t.status} IS NULL` : eq(t.status, status),
        eq(t.processed, false),
      ),
    )
    .orderBy(asc(t.receivedAt))
    .limit(1);
  if (rows.length === 0) return;
  await db
    .update(t)
    .set({ processed: true, processedAt: new Date() })
    .where(eq(t.id, rows[0].id));
}

/**
 * Mirrors the protractor-sync queue's
 * `updateOne({objectId, objectType, processed:false})` stamp — oldest
 * unprocessed event for the object.
 */
export async function markOneProcessedByObject(
  objectId: string,
  objectType: string,
  fields: { vin?: string; workOrderNumber?: string | number | null } = {},
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.objectId, objectId), eq(t.objectType, objectType), eq(t.processed, false)))
    .orderBy(asc(t.receivedAt))
    .limit(1);
  if (rows.length === 0) return;
  await db
    .update(t)
    .set({
      processed: true,
      processedAt: new Date(),
      ...(fields.vin !== undefined ? { vin: fields.vin } : {}),
      ...(fields.workOrderNumber !== undefined
        ? { workOrderNumber: fields.workOrderNumber == null ? null : String(fields.workOrderNumber) }
        : {}),
    })
    .where(eq(t.id, rows[0].id));
}

/** `$set lastAttemptAt [,lastError]` + `$inc attempts`. */
export async function recordAttempt(eventKey: string, lastError?: string): Promise<void> {
  await getDb()
    .update(t)
    .set({
      lastAttemptAt: new Date(),
      attempts: sql`COALESCE(${t.attempts}, 0) + 1`,
      ...(lastError !== undefined ? { lastError: lastError.slice(0, 500) } : {}),
    })
    .where(eq(t.eventKey, eventKey));
}

/** Increment attempts without changing the immutable admission fence. */
export async function recordProcessingStarted(eventKey: string): Promise<void> {
  await getDb()
    .update(t)
    .set({
      lastAttemptAt: new Date(),
      attempts: sql`COALESCE(${t.attempts}, 0) + 1`,
    })
    .where(eq(t.eventKey, eventKey));
}

/** `$set lastError, lastErrorAt` (queue-drain failure stamp; no $inc). */
export async function recordError(
  eventKey: string,
  message: string,
  ownerToken?: string,
): Promise<void> {
  const ownerStartedAt = ownerToken ? new Date(ownerToken) : null;
  if (ownerToken && Number.isNaN(ownerStartedAt!.getTime())) return;
  await getDb()
    .update(t)
    .set({ lastError: message, lastErrorAt: new Date() })
    .where(and(
      eq(t.eventKey, eventKey),
      ...(ownerStartedAt
        ? [eq(t.processed, false), eq(t.processingStartedAt, ownerStartedAt)]
        : []),
    ));
}

/** Persist queue-failure evidence only while this owner still holds the fence. */
export async function recordCallbackOutcome(
  eventKey: string,
  ownerToken: string,
  outcome: CallbackHistoryOutcome,
): Promise<void> {
  const ownerStartedAt = new Date(ownerToken);
  if (Number.isNaN(ownerStartedAt.getTime())) return;
  await getDb()
    .update(t)
    .set({ payload: setOutcomeSql(normalizeCallbackHistoryOutcome(outcome, {
      category: "failed",
      reason: "dispatch_failed",
    })) })
    .where(and(
      eq(t.eventKey, eventKey),
      eq(t.processed, false),
      eq(t.processingStartedAt, ownerStartedAt),
    ));
}

/**
 * Leave a safety-boundary callback replayable without charging the queue
 * attempt spent reaching that boundary.  The processing timestamp is the PG
 * owner fence established by claimCallbackEvent; no admission state is
 * changed here.
 */
export async function recordCallbackDeferral(
  eventKey: string,
  ownerToken: string,
  outcome: CallbackHistoryOutcome,
): Promise<void> {
  const ownerStartedAt = new Date(ownerToken);
  if (Number.isNaN(ownerStartedAt.getTime())) return;
  await getDb()
    .update(t)
    .set({
      payload: setOutcomeAndDeferralOwnerSql(
        normalizeCallbackHistoryOutcome(outcome),
        ownerToken,
      ),
      attempts: sql`GREATEST(COALESCE(${t.attempts}, 0) - 1, 0)`,
    })
    .where(and(
      eq(t.eventKey, eventKey),
      eq(t.processed, false),
      eq(t.processingStartedAt, ownerStartedAt),
      or(
        sql`${t.payload} ->> 'callbackDeferralOwnerToken' IS NULL`,
        sql`${t.payload} ->> 'callbackDeferralOwnerToken' <> ${ownerToken}`,
      ),
    ));
}

export interface PendingGetEvent {
  eventKey: string;
  method: "GET" | "POST";
  shopId: number | null;
  objectType: string | null;
  objectId: string | null;
  operation: string | null;
  status?: string | null;
  terminalRank?: 0 | 1;
  terminalFromCoalesce?: boolean;
  receivedAt: Date;
  winnerTieBreaker?: number;
  selectionLane?: "fresh" | "recovery";
  recoveryBufferGeneration?: string;
  recoveryBufferOrder?: number;
}

/** protractor-sync pre-sweep queue: unprocessed callback events under the attempt cap. */
export async function findPendingGetEvents(
  limit: number,
  maxAttempts: number,
  receivedNotBefore?: Date,
  recoveryLimit = 0,
): Promise<PendingGetEvent[]> {
  const db = getDb();
  const queueWhere = and(
    or(eq(t.method, "GET"), eq(t.method, "POST")),
    eq(t.processed, false),
    isNotNull(t.eventKey),
    or(sql`${t.attempts} IS NULL`, lt(t.attempts, maxAttempts)),
    replayCandidateWhere(),
    receivedNotBefore ? gte(t.receivedAt, receivedNotBefore) : undefined,
  );
  const fields = {
    id: t.id,
    eventKey: t.eventKey,
    method: t.method,
    shopId: t.shopId,
    objectType: t.objectType,
    objectId: t.objectId,
    operation: t.operation,
    status: t.status,
    terminalRank: sql<number>`
      CASE WHEN upper(coalesce(${t.operation}, ${t.status}, ''))
        IN ('DELETE','INVOICED','INVOICE','CLOSED','VOID')
      THEN 1 ELSE 0 END
    `,
    receivedAt: t.receivedAt,
    attempts: t.attempts,
    recoveryOutcomeReason: sql<string | null>`${t.payload} -> 'historyOutcome' ->> 'reason'`,
  };
  const freshRows = await db
    .select(fields)
    .from(t)
    .where(queueWhere)
    .orderBy(
      asc(t.priority),
      desc(t.receivedAt),
      desc(t.id),
    )
    .limit(limit);
  const recoveryRawWhere = and(
    or(eq(t.method, "GET"), eq(t.method, "POST")),
    eq(t.processed, false),
    isNotNull(t.eventKey),
    receivedNotBefore ? gte(t.receivedAt, receivedNotBefore) : undefined,
  );
  const readRecoveryStream = async (
    method: "GET" | "POST",
    priority: 0 | 1,
    cursor: PgRecoveryCursor | null,
    pageLimit: number,
  ) => db.transaction(async (tx) => {
    // Recovery is advisory; do not let a missing receivedAt/id tie index
    // consume the callback drain's 40-second admission budget.
    await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    return tx
      .select(fields)
      .from(t)
      .where(and(
        recoveryRawWhere,
        eq(t.method, method),
        eq(t.priority, priority),
        cursor?.priority === priority && cursor.method === method
          ? or(
              sql`${t.receivedAt} > ${cursor.receivedAt}`,
              and(eq(t.receivedAt, cursor.receivedAt), sql`${t.id} > ${cursor.id}`),
            )
          : undefined,
      ))
      .orderBy(asc(t.receivedAt), asc(t.id))
      .limit(pageLimit);
  });
  /*
   * Exact method/priority streams use the existing pending queue index
   * oldest-first. There is intentionally no attempts/stale-lease predicate:
   * no such production index exists. Retry/contact eligibility is applied
   * only after each raw page advances the persisted cursor.
   */
  const recoveryFloorMs = receivedNotBefore instanceof Date &&
    Number.isFinite(receivedNotBefore.getTime())
    ? receivedNotBefore.getTime()
    : null;
  const fetchRecoveryPage = async (): Promise<{
    rows: typeof freshRows;
    generations: Map<string, string>;
    orders: Map<string, number>;
  }> => {
    if (recoveryLimit <= 0) return { rows: [], generations: new Map(), orders: new Map() };
    const cursorState = await readPgRecoveryCursor(recoveryFloorMs);
    let cursor = cursorState.cursor;
    let buffer = cursorState.buffer;
    let revision = cursorState.revision;
    // Every carry-over item is checked against the live row on every
    // invocation. The buffer is not callback state and never overrides the
    // retry/contact/floor guards.
    const bufferedKeys = buffer.map((entry) => entry.key);
    const liveRows = bufferedKeys.length === 0 ? [] : await db
      .select(fields)
      .from(t)
      .where(and(
        recoveryRawWhere,
        inArray(t.eventKey, bufferedKeys),
        or(sql`${t.attempts} IS NULL`, lt(t.attempts, maxAttempts)),
        replayCandidateWhere(),
      ));
    const liveByKey = new Map(liveRows.map((row) => [row.eventKey as string, row]));
    const liveKeys = new Set(liveByKey.keys());
    const liveBuffer = buffer.filter((entry) => liveKeys.has(entry.key));
    if (liveBuffer.length !== buffer.length) {
      if (!(await writePgRecoveryCursor(cursor, liveBuffer, recoveryFloorMs, revision))) {
        return { rows: [], generations: new Map(), orders: new Map() };
      }
      buffer = liveBuffer;
      revision += 1;
    }
    // Match Mongo's fixed raw-page bound and consume rejected pages from the
    // same stream before moving to the next method/priority stream.
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
        const page = await readRecoveryStream(
          method,
          priority,
          cursor,
          Math.min(recoveryLimit, RECOVERY_BUFFER_LIMIT - buffer.length),
        );
      reads += 1;
      if (page.length === 0) {
        index += 1;
        continue;
      }
        const last = page.at(-1)!;
        cursor = {
          method,
          priority,
          receivedAt: last.receivedAt,
          id: last.id,
          floorMs: recoveryFloorMs,
        };
        const knownKeys = new Set(buffer.map((entry) => entry.key));
        const additions = page
          .filter((row) =>
            (row.attempts == null || row.attempts < maxAttempts) &&
            row.recoveryOutcomeReason !== UNSUPPORTED_CONTACT_REASON,
          )
          .filter((row) => !knownKeys.has(row.eventKey as string))
          .slice(0, RECOVERY_BUFFER_LIMIT - buffer.length)
          .map((row) => ({ key: row.eventKey as string, generation: randomUUID() }));
        for (const row of page) {
          if ((row.attempts == null || row.attempts < maxAttempts) &&
              row.recoveryOutcomeReason !== UNSUPPORTED_CONTACT_REASON) {
            liveByKey.set(row.eventKey as string, row);
          }
        }
        const nextBuffer = [...buffer, ...additions];
        if (!(await writePgRecoveryCursor(cursor, nextBuffer, recoveryFloorMs, revision))) {
          return { rows: [], generations: new Map(), orders: new Map() };
        }
        buffer = nextBuffer;
        revision += 1;
    }
    if (index >= streams.length &&
        !(await writePgRecoveryCursor(null, buffer, recoveryFloorMs, revision))) {
      return { rows: [], generations: new Map(), orders: new Map() };
    }
    const retained = buffer.filter((entry) => liveByKey.has(entry.key));
    return {
      rows: retained.map((entry) => liveByKey.get(entry.key)!),
      generations: new Map(retained.map((entry) => [entry.key, entry.generation])),
      orders: new Map(retained.map((entry, index) => [entry.key, index])),
    };
  };
  let recoveryRows: typeof freshRows = [];
  let recoveryGenerations = new Map<string, string>();
  let recoveryOrders = new Map<string, number>();
  try {
    const recovery = await fetchRecoveryPage();
    recoveryRows = recovery.rows;
    recoveryGenerations = recovery.generations;
    recoveryOrders = recovery.orders;
  } catch {
    // The fresh bounded query has already completed. Recovery metadata/read
    // failure must not abort provider work or expose a callback identifier.
    console.warn("[ProtractorCallbackQueue] recovery lane unavailable");
  }
  const rows = [
    // Buffered keys deliberately own recovery, even if present in fresh. This
    // preserves the reserved turn and avoids duplicate quota consumption.
    ...freshRows
      .filter((row) => !recoveryGenerations.has(row.eventKey as string))
      .map((row) => ({
        ...row,
        ...(recoveryLimit > 0 ? { selectionLane: "fresh" as const } : {}),
      })),
    ...recoveryRows
      .map((row) => ({
        ...row,
        selectionLane: "recovery" as const,
        recoveryBufferGeneration: recoveryGenerations.get(row.eventKey as string),
        recoveryBufferOrder: recoveryOrders.get(row.eventKey as string),
      })),
  ];
  return rows.map(({ attempts: _attempts, recoveryOutcomeReason: _reason, ...r }) => ({
    ...r,
    eventKey: r.eventKey as string,
    method: r.method as "GET" | "POST",
    terminalFromCoalesce: true,
    terminalRank: Number(r.terminalRank) === 1 ? 1 : 0,
    winnerTieBreaker: r.id,
  }));
}

/**
 * Remove only the exact buffered generation that was genuinely admitted.
 * A delayed worker cannot acknowledge a later re-buffer of the same event key:
 * the generation and fairness revision must both still match.
 */
export async function acknowledgeRecoveryCandidate(
  eventKey: string,
  generation: string,
  receivedNotBefore?: Date,
): Promise<void> {
  const floorMs = receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
    ? receivedNotBefore.getTime()
    : null;
  const state = await readPgRecoveryCursor(floorMs);
  const buffer = state.buffer.filter((entry) =>
    !(entry.key === eventKey && entry.generation === generation));
  if (buffer.length === state.buffer.length) return;
  await writePgRecoveryCursor(state.cursor, buffer, floorMs, state.revision);
}

/**
 * Authority rejection is not callback completion. It merely frees the bounded
 * scheduler carry-over so an exhausted/terminal prefix cannot reserve the one
 * recovery slot forever. A CAS loss retains work rather than deleting it.
 */
export async function pruneRecoveryCandidates(
  entries: Array<{ key: string; generation: string }>,
  receivedNotBefore?: Date,
): Promise<void> {
  if (entries.length === 0) return;
  const floorMs = receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
    ? receivedNotBefore.getTime()
    : null;
  const rejected = new Set(entries.map((entry) => `${entry.key}\u0000${entry.generation}`));
  const state = await readPgRecoveryCursor(floorMs);
  const buffer = state.buffer.filter((entry) =>
    !rejected.has(`${entry.key}\u0000${entry.generation}`));
  if (buffer.length === state.buffer.length) return;
  await writePgRecoveryCursor(state.cursor, buffer, floorMs, state.revision);
}

/** Keep an unclaimed live candidate durable, but move it behind its peers. */
export async function rotateRecoveryCandidate(
  eventKey: string,
  generation: string,
  receivedNotBefore?: Date,
): Promise<void> {
  const floorMs = receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
    ? receivedNotBefore.getTime()
    : null;
  const state = await readPgRecoveryCursor(floorMs);
  const entry = state.buffer.find((item) =>
    item.key === eventKey && item.generation === generation);
  if (!entry) return;
  const buffer = [...state.buffer.filter((item) => item !== entry), entry];
  await writePgRecoveryCursor(state.cursor, buffer, floorMs, state.revision);
}

/**
 * PG counterpart to Mongo's bounded exact-identity authority prefilter.
 * Querying is chunked so a queue tick never creates one predicate per member
 * of the 4,500-row candidate window.
 */
export async function filterPendingCallbackCandidatesByAuthority(
  candidates: Array<{
    key: string;
    method: "GET" | "POST";
    shopId: number;
    objectType: string | null;
    objectId: string | null;
    operation: string | null;
    status?: string | null;
    receivedAt?: Date;
    winnerTieBreaker?: string | number;
    terminalRank?: 0 | 1;
  }>,
  receivedNotBefore?: Date,
): Promise<typeof candidates> {
  if (candidates.length === 0) return [];
  const validReceivedNotBefore =
    receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
      ? receivedNotBefore
      : undefined;
  type RequestedIdentity = {
    method: "GET" | "POST";
    shopId: number;
    objectType: string;
    objectId: string;
  };
  type AuthorityRow = { eventKey?: string | null; event_key?: string | null };

  /*
   * Keep the method in this key.  The claim is object-scoped for locking, but
   * its identity predicate still distinguishes GET from POST (and accepts
   * method=NULL only for the legacy POST shape).
   */
  const requestedByIdentity = new Map<string, RequestedIdentity>();
  for (const item of candidates) {
    if (item.objectType == null || item.objectId == null) continue;
    const identity = {
      method: item.method,
      shopId: Number(item.shopId),
      objectType: item.objectType,
      objectId: item.objectId,
    };
    requestedByIdentity.set(JSON.stringify([
      identity.method,
      identity.shopId,
      identity.objectType,
      identity.objectId,
    ]), identity);
  }

  const authoritativeKeys = new Set<string>();
  const identities = [...requestedByIdentity.values()];
  const db = getDb();
  for (let offset = 0; offset < identities.length; offset += 90) {
    const chunk = identities.slice(offset, offset + 90);
    if (chunk.length === 0) continue;
    const requestedValues = sql.join(
      chunk.map((identity) => sql`(
        ${identity.method},
        ${identity.shopId},
        ${identity.objectType},
        ${identity.objectId}
      )`),
      sql`,`,
    );
    const floorPredicate = validReceivedNotBefore
      ? sql`AND e.received_at >= ${validReceivedNotBefore}`
      : sql``;
    /*
     * This is deliberately one VALUES/LATERAL read for the whole chunk.
     * Each lateral subquery has its own LIMIT 1, so PostgreSQL returns the
     * same top row that claimCallbackEvent would choose for that identity.
     * Every dynamic value is a bound parameter; no callback history is
     * materialized or ranked in Node.
     */
    const statement = sql`
      WITH requested(method, shop_id, object_type, object_id) AS (
        VALUES ${requestedValues}
      )
      SELECT winner.event_key AS "eventKey"
      FROM requested
      CROSS JOIN LATERAL (
        SELECT e.event_key
        FROM protractor_callback_events AS e
        WHERE e.event_key IS NOT NULL
          AND e.processed = false
          AND (
            (
              requested.object_type = 'WorkOrder'
              AND (
                e.work_order_id = requested.object_id
                OR (
                  e.object_type = 'WorkOrder'
                  AND e.object_id = requested.object_id
                )
              )
            )
            OR (
              requested.object_type <> 'WorkOrder'
              AND requested.method = 'POST'
              AND e.work_order_id = requested.object_id
            )
            OR (
              requested.object_type <> 'WorkOrder'
              AND requested.method = 'GET'
              AND e.object_type = requested.object_type
              AND e.object_id = requested.object_id
            )
          )
          AND (
            (e.payload -> 'historyOutcome' ->> 'reason') IS NULL
            OR (e.payload -> 'historyOutcome' ->> 'reason') <> ${UNSUPPORTED_CONTACT_REASON}
          )
          ${floorPredicate}
        ORDER BY
          CASE WHEN upper(coalesce(e.operation, e.status, ''))
            IN ('DELETE','INVOICED','INVOICE','CLOSED','VOID')
            THEN 1 ELSE 0 END DESC,
          e.received_at DESC,
          e.id DESC
        LIMIT 1
      ) AS winner
    `;
    const rowsResult = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      return tx.execute(statement);
    }) as unknown;
    const rows = Array.isArray(rowsResult)
      ? rowsResult
      : (rowsResult as { rows?: unknown[] } | null)?.rows ?? [];
    for (const row of rows as AuthorityRow[]) {
      const eventKey = row.eventKey ?? row.event_key;
      if (typeof eventKey === "string") authoritativeKeys.add(eventKey);
    }
  }

  /*
   * Candidates without an object identity intentionally bypass authority
   * lookup: the queue's direct (non-claiming) path owns those legacy rows.
   * Identity-bearing candidates survive only when their exact DB top-1 key
   * was returned.  In particular, do not normalize DB fields and run a
   * second in-memory winner pass; claim's wildcard WorkOrder fallback is
   * encoded entirely in the lateral predicate above.
   */
  return candidates.filter((item) =>
    item.objectType == null || item.objectId == null || authoritativeKeys.has(item.key),
  );
}

/** Webhook-health: per-shop received counts since `since`, shopId ∈ shopIds. */
export async function countsByShopSince(
  shopIds: number[],
  since: Date,
): Promise<Array<{ shopId: number; count: number }>> {
  if (shopIds.length === 0) return [];
  const rows = await getDb()
    .select({ shopId: t.shopId, n: count() })
    .from(t)
    .where(and(gte(t.receivedAt, since), inArray(t.shopId, shopIds)))
    .groupBy(t.shopId);
  return rows
    .filter((r) => r.shopId != null)
    .map((r) => ({ shopId: Number(r.shopId), count: Number(r.n) }));
}

/** Webhook-health processing-lag: GET events by receivedAt/processedAt window. */
export async function countGetSince(
  field: "receivedAt" | "processedAt",
  since: Date,
): Promise<number> {
  const col = field === "receivedAt" ? t.receivedAt : t.processedAt;
  const rows = await getDb()
    .select({ n: count() })
    .from(t)
    .where(and(eq(t.method, "GET"), gte(col, since)));
  return Number(rows[0]?.n ?? 0);
}

/* ----------------------- activity-profiles aggregate ---------------------- */

/**
 * PG twin of the burst-filtered Mongo aggregation the activity-profiles
 * repo (`lib/data/repositories/activity-profiles.ts`, task #662) runs over
 * `protractor_callback_events`: bucket events into UTC minutes per shop,
 * drop "machine burst" minutes (count >= burstThreshold) from the organic
 * stats, then return per-(shop, dow, hour) organic counts, raw per-shop
 * totals, and distinct organic active days.
 *
 * dow matches the Mongo path's `$dayOfWeek - 1` (0 = Sunday), computed on
 * the UTC-truncated minute, as does `extract(dow ...)` on the UTC
 * timestamp.
 */
export interface ActivityHistogramAgg {
  organic: Array<{ shopId: number; dow: number; hour: number; count: number }>;
  totals: Array<{ shopId: number; total: number }>;
  activeDays: Array<{ shopId: number; days: number }>;
}

export async function aggregateActivityHistogram(
  since: Date,
  burstThreshold: number,
): Promise<ActivityHistogramAgg> {
  const db = getDb();
  const minuteCte = sql`
    SELECT shop_id,
           date_trunc('minute', received_at AT TIME ZONE 'UTC') AS m,
           count(*)::int AS c
    FROM protractor_callback_events
    WHERE received_at >= ${since} AND shop_id IS NOT NULL
    GROUP BY 1, 2
  `;

  const organicRows = (await db.execute(sql`
    WITH mins AS (${minuteCte})
    SELECT shop_id,
           extract(dow FROM m)::int AS dow,
           extract(hour FROM m)::int AS h,
           sum(c)::int AS count
    FROM mins
    WHERE c < ${burstThreshold}
    GROUP BY 1, 2, 3
  `)) as unknown as Array<{ shop_id: number; dow: number; h: number; count: number }>;

  const totalRows = (await db.execute(sql`
    WITH mins AS (${minuteCte})
    SELECT shop_id, sum(c)::int AS total
    FROM mins
    GROUP BY 1
  `)) as unknown as Array<{ shop_id: number; total: number }>;

  const activeDayRows = (await db.execute(sql`
    WITH mins AS (${minuteCte})
    SELECT shop_id, count(DISTINCT date_trunc('day', m))::int AS days
    FROM mins
    WHERE c < ${burstThreshold}
    GROUP BY 1
  `)) as unknown as Array<{ shop_id: number; days: number }>;

  return {
    organic: organicRows.map((r) => ({
      shopId: Number(r.shop_id),
      dow: Number(r.dow),
      hour: Number(r.h),
      count: Number(r.count),
    })),
    totals: totalRows.map((r) => ({
      shopId: Number(r.shop_id),
      total: Number(r.total),
    })),
    activeDays: activeDayRows.map((r) => ({
      shopId: Number(r.shop_id),
      days: Number(r.days),
    })),
  };
}

/**
 * af-log-tail: distinct (connectionId, shopId) pairs with the most recent
 * receivedAt — mirrors the Mongo `$group {_id:{cid,shopId}, last:$max}`.
 */
export async function connectionShopPairs(): Promise<
  Array<{ connectionId: string; shopId: number; last: Date | null }>
> {
  const rows = await getDb()
    .select({ connectionId: t.connectionId, shopId: t.shopId, last: max(t.receivedAt) })
    .from(t)
    .where(and(isNotNull(t.connectionId), isNotNull(t.shopId)))
    .groupBy(t.connectionId, t.shopId)
    .orderBy(desc(max(t.receivedAt)));
  return rows
    .filter((r) => typeof r.connectionId === "string" && r.shopId != null)
    .map((r) => ({
      connectionId: r.connectionId as string,
      shopId: Number(r.shopId),
      last: r.last ?? null,
    }));
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

/**
 * Bounded, redacted callback-outcome sample. Each method gets its own bounded
 * read (2.5s statement timeout) so PostgreSQL can use
 * pro_cb_method_received_idx; the two windows are merged in memory and capped
 * at the newest 200 rows. Raw provider payload and error columns never cross
 * this repository boundary.
 */
export async function getCallbackOutcomeReport() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await getDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
    const boundedRows: any[] = [];
    for (const method of ["GET", "POST"] as const) {
      const methodRows = await tx
        .select({
          method: t.method,
          shopId: t.shopId,
          receivedAt: t.receivedAt,
          historyOutcome: sql<unknown>`${t.payload} -> 'historyOutcome'`,
        })
        .from(t)
        .where(and(eq(t.method, method), gte(t.receivedAt, since)))
        .orderBy(desc(t.receivedAt))
        .limit(200);
      boundedRows.push(...methodRows);
    }
    return boundedRows;
  });
  const counts: Record<string, number> = {};
  const reportReceivedTime = (value: unknown): number => {
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
    }
    if (typeof value === "string") {
      const time = Date.parse(value);
      return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
    }
    return Number.NEGATIVE_INFINITY;
  };
  const reportRows = rows
    .sort((a, b) => {
      return reportReceivedTime(b.receivedAt) - reportReceivedTime(a.receivedAt);
    })
    .slice(0, 200)
    .map((row) => {
      const outcome = parseCallbackHistoryOutcome(row.historyOutcome);
      const category = outcome?.category ?? "unknown";
      const reason = outcome?.reason ?? "unknown";
      counts[category] = (counts[category] ?? 0) + 1;
      return {
        method: row.method === "GET" ? "GET" as const : "POST" as const,
        shopId: row.shopId == null ? 0 : Number(row.shopId),
        receivedAt: reportReceivedAt(row.receivedAt),
        category,
        reason,
        ...(outcome?.indexedJobs === undefined ? {} : { indexedJobs: outcome.indexedJobs }),
        ...(outcome?.changedJobs === undefined ? {} : { changedJobs: outcome.changedJobs }),
      };
    });
  return {
    sampleLimit: 200 as const,
    windowHours: 24 as const,
    sampled: reportRows.length,
    counts,
    rows: reportRows,
  };
}
