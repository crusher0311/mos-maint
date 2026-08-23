/**
 * Flag-dispatching facade for the plan & analysis cache family (task #998).
 *
 * Every read/write of `cached_plans`, `maintenance_analysis_cache`,
 * `ai_analysis_cache`, `plan_prefetch_cache`, `cached_work_orders`,
 * `recommendations`, `recommendations_cache`, `recommendation_events`,
 * `report_approved_items`, and `remedied_deferred_work` in application
 * code goes through this module.
 *
 * Dispatch rules (see lib/db/plan-cache-write-mode.ts):
 *  - `PLAN_CACHE_PG_CANONICAL` OFF (default) → Mongo canonical, PG never
 *    touched → zero behaviour change.
 *  - ON → PG canonical. Writes go to PG first (await + throw on failure)
 *    with a best-effort Mongo shadow write while
 *    `WRITE_MONGO_PLAN_CACHE=1`. Reads are PG-first with a Mongo
 *    fallback on miss while shadow writes are on (TTL caches need no
 *    backfill — the warm Mongo cache simply ages out during the soak).
 *  - Invalidations (deletes) always hit BOTH stores so a flag flip can
 *    never resurrect a stale entry.
 *
 * Callers may pass their own Mongo `Db` handle (tests inject in-memory
 * fakes); when omitted the shared handle from `lib/data/db` is used.
 */
import type { Db, Document } from "mongodb";
import { getDb as getSharedMongo } from "@/lib/data/db";
import {
  isPlanCachePgCanonical,
  shouldShadowWriteMongoPlanCache,
  shadowWriteMongoPlanCache,
} from "@/lib/db/plan-cache-write-mode";
import * as pg from "@/lib/data/repositories/pg/plan-cache";

type AnyDoc = Record<string, unknown>;

async function mongo(db?: Db): Promise<Db> {
  return db ?? (await getSharedMongo());
}

/** Legacy rows stored shopId as String or Number — match both. */
function shopIdIn(shopId: number) {
  return { $in: [String(shopId), Number(shopId)] };
}

/* ========================================================================== */
/* cached_plans                                                               */
/* ========================================================================== */

/**
 * Candidate cached-plan docs for (vin, shopId), newest-first. The caller
 * (lib/plan-cache.ts selectValidCachedPlan) applies TTL / schema /
 * mileage / oemMissing validation — identical for both stores.
 */
export async function findCachedPlanCandidates(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<AnyDoc[]> {
  if (isPlanCachePgCanonical()) {
    const row = await pg.pgFindCachedPlan(Number(shopId), vin);
    if (row) return [row];
    if (shouldShadowWriteMongoPlanCache()) {
      return findCachedPlanCandidatesMongo(shopId, vin, db);
    }
    return [];
  }
  return findCachedPlanCandidatesMongo(shopId, vin, db);
}

async function findCachedPlanCandidatesMongo(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<AnyDoc[]> {
  const m = await mongo(db);
  return m
    .collection("cached_plans")
    .find({ vin: vin.toUpperCase(), shopId: shopIdIn(shopId) })
    .sort({ createdAt: -1 })
    .toArray();
}

/** Latest cached-plan doc regardless of TTL/schema validity (raw read). */
export async function findLatestCachedPlanDoc(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<AnyDoc | null> {
  const candidates = await findCachedPlanCandidates(shopId, vin, db);
  return candidates[0] ?? null;
}

export async function upsertCachedPlanDoc(
  shopId: number,
  vin: string,
  doc: {
    mileage: number | null;
    plan: AnyDoc;
    createdAt: Date;
    expiresAt: Date;
    schemaVersion: number;
  },
  db?: Db,
): Promise<void> {
  const normalizedVin = vin.toUpperCase();
  const normalizedShopId = Number(shopId);

  const mongoWrite = async () => {
    const m = await mongo(db);
    // Historical race fix (2026-05-12, task #392 follow-up): clean up only
    // the legacy String-shopId variant rows first, then upsert the
    // canonical Number-shopId row so readers always see SOMETHING.
    await m.collection("cached_plans").deleteMany({
      vin: normalizedVin,
      shopId: String(normalizedShopId),
    });
    await m.collection("cached_plans").updateOne(
      { vin: normalizedVin, shopId: normalizedShopId },
      {
        $set: {
          mileage: doc.mileage,
          plan: doc.plan,
          createdAt: doc.createdAt,
          expiresAt: doc.expiresAt,
          schemaVersion: doc.schemaVersion,
        },
      },
      { upsert: true },
    );
  };

  if (isPlanCachePgCanonical()) {
    await pg.pgUpsertCachedPlan(normalizedShopId, normalizedVin, doc);
    await shadowWriteMongoPlanCache("cached_plans.upsert", mongoWrite);
    return;
  }
  await mongoWrite();
}

/** In-place patch of `plan.*` fields on the cached row (VHI-rebuild). */
export async function patchCachedPlanFields(
  shopId: number,
  vin: string,
  planFields: AnyDoc,
  db?: Db,
): Promise<void> {
  const mongoWrite = async () => {
    const m = await mongo(db);
    const $set: AnyDoc = {};
    for (const [k, v] of Object.entries(planFields)) $set[`plan.${k}`] = v;
    await m
      .collection("cached_plans")
      .updateOne({ vin: vin.toUpperCase(), shopId: shopIdIn(shopId) }, { $set });
  };
  if (isPlanCachePgCanonical()) {
    await pg.pgPatchCachedPlanFields(Number(shopId), vin, planFields);
    await shadowWriteMongoPlanCache("cached_plans.patch", mongoWrite);
    return;
  }
  await mongoWrite();
}

/**
 * Deletes cached plans for a VIN (or a whole shop when vin omitted).
 * Always hits BOTH stores — invalidation must be flag-independent.
 * Returns the larger of the two deleted counts (best-effort signal).
 */
export async function deleteCachedPlans(
  shopId: number,
  vin?: string,
  db?: Db,
): Promise<number> {
  const m = await mongo(db);
  const filter: Document = vin
    ? { vin: vin.toUpperCase(), shopId: shopIdIn(shopId) }
    : { shopId: shopIdIn(shopId) };
  const res = await m.collection("cached_plans").deleteMany(filter);
  let pgCount = 0;
  try {
    pgCount = vin
      ? await pg.pgDeleteCachedPlan(Number(shopId), vin)
      : await pg.pgDeleteCachedPlansForShop(Number(shopId));
  } catch (err) {
    // PG delete is best-effort while Mongo is canonical; when PG is
    // canonical a failure here matters, so rethrow in that mode.
    if (isPlanCachePgCanonical()) throw err;
    console.warn("[PlanCacheStore] PG cached_plans delete failed (non-fatal pre-cutover):", (err as Error)?.message);
  }
  return Math.max(res.deletedCount ?? 0, pgCount);
}

/** Admin "clear everything" — both stores. */
export async function deleteAllCachedPlans(db?: Db): Promise<number> {
  const m = await mongo(db);
  const res = await m.collection("cached_plans").deleteMany({});
  let pgCount = 0;
  try {
    pgCount = await pg.pgDeleteAllCachedPlans();
  } catch (err) {
    if (isPlanCachePgCanonical()) throw err;
    console.warn("[PlanCacheStore] PG cached_plans clear failed (non-fatal pre-cutover):", (err as Error)?.message);
  }
  return Math.max(res.deletedCount ?? 0, pgCount);
}

/** Newest-first cached-plan summaries for a shop (prefetch roster). */
export async function listRecentCachedPlans(
  shopId: number | null,
  limit: number,
  db?: Db,
): Promise<AnyDoc[]> {
  if (isPlanCachePgCanonical()) {
    const rows = await pg.pgListRecentCachedPlans(shopId != null ? Number(shopId) : null, limit);
    if (rows.length > 0 || !shouldShadowWriteMongoPlanCache()) return rows;
  }
  const m = await mongo(db);
  const filter: Document = shopId != null ? { shopId: shopIdIn(shopId) } : {};
  return m
    .collection("cached_plans")
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Plans carrying a `plan.mileageDiscrepancy` marker (data-quality scan).
 */
export async function listMileageDiscrepancyPlans(
  shopId: number | null,
  db?: Db,
): Promise<AnyDoc[]> {
  if (isPlanCachePgCanonical()) {
    const rows = await pg.pgListMileageDiscrepancyPlans(
      shopId != null ? Number(shopId) : null,
    );
    if (rows.length > 0 || !shouldShadowWriteMongoPlanCache()) return rows;
  }
  const m = await mongo(db);
  const filter: Document = { "plan.mileageDiscrepancy": { $ne: null, $exists: true } };
  if (shopId != null) filter.shopId = shopIdIn(shopId);
  return m
    .collection("cached_plans")
    .find(filter, {
      projection: { vin: 1, shopId: 1, "plan.mileageDiscrepancy": 1, "plan.vehicle": 1 },
    })
    .toArray();
}

/* ========================================================================== */
/* maintenance_analysis_cache                                                 */
/* ========================================================================== */

export async function getMaintenanceAnalysisDoc(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<AnyDoc | null> {
  if (isPlanCachePgCanonical()) {
    const row = await pg.pgGetMaintenanceAnalysis(Number(shopId), vin);
    if (row) return row;
    if (!shouldShadowWriteMongoPlanCache()) return null;
  }
  const m = await mongo(db);
  return m.collection("maintenance_analysis_cache").findOne({
    vin: vin.toUpperCase(),
    shopId: shopIdIn(shopId),
  });
}

/** Freshness metadata for a set of VINs (extension prefetch loop). */
export async function listMaintenanceAnalysisMeta(
  shopId: number,
  vins: string[],
  db?: Db,
): Promise<Array<{ vin: string; analyzedAt?: Date | null; mileageAtAnalysis?: number | null }>> {
  if (isPlanCachePgCanonical()) {
    const rows = await pg.pgListMaintenanceAnalysisMeta(Number(shopId), vins);
    if (rows.length > 0 || !shouldShadowWriteMongoPlanCache()) return rows;
  }
  const m = await mongo(db);
  return m
    .collection("maintenance_analysis_cache")
    .find({ vin: { $in: vins }, shopId: Number(shopId) })
    .project({ vin: 1, analyzedAt: 1, mileageAtAnalysis: 1 })
    .toArray() as Promise<Array<{ vin: string; analyzedAt?: Date | null; mileageAtAnalysis?: number | null }>>;
}

export async function upsertMaintenanceAnalysisDoc(doc: AnyDoc, db?: Db): Promise<void> {
  const vin = String(doc.vin).toUpperCase();
  const shopId = Number(doc.shopId);
  const mongoWrite = async () => {
    const m = await mongo(db);
    await m
      .collection("maintenance_analysis_cache")
      .updateOne({ vin, shopId }, { $set: { ...doc, vin, shopId } }, { upsert: true });
  };
  if (isPlanCachePgCanonical()) {
    await pg.pgUpsertMaintenanceAnalysis({ ...doc, vin, shopId });
    await shadowWriteMongoPlanCache("maintenance_analysis_cache.upsert", mongoWrite);
    return;
  }
  await mongoWrite();
}

/** Shop-wide analysis-cache invalidation — both stores, flag-independent. */
export async function deleteMaintenanceAnalysisForShop(
  shopId: number,
  db?: Db,
): Promise<number> {
  const m = await mongo(db);
  const res = await m
    .collection("maintenance_analysis_cache")
    .deleteMany({ shopId: shopIdIn(shopId) });
  let pgCount = 0;
  try {
    pgCount = await pg.pgDeleteMaintenanceAnalysisForShop(Number(shopId));
  } catch (err) {
    if (isPlanCachePgCanonical()) throw err;
    console.warn("[PlanCacheStore] PG analysis-cache delete failed (non-fatal pre-cutover):", (err as Error)?.message);
  }
  return Math.max(res.deletedCount ?? 0, pgCount);
}

/* ========================================================================== */
/* ai_analysis_cache                                                          */
/* ========================================================================== */

export async function getAiAnalysisDoc(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<AnyDoc | null> {
  if (isPlanCachePgCanonical()) {
    const row = await pg.pgGetAiAnalysis(Number(shopId), vin);
    if (row) return row;
    if (!shouldShadowWriteMongoPlanCache()) return null;
  }
  const m = await mongo(db);
  return m.collection("ai_analysis_cache").findOne({
    shopId: Number(shopId),
    vin: vin.toUpperCase(),
  });
}

export async function upsertAiAnalysisDoc(
  shopId: number,
  vin: string,
  result: unknown,
  db?: Db,
): Promise<void> {
  const mongoWrite = async () => {
    const m = await mongo(db);
    await m.collection("ai_analysis_cache").updateOne(
      { shopId: Number(shopId), vin: vin.toUpperCase() },
      {
        $set: {
          shopId: Number(shopId),
          vin: vin.toUpperCase(),
          result,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  };
  if (isPlanCachePgCanonical()) {
    await pg.pgUpsertAiAnalysis(Number(shopId), vin, result);
    await shadowWriteMongoPlanCache("ai_analysis_cache.upsert", mongoWrite);
    return;
  }
  await mongoWrite();
}

/* ========================================================================== */
/* plan_prefetch_cache                                                        */
/* ========================================================================== */

export async function getPlanPrefetchDoc(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<AnyDoc | null> {
  if (isPlanCachePgCanonical()) {
    const row = await pg.pgGetPlanPrefetch(Number(shopId), vin);
    if (row) return row;
    if (!shouldShadowWriteMongoPlanCache()) return null;
  }
  const m = await mongo(db);
  return m.collection("plan_prefetch_cache").findOne({
    vin: vin.toUpperCase(),
    shopId: Number(shopId),
    expiresAt: { $gt: new Date() },
  });
}

export async function setPlanPrefetchDoc(
  shopId: number,
  vin: string,
  doc: AnyDoc,
  expiresAt: Date,
  db?: Db,
): Promise<void> {
  const mongoWrite = async () => {
    const m = await mongo(db);
    await m.collection("plan_prefetch_cache").updateOne(
      { vin: vin.toUpperCase(), shopId: Number(shopId) },
      { $set: { ...doc, vin: vin.toUpperCase(), shopId: Number(shopId), expiresAt } },
      { upsert: true },
    );
  };
  if (isPlanCachePgCanonical()) {
    await pg.pgSetPlanPrefetch(Number(shopId), vin, doc, expiresAt);
    await shadowWriteMongoPlanCache("plan_prefetch_cache.upsert", mongoWrite);
    return;
  }
  await mongoWrite();
}

/* ========================================================================== */
/* cached_work_orders (legacy Shop-Ware mirror — read-only in the app)        */
/* ========================================================================== */

export async function findCachedWorkOrderCustomerName(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<{ customerName?: string | null } | null> {
  if (isPlanCachePgCanonical()) {
    const row = await pg.pgFindCachedWorkOrderCustomerName(Number(shopId), vin);
    if (row) return row;
    if (!shouldShadowWriteMongoPlanCache()) return null;
  }
  const m = await mongo(db);
  return m.collection("cached_work_orders").findOne<{ customerName?: string | null }>(
    {
      vin: vin.toUpperCase(),
      shopId: shopIdIn(shopId),
      customerName: { $exists: true, $nin: [null, ""] },
    },
    { sort: { createdAt: -1 }, projection: { customerName: 1 } },
  );
}

/* ========================================================================== */
/* recommendations (durable per-vehicle rows — read path)                     */
/* ========================================================================== */

export async function listRecommendationDocs(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<AnyDoc[]> {
  if (isPlanCachePgCanonical()) {
    const rows = await pg.pgListRecommendations(Number(shopId), vin);
    if (rows.length > 0 || !shouldShadowWriteMongoPlanCache()) {
      return rows.sort(
        (a, b) => Number((a as AnyDoc).priority ?? 0) - Number((b as AnyDoc).priority ?? 0),
      );
    }
  }
  const m = await mongo(db);
  return m
    .collection("recommendations")
    .find({ shopId, vin })
    .sort({ priority: 1 })
    .toArray();
}

/* ========================================================================== */
/* recommendations_cache                                                      */
/* ========================================================================== */

export async function getRecommendationsCacheDoc(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<AnyDoc | null> {
  if (isPlanCachePgCanonical()) {
    const row = await pg.pgGetRecommendationsCache(Number(shopId), vin);
    if (row) return row;
    if (!shouldShadowWriteMongoPlanCache()) return null;
  }
  const m = await mongo(db);
  return m.collection("recommendations_cache").findOne({ vin: vin.toUpperCase(), shopId });
}

export async function upsertRecommendationsCacheDoc(
  shopId: number,
  vin: string,
  recommendations: unknown,
  db?: Db,
): Promise<void> {
  const updatedAt = new Date();
  const mongoWrite = async () => {
    const m = await mongo(db);
    await m.collection("recommendations_cache").updateOne(
      { vin: vin.toUpperCase(), shopId },
      { $set: { recommendations, updatedAt } },
      { upsert: true },
    );
  };
  if (isPlanCachePgCanonical()) {
    await pg.pgUpsertRecommendationsCache(Number(shopId), vin, { recommendations, updatedAt });
    await shadowWriteMongoPlanCache("recommendations_cache.upsert", mongoWrite);
    return;
  }
  await mongoWrite();
}

/* ========================================================================== */
/* recommendation_events (durable, append-only)                               */
/* ========================================================================== */

/**
 * Dual-writes a recommendation event: Mongo insert stays primary while
 * the flag is off (return value preserved for callers), PG insert is
 * canonical when the flag is on (Mongo becomes the shadow).
 */
export async function recordRecommendationEventPg(doc: AnyDoc): Promise<void> {
  await pg.pgInsertRecommendationEvent(doc);
}

export async function summarizeRecommendationEvents(
  shopId: number,
  startDate?: Date,
  endDate?: Date,
  db?: Db,
): Promise<pg.PgRecEventSummaryRow[]> {
  if (isPlanCachePgCanonical()) {
    return pg.pgSummarizeRecommendationEvents(Number(shopId), startDate, endDate);
  }
  const m = await mongo(db);
  const matchStage: Document = { shopId: Number(shopId) };
  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = startDate;
    if (endDate) matchStage.createdAt.$lte = endDate;
  }
  const rows = await m
    .collection("recommendation_events")
    .aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: { eventType: "$eventType", recommendationType: "$recommendationType" },
          count: { $sum: 1 },
          totalRevenue: { $sum: { $ifNull: ["$totalPrice", 0] } },
          laborRevenue: { $sum: { $ifNull: ["$laborPrice", 0] } },
          partsRevenue: { $sum: { $ifNull: ["$partsPrice", 0] } },
        },
      },
    ])
    .toArray();
  return rows.map((r) => ({
    eventType: r._id.eventType ?? null,
    recommendationType: r._id.recommendationType ?? null,
    count: r.count ?? 0,
    totalRevenue: r.totalRevenue ?? 0,
    laborRevenue: r.laborRevenue ?? 0,
    partsRevenue: r.partsRevenue ?? 0,
  }));
}

export async function dailyRecommendationEvents(
  shopId: number,
  startDate?: Date,
  endDate?: Date,
  limit = 60,
  db?: Db,
): Promise<pg.PgRecEventDailyRow[]> {
  if (isPlanCachePgCanonical()) {
    return pg.pgDailyRecommendationEvents(Number(shopId), startDate, endDate, limit);
  }
  const m = await mongo(db);
  const matchStage: Document = { shopId: Number(shopId) };
  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = startDate;
    if (endDate) matchStage.createdAt.$lte = endDate;
  }
  const rows = await m
    .collection("recommendation_events")
    .aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            eventType: "$eventType",
          },
          count: { $sum: 1 },
          revenue: { $sum: { $ifNull: ["$totalPrice", 0] } },
        },
      },
      { $sort: { "_id.date": -1 } },
      { $limit: limit },
    ])
    .toArray();
  return rows.map((r) => ({
    date: r._id.date,
    eventType: r._id.eventType ?? null,
    count: r.count ?? 0,
    revenue: r.revenue ?? 0,
  }));
}

/* ========================================================================== */
/* report_approved_items (durable)                                            */
/* ========================================================================== */

export async function getReportApprovedItemsDoc(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<{ approvedServiceKeys?: string[]; updatedAt?: Date } | null> {
  if (isPlanCachePgCanonical()) {
    const row = await pg.pgGetReportApprovedItems(Number(shopId), vin);
    if (row) return row;
    if (!shouldShadowWriteMongoPlanCache()) return null;
  }
  const m = await mongo(db);
  return m.collection("report_approved_items").findOne<{ approvedServiceKeys?: string[]; updatedAt?: Date }>({
    vin: vin.toUpperCase(),
    shopId: shopIdIn(shopId),
  });
}

export async function upsertReportApprovedItemsDoc(
  shopId: number,
  vin: string,
  approvedServiceKeys: string[],
  db?: Db,
): Promise<void> {
  const mongoWrite = async () => {
    const m = await mongo(db);
    await m.collection("report_approved_items").updateOne(
      { vin: vin.toUpperCase(), shopId: Number(shopId) },
      {
        $set: {
          vin: vin.toUpperCase(),
          shopId: Number(shopId),
          approvedServiceKeys,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  };
  if (isPlanCachePgCanonical()) {
    await pg.pgUpsertReportApprovedItems(Number(shopId), vin, approvedServiceKeys);
    await shadowWriteMongoPlanCache("report_approved_items.upsert", mongoWrite);
    return;
  }
  await mongoWrite();
}

export async function deleteReportApprovedItemsDoc(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<void> {
  // Delete-both-stores, flag-independent (like the plan invalidations).
  const m = await mongo(db);
  await m
    .collection("report_approved_items")
    .deleteOne({ vin: vin.toUpperCase(), shopId: Number(shopId) });
  try {
    await pg.pgDeleteReportApprovedItems(Number(shopId), vin);
  } catch (err) {
    if (isPlanCachePgCanonical()) throw err;
    console.warn("[PlanCacheStore] PG report_approved_items delete failed (non-fatal pre-cutover):", (err as Error)?.message);
  }
}

/* ========================================================================== */
/* remedied_deferred_work (durable)                                           */
/* ========================================================================== */

export async function listRemediedDeferredWorkDocs(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<AnyDoc[]> {
  if (isPlanCachePgCanonical()) {
    const rows = await pg.pgListRemediedDeferredWork(Number(shopId), vin);
    if (rows.length > 0 || !shouldShadowWriteMongoPlanCache()) return rows;
  }
  const m = await mongo(db);
  return m
    .collection("remedied_deferred_work")
    .find({ shopId: Number(shopId), vin: vin.toUpperCase() })
    .toArray();
}

export async function upsertRemediedDeferredWorkDoc(
  doc: {
    shopId: number;
    vin: string;
    deferredId: string;
    carfaxDate?: string | null;
    carfaxDescription?: string | null;
    carfaxLocation?: string | null;
    remediedAt: Date;
    remediedBy?: string;
  },
  db?: Db,
): Promise<void> {
  const mongoWrite = async () => {
    const m = await mongo(db);
    await m.collection("remedied_deferred_work").updateOne(
      { shopId: doc.shopId, vin: doc.vin.toUpperCase(), deferredId: doc.deferredId },
      {
        $set: { ...doc, vin: doc.vin.toUpperCase() },
        $setOnInsert: { createdAt: doc.remediedAt },
      },
      { upsert: true },
    );
  };
  if (isPlanCachePgCanonical()) {
    await pg.pgUpsertRemediedDeferredWork(doc);
    await shadowWriteMongoPlanCache("remedied_deferred_work.upsert", mongoWrite);
    return;
  }
  await mongoWrite();
}

/* ========================================================================== */
/* legacy `plan_cache` (dead-collection cleanup used by deferred/remedy)      */
/* ========================================================================== */

export async function deleteLegacyPlanCacheEntry(
  shopId: number,
  vin: string,
  db?: Db,
): Promise<void> {
  const m = await mongo(db);
  await m.collection("plan_cache").deleteOne({ shopId, vin: vin.toUpperCase() });
}
