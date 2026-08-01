/**
 * Repository for Tekmetric OPERATIONAL stores (task #999).
 *
 * Covers the Mongo-only operational collections the Tekmetric backfill /
 * webhook / health machinery keeps:
 *
 *   tekmetric_backfill_progress          → tekmetricBackfillProgress (wave2)
 *   tekmetric_backfill_health_alerts     → tekmetricBackfillHealthAlerts
 *   tekmetric_permfailed_ro_alerts       → tekmetricPermfailedRoAlerts
 *   tekmetric_skipped_ro_archive         → tekmetricSkippedRoArchive
 *   tekmetric_catchup_runs               → tekmetricCatchupRuns
 *   tekmetric_mileage_backfill_progress  → tekmetricMileageBackfillProgress
 *   tekmetric_webhook_logs               → tekmetricWebhookLogs
 *   tekmetric_webhook_subscriptions      → tekmetricWebhookSubscriptions
 *   tekmetric_webhook_health_alerts      → tekmetricWebhookHealthAlerts
 *   tekmetric_tokens                     → tekmetricTokens (shop_id=0 sentinel)
 *   tekmetric_drain_lock                 → integrationDrainLocks provider='tekmetric'
 *
 * (`tekmetric_api_usage` is intentionally NOT covered — that collection is
 * empty fleet-wide; the live per-request store is the cross-provider
 * `api_usage` collection, owned by lib/data/repositories/api-usage.ts.)
 *
 * Dispatch: when `isTekmetricOpsPgCanonical()` is true, reads go to Postgres
 * and writes go to Postgres THEN shadow-write Mongo via
 * `shadowWriteMongoIntegrationOps(shouldShadowWriteMongoTekmetricOps, …)`.
 * When the flag is OFF (default) every function is byte-identical to the
 * historical Mongo behavior. See docs/runbooks/mongo-cutover-sequence.md.
 */
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isTekmetricOpsPgCanonical,
  shouldShadowWriteMongoTekmetricOps,
  shadowWriteMongoIntegrationOps,
} from "@/lib/db/integration-ops-write-mode";
import * as pg from "./pg/tekmetric-ops";

const PROGRESS = "tekmetric_backfill_progress";
const HEALTH_ALERTS = "tekmetric_backfill_health_alerts";
const PERMFAILED_ALERTS = "tekmetric_permfailed_ro_alerts";
const SKIPPED_ARCHIVE = "tekmetric_skipped_ro_archive";
const CATCHUP_RUNS = "tekmetric_catchup_runs";
const MILEAGE_PROGRESS = "tekmetric_mileage_backfill_progress";
const WEBHOOK_LOGS = "tekmetric_webhook_logs";
const WEBHOOK_SUBS = "tekmetric_webhook_subscriptions";
const WEBHOOK_HEALTH_ALERTS = "tekmetric_webhook_health_alerts";
const TOKENS = "tekmetric_tokens";
const DRAIN_LOCK = "tekmetric_drain_lock";

type AnyDoc = Record<string, unknown>;

async function col(name: string): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(name);
}

function shadow(label: string, fn: () => Promise<unknown>): Promise<void> {
  return shadowWriteMongoIntegrationOps(
    shouldShadowWriteMongoTekmetricOps,
    label,
    fn,
  );
}

/* ========================================================================== */
/* Backfill progress                                                           */
/* ========================================================================== */

export interface UpdateProgressOpts {
  upsert?: boolean;
  incFields?: Record<string, number>;
  /** Fields applied only on insert (Mongo `$setOnInsert`). */
  setOnInsert?: AnyDoc;
  /**
   * Append to `recentSkippedRos` with a `$slice` cap. `slice` follows Mongo
   * `$slice` semantics: positive keeps the first N, negative keeps the last
   * |N| entries.
   */
  pushRecentSkippedRo?: { entries: AnyDoc[]; slice?: number };
  /** Fields removed from the doc (Mongo `$unset`). */
  unsetFields?: string[];
}

export async function getProgress(shopId: number): Promise<AnyDoc | null> {
  if (isTekmetricOpsPgCanonical()) return pg.getProgress(shopId);
  return getProgressMongo(shopId);
}

async function getProgressMongo(shopId: number): Promise<AnyDoc | null> {
  const c = await col(PROGRESS);
  return (await c.findOne({ shopId })) as AnyDoc | null;
}

export async function listProgress(shopIds?: number[]): Promise<AnyDoc[]> {
  if (isTekmetricOpsPgCanonical()) return pg.listProgress(shopIds);
  return listProgressMongo(shopIds);
}

async function listProgressMongo(shopIds?: number[]): Promise<AnyDoc[]> {
  const c = await col(PROGRESS);
  const filter = shopIds ? { shopId: { $in: shopIds } } : {};
  return (await c.find(filter).toArray()) as AnyDoc[];
}

export async function updateProgressFields(
  shopId: number,
  set: AnyDoc,
  opts: UpdateProgressOpts = {},
): Promise<void> {
  if (isTekmetricOpsPgCanonical()) {
    await pg.updateProgressFields(shopId, set, opts);
    await shadow("tekmetric.backfill_progress.update", () =>
      updateProgressFieldsMongo(shopId, set, opts),
    );
    return;
  }
  await updateProgressFieldsMongo(shopId, set, opts);
}

async function updateProgressFieldsMongo(
  shopId: number,
  set: AnyDoc,
  opts: UpdateProgressOpts,
): Promise<void> {
  const c = await col(PROGRESS);
  const update: AnyDoc = {};
  if (Object.keys(set).length > 0) update.$set = set;
  if (opts.setOnInsert && Object.keys(opts.setOnInsert).length > 0)
    update.$setOnInsert = opts.setOnInsert;
  if (opts.incFields && Object.keys(opts.incFields).length > 0)
    update.$inc = opts.incFields;
  if (opts.pushRecentSkippedRo) {
    const { entries, slice } = opts.pushRecentSkippedRo;
    update.$push = {
      recentSkippedRos:
        slice === undefined
          ? { $each: entries }
          : { $each: entries, $slice: slice },
    };
  }
  if (opts.unsetFields && opts.unsetFields.length > 0) {
    update.$unset = Object.fromEntries(opts.unsetFields.map((k) => [k, ""]));
  }
  await c.updateOne({ shopId }, update, { upsert: !!opts.upsert });
}

/**
 * Read progress rows matching a small predicate. Filters mirror the
 * historical direct-Mongo queries used by the backfill cron and drain
 * worker:
 *   notCompleted        → { completed: { $ne: true } }
 *   hasRecentSkippedRos → { "recentSkippedRos.0": { $exists: true } }
 *   drainPoisoned       → { drainPoisoned: true }
 */
export interface ProgressQueryFilter {
  shopIds?: number[];
  notCompleted?: boolean;
  hasRecentSkippedRos?: boolean;
  drainPoisoned?: boolean;
}

export async function queryProgress(
  filter: ProgressQueryFilter,
): Promise<AnyDoc[]> {
  if (isTekmetricOpsPgCanonical()) return pg.queryProgress(filter);
  return queryProgressMongo(filter);
}

async function queryProgressMongo(
  filter: ProgressQueryFilter,
): Promise<AnyDoc[]> {
  const c = await col(PROGRESS);
  const q: AnyDoc = {};
  if (filter.shopIds) q.shopId = { $in: filter.shopIds };
  if (filter.notCompleted) q.completed = { $ne: true };
  if (filter.hasRecentSkippedRos) q["recentSkippedRos.0"] = { $exists: true };
  if (filter.drainPoisoned) q.drainPoisoned = true;
  return (await c.find(q).toArray()) as AnyDoc[];
}

/**
 * Auto-clear sweep for stale `lastError`s: clears `lastError`/`lastErrorAt`
 * and stamps `autoClearedErrorAt` on every row whose error is older than
 * `cutoff` and whose `consecutiveChunkErrors` is missing or below
 * `maxConsecutiveErrors`. Byte-identical to the cron's historical
 * updateMany when the flag is OFF.
 */
export async function autoClearProgressErrors(
  cutoff: Date,
  maxConsecutiveErrors: number,
): Promise<void> {
  if (isTekmetricOpsPgCanonical()) {
    await pg.autoClearProgressErrors(cutoff, maxConsecutiveErrors);
    await shadow("tekmetric.backfill_progress.autoClearErrors", () =>
      autoClearProgressErrorsMongo(cutoff, maxConsecutiveErrors),
    );
    return;
  }
  await autoClearProgressErrorsMongo(cutoff, maxConsecutiveErrors);
}

async function autoClearProgressErrorsMongo(
  cutoff: Date,
  maxConsecutiveErrors: number,
): Promise<void> {
  const c = await col(PROGRESS);
  await c.updateMany(
    {
      lastError: { $ne: null },
      lastErrorAt: { $lt: cutoff },
      $or: [
        { consecutiveChunkErrors: { $lt: maxConsecutiveErrors } },
        { consecutiveChunkErrors: { $exists: false } },
      ],
    },
    { $set: { lastError: null, lastErrorAt: null, autoClearedErrorAt: new Date() } },
  );
}

/**
 * Atomic read-modify-return on the per-shop progress row, mirroring Mongo
 * `findOneAndUpdate({shopId}, {…}, { upsert: true, returnDocument: "after" })`.
 * Returns the post-update doc (never the Mongo `{ value }` wrapper).
 */
export async function findOneAndUpdateProgress(
  shopId: number,
  patch: {
    set?: AnyDoc;
    incFields?: Record<string, number>;
    setOnInsert?: AnyDoc;
  },
): Promise<AnyDoc | null> {
  if (isTekmetricOpsPgCanonical()) {
    const doc = await pg.findOneAndUpdateProgress(shopId, patch);
    await shadow("tekmetric.backfill_progress.findOneAndUpdate", async () => {
      await findOneAndUpdateProgressMongo(shopId, patch);
    });
    return doc;
  }
  return findOneAndUpdateProgressMongo(shopId, patch);
}

async function findOneAndUpdateProgressMongo(
  shopId: number,
  patch: {
    set?: AnyDoc;
    incFields?: Record<string, number>;
    setOnInsert?: AnyDoc;
  },
): Promise<AnyDoc | null> {
  const c = await col(PROGRESS);
  const update: AnyDoc = {};
  if (patch.set && Object.keys(patch.set).length > 0) update.$set = patch.set;
  if (patch.incFields && Object.keys(patch.incFields).length > 0)
    update.$inc = patch.incFields;
  if (patch.setOnInsert && Object.keys(patch.setOnInsert).length > 0)
    update.$setOnInsert = patch.setOnInsert;
  const res: any = await c.findOneAndUpdate({ shopId }, update, {
    upsert: true,
    returnDocument: "after",
  });
  // Driver-version tolerance: v4/5 returns { value }, v6 returns the doc.
  return (res && typeof res === "object" && "value" in res ? res.value : res) as
    | AnyDoc
    | null;
}

/**
 * Apply a `$set` to every progress row matching a small predicate.
 * `notCompleted` maps to `completed: { $ne: true }`.
 */
export async function updateManyProgress(
  filter: { shopIds?: number[]; notCompleted?: boolean },
  set: AnyDoc,
): Promise<void> {
  if (isTekmetricOpsPgCanonical()) {
    await pg.updateManyProgress(filter, set);
    await shadow("tekmetric.backfill_progress.updateMany", () =>
      updateManyProgressMongo(filter, set),
    );
    return;
  }
  await updateManyProgressMongo(filter, set);
}

async function updateManyProgressMongo(
  filter: { shopIds?: number[]; notCompleted?: boolean },
  set: AnyDoc,
): Promise<void> {
  const c = await col(PROGRESS);
  const q: AnyDoc = {};
  if (filter.shopIds) q.shopId = { $in: filter.shopIds };
  if (filter.notCompleted) q.completed = { $ne: true };
  await c.updateMany(q, { $set: set });
}

/* ========================================================================== */
/* Mileage backfill progress                                                   */
/* ========================================================================== */

export async function getMileageProgress(
  shopId: number,
): Promise<AnyDoc | null> {
  if (isTekmetricOpsPgCanonical()) return pg.getMileageProgress(shopId);
  const c = await col(MILEAGE_PROGRESS);
  return (await c.findOne({ shopId })) as AnyDoc | null;
}

export async function updateMileageProgressFields(
  shopId: number,
  set: AnyDoc,
  opts: { upsert?: boolean; incFields?: Record<string, number> } = {},
): Promise<void> {
  if (isTekmetricOpsPgCanonical()) {
    await pg.updateMileageProgressFields(shopId, set, opts);
    await shadow("tekmetric.mileage_progress.update", () =>
      updateMileageProgressFieldsMongo(shopId, set, opts),
    );
    return;
  }
  await updateMileageProgressFieldsMongo(shopId, set, opts);
}

async function updateMileageProgressFieldsMongo(
  shopId: number,
  set: AnyDoc,
  opts: { upsert?: boolean; incFields?: Record<string, number> },
): Promise<void> {
  const c = await col(MILEAGE_PROGRESS);
  const update: AnyDoc = {};
  if (Object.keys(set).length > 0) update.$set = set;
  if (opts.incFields && Object.keys(opts.incFields).length > 0)
    update.$inc = opts.incFields;
  await c.updateOne({ shopId }, update, { upsert: !!opts.upsert });
}

/* ========================================================================== */
/* Backfill health alerts                                                      */
/* ========================================================================== */

export async function listBackfillHealthAlerts(): Promise<AnyDoc[]> {
  if (isTekmetricOpsPgCanonical()) return pg.listBackfillHealthAlerts();
  const c = await col(HEALTH_ALERTS);
  return (await c.find({}).toArray()) as AnyDoc[];
}

export async function upsertBackfillHealthAlert(
  shopId: number,
  set: AnyDoc,
  setOnInsert: AnyDoc = {},
): Promise<void> {
  if (isTekmetricOpsPgCanonical()) {
    await pg.upsertBackfillHealthAlert(shopId, set, setOnInsert);
    await shadow("tekmetric.backfill_health_alerts.upsert", () =>
      upsertBackfillHealthAlertMongo(shopId, set, setOnInsert),
    );
    return;
  }
  await upsertBackfillHealthAlertMongo(shopId, set, setOnInsert);
}

async function upsertBackfillHealthAlertMongo(
  shopId: number,
  set: AnyDoc,
  setOnInsert: AnyDoc,
): Promise<void> {
  const c = await col(HEALTH_ALERTS);
  const update: AnyDoc = { $set: set };
  if (Object.keys(setOnInsert).length > 0) update.$setOnInsert = setOnInsert;
  await c.updateOne({ shopId }, update, { upsert: true });
}

export async function deleteBackfillHealthAlerts(
  shopIds: number[],
): Promise<void> {
  if (shopIds.length === 0) return;
  if (isTekmetricOpsPgCanonical()) {
    await pg.deleteBackfillHealthAlerts(shopIds);
    await shadow("tekmetric.backfill_health_alerts.delete", () =>
      deleteBackfillHealthAlertsMongo(shopIds),
    );
    return;
  }
  await deleteBackfillHealthAlertsMongo(shopIds);
}

async function deleteBackfillHealthAlertsMongo(
  shopIds: number[],
): Promise<void> {
  const c = await col(HEALTH_ALERTS);
  await c.deleteMany({ shopId: { $in: shopIds } });
}

/* ========================================================================== */
/* Perm-failed RO alerts                                                       */
/* ========================================================================== */

export async function getPermfailedAlert(
  shopId: number,
): Promise<AnyDoc | null> {
  if (isTekmetricOpsPgCanonical()) return pg.getPermfailedAlert(shopId);
  const c = await col(PERMFAILED_ALERTS);
  return (await c.findOne({ shopId })) as AnyDoc | null;
}

export async function upsertPermfailedAlert(
  shopId: number,
  set: AnyDoc,
  setOnInsert: AnyDoc = {},
): Promise<void> {
  if (isTekmetricOpsPgCanonical()) {
    await pg.upsertPermfailedAlert(shopId, set, setOnInsert);
    await shadow("tekmetric.permfailed_ro_alerts.upsert", () =>
      upsertPermfailedAlertMongo(shopId, set, setOnInsert),
    );
    return;
  }
  await upsertPermfailedAlertMongo(shopId, set, setOnInsert);
}

async function upsertPermfailedAlertMongo(
  shopId: number,
  set: AnyDoc,
  setOnInsert: AnyDoc,
): Promise<void> {
  const c = await col(PERMFAILED_ALERTS);
  const update: AnyDoc = { $set: set };
  if (Object.keys(setOnInsert).length > 0) update.$setOnInsert = setOnInsert;
  await c.updateOne({ shopId }, update, { upsert: true });
}

/* ========================================================================== */
/* Skipped-RO archive (append-only)                                            */
/* ========================================================================== */

export async function insertSkippedRoArchive(docs: AnyDoc[]): Promise<void> {
  if (docs.length === 0) return;
  if (isTekmetricOpsPgCanonical()) {
    await pg.insertSkippedRoArchive(docs);
    await shadow("tekmetric.skipped_ro_archive.insert", () =>
      insertSkippedRoArchiveMongo(docs),
    );
    return;
  }
  await insertSkippedRoArchiveMongo(docs);
}

async function insertSkippedRoArchiveMongo(docs: AnyDoc[]): Promise<void> {
  const c = await col(SKIPPED_ARCHIVE);
  await c.insertMany(docs as Document[], { ordered: false });
}

export async function listSkippedRoArchive(
  shopId: number,
  limit: number,
): Promise<AnyDoc[]> {
  if (isTekmetricOpsPgCanonical())
    return pg.listSkippedRoArchive(shopId, limit);
  const c = await col(SKIPPED_ARCHIVE);
  return (await c
    .find({ shopId })
    .sort({ archivedAt: -1 })
    .limit(limit)
    .toArray()) as AnyDoc[];
}

/* ========================================================================== */
/* Catchup runs (append-only)                                                  */
/* ========================================================================== */

export async function insertCatchupRun(doc: AnyDoc): Promise<void> {
  if (isTekmetricOpsPgCanonical()) {
    await pg.insertCatchupRun(doc);
    await shadow("tekmetric.catchup_runs.insert", () =>
      insertCatchupRunMongo(doc),
    );
    return;
  }
  await insertCatchupRunMongo(doc);
}

async function insertCatchupRunMongo(doc: AnyDoc): Promise<void> {
  const c = await col(CATCHUP_RUNS);
  await c.insertOne(doc as Document);
}

export async function listCatchupRuns(limit: number): Promise<AnyDoc[]> {
  if (isTekmetricOpsPgCanonical()) return pg.listCatchupRuns(limit);
  const c = await col(CATCHUP_RUNS);
  return (await c
    .find({})
    .sort({ startedAt: -1 })
    .limit(limit)
    .toArray()) as AnyDoc[];
}

/* ========================================================================== */
/* Webhook logs (append-only)                                                  */
/* ========================================================================== */

export async function insertWebhookLog(doc: AnyDoc): Promise<void> {
  if (isTekmetricOpsPgCanonical()) {
    await pg.insertWebhookLog(doc);
    await shadow("tekmetric.webhook_logs.insert", () =>
      insertWebhookLogMongo(doc),
    );
    return;
  }
  await insertWebhookLogMongo(doc);
}

async function insertWebhookLogMongo(doc: AnyDoc): Promise<void> {
  const c = await col(WEBHOOK_LOGS);
  await c.insertOne(doc as Document);
}

/* ========================================================================== */
/* Webhook subscriptions                                                       */
/* ========================================================================== */

export async function listWebhookSubscriptions(
  tekmetricShopIds?: number[],
): Promise<AnyDoc[]> {
  if (isTekmetricOpsPgCanonical())
    return pg.listWebhookSubscriptions(tekmetricShopIds);
  const c = await col(WEBHOOK_SUBS);
  const filter = tekmetricShopIds
    ? { tekmetricShopId: { $in: tekmetricShopIds } }
    : {};
  return (await c.find(filter).toArray()) as AnyDoc[];
}

export async function getWebhookSubscription(
  tekmetricShopId: number,
): Promise<AnyDoc | null> {
  if (isTekmetricOpsPgCanonical())
    return pg.getWebhookSubscription(tekmetricShopId);
  const c = await col(WEBHOOK_SUBS);
  return (await c.findOne({ tekmetricShopId })) as AnyDoc | null;
}

export async function upsertWebhookSubscription(
  tekmetricShopId: number,
  set: AnyDoc,
  setOnInsert: AnyDoc = {},
): Promise<void> {
  if (isTekmetricOpsPgCanonical()) {
    await pg.upsertWebhookSubscription(tekmetricShopId, set, setOnInsert);
    await shadow("tekmetric.webhook_subscriptions.upsert", () =>
      upsertWebhookSubscriptionMongo(tekmetricShopId, set, setOnInsert),
    );
    return;
  }
  await upsertWebhookSubscriptionMongo(tekmetricShopId, set, setOnInsert);
}

async function upsertWebhookSubscriptionMongo(
  tekmetricShopId: number,
  set: AnyDoc,
  setOnInsert: AnyDoc,
): Promise<void> {
  const c = await col(WEBHOOK_SUBS);
  const update: AnyDoc = { $set: set };
  if (Object.keys(setOnInsert).length > 0) update.$setOnInsert = setOnInsert;
  await c.updateOne({ tekmetricShopId }, update, { upsert: true });
}

/* ========================================================================== */
/* Webhook health alerts (idempotent per (synthetic shop, date))               */
/* ========================================================================== */

/**
 * Insert a (tekmetricShopId, alertDate) dedup row, mirroring the Mongo
 * insert-and-catch-E11000 idempotency. Returns true if newly inserted, false
 * if the row already existed (i.e. already alerted for that shop+day). Any
 * non-key fields are stored in `payload` on PG (verbatim on Mongo).
 */
export async function insertWebhookHealthAlert(
  doc: AnyDoc & { tekmetricShopId: number; alertDate: string },
): Promise<boolean> {
  if (isTekmetricOpsPgCanonical()) {
    const { tekmetricShopId, alertDate, ...extra } = doc;
    const inserted = await pg.insertWebhookHealthAlert(
      Number(tekmetricShopId),
      alertDate,
      extra,
    );
    if (inserted) {
      await shadow("tekmetric.webhook_health_alerts.insert", () =>
        insertWebhookHealthAlertMongo(doc),
      );
    }
    return inserted;
  }
  return insertWebhookHealthAlertMongo(doc);
}

async function insertWebhookHealthAlertMongo(
  doc: AnyDoc & { tekmetricShopId: number; alertDate: string },
): Promise<boolean> {
  const c = await col(WEBHOOK_HEALTH_ALERTS);
  try {
    await c.insertOne(doc as Document);
    return true;
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === 11000) return false;
    throw err;
  }
}

/* ========================================================================== */
/* Tokens                                                                      */
/* ========================================================================== */
//
// The Mongo `tekmetric_tokens` collection holds a SINGLE global
// client-credentials token keyed `{ tokenKey: "current" }` (see
// lib/integrations/tekmetric/auth.ts). The PG `tekmetric_tokens` table keys
// on shop_id; the PG repo maps this global doc to the sentinel shop_id = 0
// and stashes tokenKey/createdAt in the `raw` jsonb.

export interface TekmetricTokenDoc {
  accessToken: string;
  tokenType?: string | null;
  scope?: string | null;
  expiresAt?: Date | null;
  createdAt?: Date | null;
}

export async function getCurrentToken(): Promise<AnyDoc | null> {
  if (isTekmetricOpsPgCanonical()) return pg.getCurrentToken();
  const c = await col(TOKENS);
  return (await c.findOne({ tokenKey: "current" })) as AnyDoc | null;
}

export async function upsertCurrentToken(
  token: TekmetricTokenDoc,
): Promise<void> {
  if (isTekmetricOpsPgCanonical()) {
    await pg.upsertCurrentToken(token);
    await shadow("tekmetric.tokens.upsert", () =>
      upsertCurrentTokenMongo(token),
    );
    return;
  }
  await upsertCurrentTokenMongo(token);
}

async function upsertCurrentTokenMongo(
  token: TekmetricTokenDoc,
): Promise<void> {
  const c = await col(TOKENS);
  await c.updateOne(
    { tokenKey: "current" },
    {
      $set: {
        tokenKey: "current",
        accessToken: token.accessToken,
        tokenType: token.tokenType,
        scope: token.scope,
        expiresAt: token.expiresAt,
        createdAt: token.createdAt,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

export async function deleteCurrentToken(): Promise<void> {
  if (isTekmetricOpsPgCanonical()) {
    await pg.deleteCurrentToken();
    await shadow("tekmetric.tokens.delete", () => deleteCurrentTokenMongo());
    return;
  }
  await deleteCurrentTokenMongo();
}

async function deleteCurrentTokenMongo(): Promise<void> {
  const c = await col(TOKENS);
  await c.deleteOne({ tokenKey: "current" });
}

/* ========================================================================== */
/* Drain lock (one lease, provider='tekmetric')                                */
/* ========================================================================== */

export type DrainLockAcquireResult =
  | { acquired: true }
  | { acquired: false; owner: string | null; expiresAt: Date | null };

/**
 * Acquire the global drain lease. Returns `{acquired:true}` on success, or
 * `{acquired:false, owner, expiresAt}` when another live worker holds it —
 * mirroring the Mongo findOneAndUpdate acquire (unique-violation / no-match
 * means held).
 */
export async function acquireDrainLock(
  owner: string,
  ttlMs: number,
): Promise<DrainLockAcquireResult> {
  if (isTekmetricOpsPgCanonical()) {
    const ok = await pg.acquireDrainLock(owner, ttlMs);
    if (ok) {
      await shadow("tekmetric.drain_lock.acquire", () =>
        acquireDrainLockMongoRaw(owner, ttlMs),
      );
      return { acquired: true };
    }
    const held = await pg.getDrainLock();
    return {
      acquired: false,
      owner: (held?.owner as string) ?? null,
      expiresAt: (held?.expiresAt as Date) ?? null,
    };
  }
  return acquireDrainLockMongo(owner, ttlMs);
}

async function acquireDrainLockMongoRaw(
  owner: string,
  ttlMs: number,
): Promise<void> {
  const c = await col(DRAIN_LOCK);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await c.findOneAndUpdate(
    {
      _id: "global" as unknown as Document["_id"],
      $or: [
        { expiresAt: { $lte: now } },
        { expiresAt: { $exists: false } },
        { owner },
      ],
    } as Document,
    {
      $set: { owner, acquiredAt: now, expiresAt, lastRefreshAt: now },
    },
    { upsert: true, returnDocument: "after" },
  );
}

async function acquireDrainLockMongo(
  owner: string,
  ttlMs: number,
): Promise<DrainLockAcquireResult> {
  const c = await col(DRAIN_LOCK);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  try {
    await c.findOneAndUpdate(
      {
        _id: "global" as unknown as Document["_id"],
        $or: [
          { expiresAt: { $lte: now } },
          { expiresAt: { $exists: false } },
          { owner },
        ],
      } as Document,
      {
        $set: { owner, acquiredAt: now, expiresAt, lastRefreshAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );
    return { acquired: true };
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === 11000) {
      const existing = (await c
        .findOne({ _id: "global" as unknown as Document["_id"] } as Document)
        .catch(() => null)) as AnyDoc | null;
      return {
        acquired: false,
        owner: (existing?.owner as string) ?? null,
        expiresAt: (existing?.expiresAt as Date) ?? null,
      };
    }
    throw err;
  }
}

/** Refresh the lease. Returns false when we no longer own it (lost lock). */
export async function refreshDrainLock(
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  if (isTekmetricOpsPgCanonical()) {
    const ok = await pg.refreshDrainLock(owner, ttlMs);
    await shadow("tekmetric.drain_lock.refresh", () =>
      refreshDrainLockMongo(owner, ttlMs),
    );
    return ok;
  }
  return refreshDrainLockMongo(owner, ttlMs);
}

async function refreshDrainLockMongo(
  owner: string,
  ttlMs: number,
): Promise<boolean> {
  const c = await col(DRAIN_LOCK);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const result = await c.updateOne(
    { _id: "global" as unknown as Document["_id"], owner } as Document,
    { $set: { expiresAt, lastRefreshAt: now } },
  );
  return result.matchedCount > 0;
}

/** Release the lease we own. Returns the number of rows removed (0 or 1). */
export async function releaseDrainLock(owner: string): Promise<number> {
  if (isTekmetricOpsPgCanonical()) {
    const n = await pg.releaseDrainLock(owner);
    await shadow("tekmetric.drain_lock.release", () =>
      releaseDrainLockMongo(owner),
    );
    return n;
  }
  return releaseDrainLockMongo(owner);
}

async function releaseDrainLockMongo(owner: string): Promise<number> {
  const c = await col(DRAIN_LOCK);
  const result = await c.deleteOne({
    _id: "global" as unknown as Document["_id"],
    owner,
  } as Document);
  return result.deletedCount ?? 0;
}

export async function getDrainLock(): Promise<AnyDoc | null> {
  if (isTekmetricOpsPgCanonical()) return pg.getDrainLock();
  const c = await col(DRAIN_LOCK);
  return (await c.findOne({
    _id: "global" as unknown as Document["_id"],
  } as Document)) as AnyDoc | null;
}
