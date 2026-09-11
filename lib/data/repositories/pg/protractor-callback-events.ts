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
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, max, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { protractorCallbackEvents as t } from "@/lib/db/schema/wave3";
import {
  DEFAULT_CALLBACK_HISTORY_OUTCOME,
  normalizeCallbackHistoryOutcome,
  parseCallbackHistoryOutcome,
  type CallbackHistoryOutcome,
} from "@/lib/integrations/protractor/callback-outcomes";

const CALLBACK_OUTCOME_JSON_KEY = "historyOutcome";
const CALLBACK_OUTCOME_COALESCED: CallbackHistoryOutcome = {
  category: "coalesced",
  reason: "superseded",
};

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

export async function admitCallbackEvent(
  eventKey: string,
  identity: CallbackAdmissionIdentity,
  leaseMs: number,
): Promise<boolean> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - leaseMs);
  return getDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey(identity)}, 0))`,
    );
    const winner = await tx
      .select({ eventKey: t.eventKey })
      .from(t)
      .where(and(identityWhere(identity), eq(t.processed, false)))
      .orderBy(
        desc(sql`CASE WHEN upper(coalesce(${t.operation}, ${t.status}, '')) IN ('DELETE','INVOICED','INVOICE','CLOSED','VOID') THEN 1 ELSE 0 END`),
        desc(t.receivedAt),
        desc(t.id),
      )
      .limit(1);
    if (winner[0]?.eventKey !== eventKey) return false;
    const active = await tx
      .select({ eventKey: t.eventKey })
      .from(t)
      .where(
        and(
          identityWhere(identity),
          isNotNull(t.processingStartedAt),
          gte(t.processingStartedAt, staleBefore),
        ),
      )
      .limit(1);
    if (active.length > 0) {
      return false;
    }

    const claimed = await tx
      .update(t)
      .set({ processingStartedAt: now })
      .where(and(eq(t.eventKey, eventKey), eq(t.processed, false)))
      .returning({ eventKey: t.eventKey });
    if (claimed.length === 0) return false;
    return true;
  });
}

export async function claimCallbackEvent(
  eventKey: string,
  identity: CallbackAdmissionIdentity,
  leaseMs: number,
): Promise<string | null> {
  const winner = await getDb()
    .select({ eventKey: t.eventKey })
    .from(t)
    .where(and(identityWhere(identity), eq(t.processed, false)))
    .orderBy(
      desc(sql`CASE WHEN upper(coalesce(${t.operation}, ${t.status}, '')) IN ('DELETE','INVOICED','INVOICE','CLOSED','VOID') THEN 1 ELSE 0 END`),
      desc(t.receivedAt),
      desc(t.id),
    )
    .limit(1);
  if (winner[0]?.eventKey !== eventKey) return null;
  if (!(await admitCallbackEvent(eventKey, identity, leaseMs))) return null;
  const rows = await getDb()
    .select({ processingStartedAt: t.processingStartedAt })
    .from(t)
    .where(and(eq(t.eventKey, eventKey), eq(t.processed, false)))
    .limit(1);
  return rows[0]?.processingStartedAt?.toISOString() ?? null;
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
      .where(and(eq(t.eventKey, eventKey), isNotNull(t.processingStartedAt)));

    const pending = claimFollowUp
      ? await tx
          .select({ eventKey: t.eventKey })
          .from(t)
          .where(
            and(
              identityWhere(identity),
              eq(t.processed, false),
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
        sql`${t.eventKey} <> ${eventKey}`,
        sql`${t.receivedAt} <= ${ownerReceivedAt}`,
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
export async function recordError(eventKey: string, message: string): Promise<void> {
  await getDb()
    .update(t)
    .set({ lastError: message, lastErrorAt: new Date() })
    .where(eq(t.eventKey, eventKey));
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

export interface PendingGetEvent {
  eventKey: string;
  method: "GET" | "POST";
  shopId: number | null;
  objectType: string | null;
  objectId: string | null;
  operation: string | null;
  receivedAt: Date;
}

/** protractor-sync pre-sweep queue: unprocessed callback events under the attempt cap. */
export async function findPendingGetEvents(
  limit: number,
  maxAttempts: number,
  receivedNotBefore?: Date,
): Promise<PendingGetEvent[]> {
  const db = getDb();
  const rows = await db
    .select({
      eventKey: t.eventKey,
      method: t.method,
      shopId: t.shopId,
      objectType: t.objectType,
      objectId: t.objectId,
      operation: t.operation,
      receivedAt: t.receivedAt,
    })
    .from(t)
    .where(
      and(
        or(eq(t.method, "GET"), eq(t.method, "POST")),
        eq(t.processed, false),
        isNotNull(t.eventKey),
        or(sql`${t.attempts} IS NULL`, lt(t.attempts, maxAttempts)),
        receivedNotBefore ? gte(t.receivedAt, receivedNotBefore) : undefined,
      ),
    )
    .orderBy(
      asc(t.priority),
      desc(t.receivedAt),
      desc(t.id),
    )
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    eventKey: r.eventKey as string,
    method: r.method as "GET" | "POST",
  }));
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
