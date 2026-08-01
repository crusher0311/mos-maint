/**
 * Postgres-backed Tekmetric operational-store repository — the read &
 * write surface used by `lib/data/repositories/tekmetric-ops.ts` when
 * `TEKMETRIC_OPS_PG_CANONICAL=1` (task #999).
 *
 * Backs the Tekmetric operational tables in lib/db/schema/wave2.ts
 * (backfill progress/health/perm-failed/skips/catchups/mileage/webhook
 * logs/subscriptions/health), lib/db/schema/wave3.ts (tokens, api-usage),
 * and lib/db/schema/integration-ops.ts (the shared per-provider drain
 * lock, provider='tekmetric').
 *
 * Each write maps the Mongo-shaped document onto the typed columns and
 * stashes any field without a dedicated column in the `extra`/`payload`
 * catch-all jsonb, so no field is lost across the cutover. Reads spread
 * that jsonb back so callers see the same Mongo-shaped doc.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag. See
 * docs/runbooks/mongo-cutover-sequence.md.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import {
  tekmetricBackfillProgress,
  tekmetricBackfillHealthAlerts,
  tekmetricPermfailedRoAlerts,
  tekmetricSkippedRoArchive,
  tekmetricCatchupRuns,
  tekmetricMileageBackfillProgress,
  tekmetricWebhookLogs,
  tekmetricWebhookSubscriptions,
  tekmetricWebhookHealthAlerts,
} from "@/lib/db/schema/wave2";
import { tekmetricTokens } from "@/lib/db/schema/wave3";
import { integrationDrainLocks } from "@/lib/db/schema/integration-ops";

type AnyDoc = Record<string, unknown>;

const DRAIN_PROVIDER = "tekmetric";

/* -------------------------------------------------------------------------- */
/* Backfill progress                                                           */
/* -------------------------------------------------------------------------- */

// Fields that have dedicated typed columns on tekmetric_backfill_progress.
// Anything else in a `$set` patch round-trips through `extra`.
const PROGRESS_COLUMN_KEYS = new Set([
  "shopId",
  "startedAt",
  "currentChunkEnd",
  "completed",
  "completedAt",
  "complete",
  "logicVersion",
  "lastRunAt",
  "lastError",
  "lastErrorAt",
  "recentSkippedRos",
  "lastStaleSkippedRosArchivedAt",
  "staleSkippedRosArchivedTotal",
]);

/** Re-assemble a Mongo-shaped progress doc from a PG row. */
function progressRowToDoc(row: AnyDoc | undefined): AnyDoc | null {
  if (!row) return null;
  const { extra, updatedAt, ...cols } = row as AnyDoc & { extra?: AnyDoc };
  const doc: AnyDoc = { ...(extra || {}) };
  for (const [k, v] of Object.entries(cols)) {
    if (v !== null && v !== undefined) doc[k] = v;
    else if (k in (cols as AnyDoc)) doc[k] = v;
  }
  return doc;
}

export async function getProgress(shopId: number): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricBackfillProgress)
    .where(eq(tekmetricBackfillProgress.shopId, shopId))
    .limit(1);
  return progressRowToDoc(rows[0] as AnyDoc | undefined);
}

export async function listProgress(shopIds?: number[]): Promise<AnyDoc[]> {
  const db = getDb();
  const q = db.select().from(tekmetricBackfillProgress);
  const rows = shopIds
    ? await q.where(inArray(tekmetricBackfillProgress.shopId, shopIds))
    : await q;
  return (rows as AnyDoc[]).map((r) => progressRowToDoc(r)!);
}

export interface UpdateProgressOpts {
  upsert?: boolean;
  incFields?: Record<string, number>;
  /** Fields applied only on insert (Mongo `$setOnInsert`). */
  setOnInsert?: AnyDoc;
  /** Append entries to recentSkippedRos, keeping only the last `slice`. */
  pushRecentSkippedRo?: { entries: AnyDoc[]; slice?: number };
}

/**
 * Apply a Mongo `$set`-style patch (plus optional `$inc` / `$push`) to the
 * per-shop progress row. Known keys land on typed columns; everything else
 * is merged into `extra`. Preserves upsert semantics.
 */
export async function updateProgressFields(
  shopId: number,
  set: AnyDoc,
  opts: UpdateProgressOpts = {},
): Promise<void> {
  const db = getDb();
  const existing = await db
    .select()
    .from(tekmetricBackfillProgress)
    .where(eq(tekmetricBackfillProgress.shopId, shopId))
    .limit(1);
  const row = existing[0] as AnyDoc | undefined;

  if (!row && !opts.upsert) return;

  const prevExtra: AnyDoc = (row?.extra as AnyDoc) || {};
  const cols: AnyDoc = {};
  const nextExtra: AnyDoc = { ...prevExtra };

  // $setOnInsert fields land in the initial INSERT values only (not the
  // conflict UPDATE), mirroring Mongo semantics.
  const insertOnlyCols: AnyDoc = {};
  const insertOnlyExtra: AnyDoc = {};
  if (!row && opts.setOnInsert) {
    for (const [k, v] of Object.entries(opts.setOnInsert)) {
      if (PROGRESS_COLUMN_KEYS.has(k)) insertOnlyCols[k] = v;
      else insertOnlyExtra[k] = v;
    }
  }

  for (const [k, v] of Object.entries(set)) {
    if (PROGRESS_COLUMN_KEYS.has(k)) cols[k] = v;
    else nextExtra[k] = v;
  }

  // $inc — columns if known, else extra.
  if (opts.incFields) {
    for (const [k, delta] of Object.entries(opts.incFields)) {
      if (PROGRESS_COLUMN_KEYS.has(k)) {
        const cur = Number((row as AnyDoc)?.[k] ?? 0);
        cols[k] = cur + delta;
      } else {
        const cur = Number(nextExtra[k] ?? 0);
        nextExtra[k] = cur + delta;
      }
    }
  }

  // $push recentSkippedRos with $slice cap.
  if (opts.pushRecentSkippedRo) {
    const { entries, slice } = opts.pushRecentSkippedRo;
    const current = Array.isArray((row as AnyDoc)?.recentSkippedRos)
      ? ((row as AnyDoc).recentSkippedRos as AnyDoc[])
      : Array.isArray(cols.recentSkippedRos)
        ? (cols.recentSkippedRos as AnyDoc[])
        : [];
    let merged = [...current, ...entries];
    if (typeof slice === "number") {
      merged = slice >= 0 ? merged.slice(0, slice) : merged.slice(slice);
    }
    cols.recentSkippedRos = merged;
  }

  const values = {
    shopId,
    ...insertOnlyCols,
    ...cols,
    extra: { ...insertOnlyExtra, ...nextExtra },
    updatedAt: new Date(),
  } as typeof tekmetricBackfillProgress.$inferInsert;

  await db
    .insert(tekmetricBackfillProgress)
    .values(values)
    .onConflictDoUpdate({
      target: tekmetricBackfillProgress.shopId,
      set: {
        ...cols,
        extra: nextExtra,
        updatedAt: new Date(),
      } as Partial<typeof tekmetricBackfillProgress.$inferInsert>,
    });
}

/**
 * Apply a `$set` patch to every progress row matching a predicate. Only the
 * predicates the runtime uses are supported; unsupported filters throw so a
 * silent divergence can't slip through.
 */
export async function updateManyProgress(
  filter: { shopIds?: number[]; notCompleted?: boolean },
  set: AnyDoc,
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricBackfillProgress);
  const targets = (rows as AnyDoc[]).filter((r) => {
    if (filter.shopIds && !filter.shopIds.includes(Number(r.shopId)))
      return false;
    if (filter.notCompleted && r.completed === true) return false;
    return true;
  });
  for (const r of targets) {
    await updateProgressFields(Number(r.shopId), set);
  }
}

/* -------------------------------------------------------------------------- */
/* Mileage backfill progress                                                   */
/* -------------------------------------------------------------------------- */

const MILEAGE_COLUMN_KEYS = new Set([
  "shopId",
  "cursorRoId",
  "completed",
  "completedAt",
  "lastRunAt",
  "rosUpdated",
]);

function mileageRowToDoc(row: AnyDoc | undefined): AnyDoc | null {
  if (!row) return null;
  const { extra, updatedAt, ...cols } = row as AnyDoc & { extra?: AnyDoc };
  return { ...(extra || {}), ...cols };
}

export async function getMileageProgress(
  shopId: number,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricMileageBackfillProgress)
    .where(eq(tekmetricMileageBackfillProgress.shopId, shopId))
    .limit(1);
  return mileageRowToDoc(rows[0] as AnyDoc | undefined);
}

export async function updateMileageProgressFields(
  shopId: number,
  set: AnyDoc,
  opts: { upsert?: boolean; incFields?: Record<string, number> } = {},
): Promise<void> {
  const db = getDb();
  const existing = await db
    .select()
    .from(tekmetricMileageBackfillProgress)
    .where(eq(tekmetricMileageBackfillProgress.shopId, shopId))
    .limit(1);
  const row = existing[0] as AnyDoc | undefined;
  if (!row && !opts.upsert) return;

  const prevExtra: AnyDoc = (row?.extra as AnyDoc) || {};
  const cols: AnyDoc = {};
  const nextExtra: AnyDoc = { ...prevExtra };
  for (const [k, v] of Object.entries(set)) {
    if (MILEAGE_COLUMN_KEYS.has(k)) cols[k] = v;
    else nextExtra[k] = v;
  }
  if (opts.incFields) {
    for (const [k, delta] of Object.entries(opts.incFields)) {
      if (MILEAGE_COLUMN_KEYS.has(k)) {
        cols[k] = Number((row as AnyDoc)?.[k] ?? 0) + delta;
      } else {
        nextExtra[k] = Number(nextExtra[k] ?? 0) + delta;
      }
    }
  }
  await db
    .insert(tekmetricMileageBackfillProgress)
    .values({
      shopId,
      ...cols,
      extra: nextExtra,
      updatedAt: new Date(),
    } as typeof tekmetricMileageBackfillProgress.$inferInsert)
    .onConflictDoUpdate({
      target: tekmetricMileageBackfillProgress.shopId,
      set: {
        ...cols,
        extra: nextExtra,
        updatedAt: new Date(),
      } as Partial<typeof tekmetricMileageBackfillProgress.$inferInsert>,
    });
}

/* -------------------------------------------------------------------------- */
/* Backfill health alerts (state-based dedup, one row per shop)                */
/* -------------------------------------------------------------------------- */

function healthAlertRowToDoc(row: AnyDoc | undefined): AnyDoc | null {
  if (!row) return null;
  const { payload, ...cols } = row as AnyDoc & { payload?: AnyDoc };
  return { ...(payload || {}), ...cols };
}

export async function listBackfillHealthAlerts(): Promise<AnyDoc[]> {
  const db = getDb();
  const rows = await db.select().from(tekmetricBackfillHealthAlerts);
  return (rows as AnyDoc[]).map((r) => healthAlertRowToDoc(r)!);
}

export async function upsertBackfillHealthAlert(
  shopId: number,
  set: AnyDoc,
  setOnInsert: AnyDoc = {},
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const existing = await db
    .select()
    .from(tekmetricBackfillHealthAlerts)
    .where(eq(tekmetricBackfillHealthAlerts.shopId, shopId))
    .limit(1);
  const prevPayload: AnyDoc =
    ((existing[0] as AnyDoc)?.payload as AnyDoc) || {};
  const merged = existing[0]
    ? { ...prevPayload, ...set }
    : { ...setOnInsert, ...set };
  await db
    .insert(tekmetricBackfillHealthAlerts)
    .values({
      shopId,
      firstAlertedAt: now,
      lastAlertedAt: now,
      payload: merged,
    } as typeof tekmetricBackfillHealthAlerts.$inferInsert)
    .onConflictDoUpdate({
      target: tekmetricBackfillHealthAlerts.shopId,
      set: {
        lastAlertedAt: now,
        payload: merged,
      } as Partial<typeof tekmetricBackfillHealthAlerts.$inferInsert>,
    });
}

export async function deleteBackfillHealthAlerts(
  shopIds: number[],
): Promise<void> {
  if (shopIds.length === 0) return;
  const db = getDb();
  await db
    .delete(tekmetricBackfillHealthAlerts)
    .where(inArray(tekmetricBackfillHealthAlerts.shopId, shopIds));
}

/* -------------------------------------------------------------------------- */
/* Perm-failed RO alerts                                                       */
/* -------------------------------------------------------------------------- */

function permfailedRowToDoc(row: AnyDoc | undefined): AnyDoc | null {
  if (!row) return null;
  const { payload, ...cols } = row as AnyDoc & { payload?: AnyDoc };
  return { ...(payload || {}), ...cols };
}

export async function getPermfailedAlert(
  shopId: number,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricPermfailedRoAlerts)
    .where(eq(tekmetricPermfailedRoAlerts.shopId, shopId))
    .limit(1);
  return permfailedRowToDoc(rows[0] as AnyDoc | undefined);
}

export async function upsertPermfailedAlert(
  shopId: number,
  set: AnyDoc,
  setOnInsert: AnyDoc = {},
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const existing = await db
    .select()
    .from(tekmetricPermfailedRoAlerts)
    .where(eq(tekmetricPermfailedRoAlerts.shopId, shopId))
    .limit(1);
  const prevPayload: AnyDoc =
    ((existing[0] as AnyDoc)?.payload as AnyDoc) || {};
  const merged = existing[0]
    ? { ...prevPayload, ...set }
    : { ...setOnInsert, ...set };
  await db
    .insert(tekmetricPermfailedRoAlerts)
    .values({
      shopId,
      firstAlertedAt: now,
      lastAlertedAt: now,
      payload: merged,
    } as typeof tekmetricPermfailedRoAlerts.$inferInsert)
    .onConflictDoUpdate({
      target: tekmetricPermfailedRoAlerts.shopId,
      set: {
        lastAlertedAt: now,
        payload: merged,
      } as Partial<typeof tekmetricPermfailedRoAlerts.$inferInsert>,
    });
}

/* -------------------------------------------------------------------------- */
/* Skipped-RO archive (append-only)                                            */
/* -------------------------------------------------------------------------- */

export async function insertSkippedRoArchive(docs: AnyDoc[]): Promise<void> {
  if (docs.length === 0) return;
  const db = getDb();
  const rows = docs.map((d) => {
    const { shopId, roId, skippedAt, stale, permanentlyFailed, reason, ...rest } =
      d as AnyDoc;
    return {
      shopId: Number(shopId),
      roId: String(roId),
      skippedAt: (skippedAt as Date) ?? null,
      stale: stale === true,
      permanentlyFailed: permanentlyFailed === true,
      reason: (reason as string) ?? null,
      payload: rest,
    } as typeof tekmetricSkippedRoArchive.$inferInsert;
  });
  await db.insert(tekmetricSkippedRoArchive).values(rows);
}

export async function listSkippedRoArchive(
  shopId: number,
  limit: number,
): Promise<AnyDoc[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricSkippedRoArchive)
    .where(eq(tekmetricSkippedRoArchive.shopId, shopId))
    .orderBy(sql`${tekmetricSkippedRoArchive.archivedAt} DESC`)
    .limit(limit);
  return (rows as AnyDoc[]).map((r) => {
    const { payload, ...cols } = r as AnyDoc & { payload?: AnyDoc };
    return { ...(payload || {}), ...cols };
  });
}

/* -------------------------------------------------------------------------- */
/* Catchup runs (append-only)                                                  */
/* -------------------------------------------------------------------------- */

export async function insertCatchupRun(doc: AnyDoc): Promise<void> {
  const db = getDb();
  const { startedAt, finishedAt, shopsProcessed, rosProcessed, success, ...rest } =
    doc as AnyDoc;
  await db.insert(tekmetricCatchupRuns).values({
    startedAt: (startedAt as Date) ?? new Date(),
    finishedAt: (finishedAt as Date) ?? null,
    shopsProcessed:
      shopsProcessed != null ? Number(shopsProcessed) : null,
    rosProcessed: rosProcessed != null ? Number(rosProcessed) : null,
    success: typeof success === "boolean" ? success : null,
    summary: rest,
  } as typeof tekmetricCatchupRuns.$inferInsert);
}

export async function listCatchupRuns(limit: number): Promise<AnyDoc[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricCatchupRuns)
    .orderBy(sql`${tekmetricCatchupRuns.startedAt} DESC`)
    .limit(limit);
  return (rows as AnyDoc[]).map((r) => {
    const { summary, ...cols } = r as AnyDoc & { summary?: AnyDoc };
    return { ...(summary || {}), ...cols };
  });
}

/* -------------------------------------------------------------------------- */
/* Webhook logs (append-only)                                                  */
/* -------------------------------------------------------------------------- */

export async function insertWebhookLog(doc: AnyDoc): Promise<void> {
  const db = getDb();
  const {
    eventType,
    tekmetricShopId,
    mosShopId,
    receivedAt,
    processed,
    ...rest
  } = doc as AnyDoc;
  await db.insert(tekmetricWebhookLogs).values({
    eventType: (eventType as string) ?? null,
    tekmetricShopId:
      tekmetricShopId != null ? Number(tekmetricShopId) : null,
    mosShopId: mosShopId != null ? Number(mosShopId) : null,
    receivedAt: (receivedAt as Date) ?? new Date(),
    processed: processed === true,
    payload: rest,
  } as typeof tekmetricWebhookLogs.$inferInsert);
}

/* -------------------------------------------------------------------------- */
/* Webhook subscriptions                                                       */
/* -------------------------------------------------------------------------- */

function subRowToDoc(row: AnyDoc | undefined): AnyDoc | null {
  if (!row) return null;
  const { lastResult, ...cols } = row as AnyDoc;
  const doc: AnyDoc = { ...cols };
  if (lastResult !== null && lastResult !== undefined)
    doc.lastResult = lastResult;
  return doc;
}

export async function listWebhookSubscriptions(
  tekmetricShopIds?: number[],
): Promise<AnyDoc[]> {
  const db = getDb();
  const q = db.select().from(tekmetricWebhookSubscriptions);
  const rows = tekmetricShopIds
    ? await q.where(
        inArray(
          tekmetricWebhookSubscriptions.tekmetricShopId,
          tekmetricShopIds,
        ),
      )
    : await q;
  return (rows as AnyDoc[]).map((r) => subRowToDoc(r)!);
}

export async function getWebhookSubscription(
  tekmetricShopId: number,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricWebhookSubscriptions)
    .where(eq(tekmetricWebhookSubscriptions.tekmetricShopId, tekmetricShopId))
    .limit(1);
  return subRowToDoc(rows[0] as AnyDoc | undefined);
}

export async function upsertWebhookSubscription(
  tekmetricShopId: number,
  set: AnyDoc,
  setOnInsert: AnyDoc = {},
): Promise<void> {
  const db = getDb();
  const existing = await db
    .select()
    .from(tekmetricWebhookSubscriptions)
    .where(eq(tekmetricWebhookSubscriptions.tekmetricShopId, tekmetricShopId))
    .limit(1);

  const mapCols = (src: AnyDoc): AnyDoc => {
    const cols: AnyDoc = {};
    if (src.mosShopId !== undefined)
      cols.mosShopId = src.mosShopId != null ? Number(src.mosShopId) : null;
    if (src.events !== undefined) cols.events = src.events;
    if (src.publicUrl !== undefined) cols.publicUrl = src.publicUrl;
    if (src.firstAttemptAt !== undefined)
      cols.firstAttemptAt = src.firstAttemptAt;
    if (src.lastAttemptAt !== undefined)
      cols.lastAttemptAt = src.lastAttemptAt;
    if (src.lastResult !== undefined) cols.lastResult = src.lastResult;
    return cols;
  };

  if (!existing[0]) {
    await db.insert(tekmetricWebhookSubscriptions).values({
      tekmetricShopId,
      ...mapCols(setOnInsert),
      ...mapCols(set),
    } as typeof tekmetricWebhookSubscriptions.$inferInsert);
    return;
  }
  await db
    .update(tekmetricWebhookSubscriptions)
    .set(
      mapCols(set) as Partial<
        typeof tekmetricWebhookSubscriptions.$inferInsert
      >,
    )
    .where(
      eq(tekmetricWebhookSubscriptions.tekmetricShopId, tekmetricShopId),
    );
}

/* -------------------------------------------------------------------------- */
/* Webhook health alerts (idempotent per (synthetic shop, date))               */
/* -------------------------------------------------------------------------- */

/**
 * Insert a (tekmetricShopId, alertDate) idempotency row. Returns true if the
 * row was newly inserted, false if it already existed (mirrors the Mongo
 * duplicate-key-means-already-alerted semantics). Extra fields land in
 * `payload`.
 */
export async function insertWebhookHealthAlert(
  tekmetricShopId: number,
  alertDate: string,
  extra: AnyDoc = {},
): Promise<boolean> {
  const db = getDb();
  const inserted = await db
    .insert(tekmetricWebhookHealthAlerts)
    .values({
      tekmetricShopId,
      alertDate,
      payload: extra,
    } as typeof tekmetricWebhookHealthAlerts.$inferInsert)
    .onConflictDoNothing({
      target: [
        tekmetricWebhookHealthAlerts.tekmetricShopId,
        tekmetricWebhookHealthAlerts.alertDate,
      ],
    })
    .returning({ tekmetricShopId: tekmetricWebhookHealthAlerts.tekmetricShopId });
  return inserted.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Tokens (single logical "current" token; keyed on synthetic shopId 0)        */
/* -------------------------------------------------------------------------- */

// The Mongo `tekmetric_tokens` collection keys on `tokenKey:"current"` (one
// global client-credentials token). The PG table keys on shopId; we use
// shopId 0 as the canonical "current" row and stash tokenKey/createdAt in raw.
const TOKEN_CURRENT_SHOP_ID = 0;

export async function getCurrentToken(): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tekmetricTokens)
    .where(eq(tekmetricTokens.shopId, TOKEN_CURRENT_SHOP_ID))
    .limit(1);
  const row = rows[0] as AnyDoc | undefined;
  if (!row) return null;
  const raw: AnyDoc = (row.raw as AnyDoc) || {};
  return {
    tokenKey: "current",
    accessToken: row.accessToken,
    tokenType: row.tokenType,
    scope: row.scope,
    expiresAt: row.expiresAt,
    createdAt: raw.createdAt ?? row.updatedAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertCurrentToken(doc: {
  accessToken: string;
  tokenType?: string | null;
  scope?: string | null;
  expiresAt?: Date | null;
  createdAt?: Date | null;
}): Promise<void> {
  const db = getDb();
  const now = new Date();
  const set = {
    accessToken: doc.accessToken,
    tokenType: doc.tokenType ?? null,
    scope: doc.scope ?? null,
    expiresAt: doc.expiresAt ?? null,
    raw: { tokenKey: "current", createdAt: doc.createdAt ?? now },
    updatedAt: now,
  };
  await db
    .insert(tekmetricTokens)
    .values({
      shopId: TOKEN_CURRENT_SHOP_ID,
      ...set,
    } as typeof tekmetricTokens.$inferInsert)
    .onConflictDoUpdate({
      target: tekmetricTokens.shopId,
      set: set as Partial<typeof tekmetricTokens.$inferInsert>,
    });
}

export async function deleteCurrentToken(): Promise<void> {
  const db = getDb();
  await db
    .delete(tekmetricTokens)
    .where(eq(tekmetricTokens.shopId, TOKEN_CURRENT_SHOP_ID));
}

/* -------------------------------------------------------------------------- */
/* Drain lock (one lease row, provider='tekmetric')                            */
/* -------------------------------------------------------------------------- */

/**
 * Acquire the drain lease. Returns true when acquired (fresh, expired
 * takeover, or same-owner re-acquire), false when another live owner holds
 * it (mirrors Mongo's E11000-means-held path).
 */
export async function acquireDrainLock(
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  // Insert if no row; else take over iff expired OR same owner. The WHERE on
  // the DO UPDATE guards the takeover; onConflictDoNothing would drop the
  // same-owner refresh, so we express the guard in the SET clause's WHERE.
  const rows = await db
    .insert(integrationDrainLocks)
    .values({
      provider: DRAIN_PROVIDER,
      owner,
      acquiredAt: now,
      expiresAt,
      lastRefreshAt: now,
    } as typeof integrationDrainLocks.$inferInsert)
    .onConflictDoUpdate({
      target: integrationDrainLocks.provider,
      set: {
        owner,
        acquiredAt: now,
        expiresAt,
        lastRefreshAt: now,
      } as Partial<typeof integrationDrainLocks.$inferInsert>,
      setWhere: sql`${integrationDrainLocks.expiresAt} <= ${now} OR ${integrationDrainLocks.owner} = ${owner}`,
    })
    .returning({ owner: integrationDrainLocks.owner });
  return rows.length > 0;
}

export async function refreshDrainLock(
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const rows = await db
    .update(integrationDrainLocks)
    .set({ expiresAt, lastRefreshAt: now })
    .where(
      and(
        eq(integrationDrainLocks.provider, DRAIN_PROVIDER),
        eq(integrationDrainLocks.owner, owner),
      ),
    )
    .returning({ owner: integrationDrainLocks.owner });
  return rows.length > 0;
}

export async function releaseDrainLock(owner: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .delete(integrationDrainLocks)
    .where(
      and(
        eq(integrationDrainLocks.provider, DRAIN_PROVIDER),
        eq(integrationDrainLocks.owner, owner),
      ),
    )
    .returning({ owner: integrationDrainLocks.owner });
  return rows.length;
}

export async function getDrainLock(): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(integrationDrainLocks)
    .where(eq(integrationDrainLocks.provider, DRAIN_PROVIDER))
    .limit(1);
  const row = rows[0] as AnyDoc | undefined;
  if (!row) return null;
  return { _id: "global", ...row };
}
