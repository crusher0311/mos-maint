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
    (row.status || "").toUpperCase() === (identity.operation || "");
}

function identityWhere(identity: CallbackAdmissionIdentity) {
  if (identity.method === "POST") {
    return and(
      or(sql`${t.method} IS NULL`, eq(t.method, "POST")),
      eq(t.shopId, identity.shopId),
      eq(t.workOrderId, identity.objectId),
      sql`upper(coalesce(${t.status}, '')) = ${identity.operation ?? ""}`,
    );
  }
  return and(
    eq(t.method, "GET"),
    eq(t.shopId, identity.shopId),
    eq(t.objectType, identity.objectType),
    eq(t.objectId, identity.objectId),
    identity.operation == null
      ? sql`${t.operation} IS NULL`
      : eq(t.operation, identity.operation),
  );
}

function identityLockKey(identity: CallbackAdmissionIdentity): string {
  return JSON.stringify([
    identity.shopId,
    identity.method,
    identity.objectType,
    identity.objectId,
    identity.operation,
  ]);
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
      await tx
        .update(t)
        .set({ processed: true, processedAt: now, noAction: true })
        .where(
          and(
            identityWhere(identity),
            eq(t.processed, false),
            sql`${t.eventKey} <> ${eventKey}`,
            sql`${t.eventKey} <> ${active[0].eventKey}`,
          ),
        );
      return false;
    }

    const claimed = await tx
      .update(t)
      .set({ processingStartedAt: now })
      .where(and(eq(t.eventKey, eventKey), eq(t.processed, false)))
      .returning({ eventKey: t.eventKey });
    if (claimed.length === 0) return false;
    await tx
      .update(t)
      .set({ processed: true, processedAt: now, noAction: true, processingStartedAt: null })
      .where(
        and(
          identityWhere(identity),
          eq(t.processed, false),
          sql`${t.eventKey} <> ${eventKey}`,
        ),
      );
    return true;
  });
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
      .set({ processed: true, processedAt: now, noAction: true, processingStartedAt: null })
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
    payload: f.payload,
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

/** `$set processingStartedAt` + `$inc attempts` (queue-drain start stamp). */
export async function recordProcessingStarted(eventKey: string): Promise<void> {
  await getDb()
    .update(t)
    .set({
      processingStartedAt: new Date(),
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

export interface PendingGetEvent {
  eventKey: string;
  method: "GET" | "POST";
  shopId: number | null;
  objectType: string | null;
  objectId: string | null;
  operation: string | null;
}

/** protractor-sync pre-sweep queue: unprocessed callback events under the attempt cap. */
export async function findPendingGetEvents(
  limit: number,
  maxAttempts: number,
): Promise<PendingGetEvent[]> {
  const rows = await getDb()
    .select({
      eventKey: t.eventKey,
      method: t.method,
      shopId: t.shopId,
      objectType: t.objectType,
      objectId: t.objectId,
      operation: t.operation,
    })
    .from(t)
    .where(
      and(
        or(eq(t.method, "GET"), eq(t.method, "POST")),
        eq(t.processed, false),
        isNotNull(t.eventKey),
        or(sql`${t.attempts} IS NULL`, lt(t.attempts, maxAttempts)),
      ),
    )
    .orderBy(asc(t.priority), asc(t.receivedAt))
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
