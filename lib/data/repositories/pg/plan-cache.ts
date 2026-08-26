/**
 * Postgres-backed plan & analysis cache repository (task #998) — the
 * read/write surface used by `lib/data/repositories/plan-cache-store.ts`
 * when `PLAN_CACHE_PG_CANONICAL=1`.
 *
 * Backs:
 *   - `cached_plans`, `plan_prefetch_cache`, `cached_work_orders`,
 *     `recommendations`, `recommendations_cache`, `recommendation_events`
 *     (lib/db/schema/wave3.ts — payload-carrying mirror tables)
 *   - `ai_analysis_cache`, `maintenance_analysis_cache`,
 *     `report_approved_items`, `remedied_deferred_work`
 *     (lib/db/schema/wave2.ts — typed tables)
 *
 * The verbatim Mongo document shape is stored in `payload` / `raw` so
 * reads can reconstruct exactly what callers expect; the dispatcher
 * (PG-vs-Mongo) lives in the facade — this file has no knowledge of the
 * kill-switch flag. See docs/runbooks/db-plan-cache-cutover.md.
 */
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import {
  cachedPlans,
  planPrefetchCache,
  cachedWorkOrders,
  recommendations as recommendationsTable,
  recommendationsCache,
  recommendationEvents,
} from "@/lib/db/schema/wave3";
import {
  aiAnalysisCache,
  maintenanceAnalysisCache,
  reportApprovedItems,
  remediedDeferredWork,
} from "@/lib/db/schema/wave2";

type AnyDoc = Record<string, unknown>;

/** Revive the date fields the Mongo shape carries as Date objects. */
function reviveDates(doc: AnyDoc, keys: string[]): AnyDoc {
  for (const k of keys) {
    const v = doc[k];
    if (typeof v === "string") {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) doc[k] = d;
    }
  }
  return doc;
}

/* -------------------------------------------------------------------------- */
/* cached_plans — one row per (shopId, vin); payload = full Mongo doc shape    */
/* (mileage, plan, createdAt, expiresAt, schemaVersion).                       */
/* -------------------------------------------------------------------------- */

export interface PgCachedPlanDoc extends AnyDoc {
  vin: string;
  shopId: number;
  mileage: number | null;
  plan: AnyDoc;
  createdAt: Date;
  expiresAt: Date;
  schemaVersion?: number;
}

function rowToCachedPlanDoc(row: { shopId: number; vin: string; payload: unknown }): PgCachedPlanDoc {
  const payload = (row.payload ?? {}) as AnyDoc;
  const doc = { ...payload, vin: row.vin, shopId: row.shopId } as PgCachedPlanDoc;
  reviveDates(doc, ["createdAt", "expiresAt"]);
  return doc;
}

export async function pgFindCachedPlan(
  shopId: number,
  vin: string,
): Promise<PgCachedPlanDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(cachedPlans)
    .where(and(eq(cachedPlans.shopId, shopId), eq(cachedPlans.vin, vin.toUpperCase())))
    .limit(1);
  return rows[0] ? rowToCachedPlanDoc(rows[0]) : null;
}

/** One bounded query for the latest cached-plan rows for a VIN set. */
export async function pgFindCachedPlans(
  shopId: number,
  vins: string[],
): Promise<PgCachedPlanDoc[]> {
  if (vins.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(cachedPlans)
    .where(
      and(
        eq(cachedPlans.shopId, shopId),
        inArray(cachedPlans.vin, vins.map((vin) => vin.toUpperCase())),
      ),
    );
  return rows.map(rowToCachedPlanDoc);
}

export async function pgUpsertCachedPlan(
  shopId: number,
  vin: string,
  doc: Omit<PgCachedPlanDoc, "vin" | "shopId">,
): Promise<void> {
  const db = getDb();
  const createdAt = doc.createdAt as Date;
  const payload = {
    mileage: doc.mileage ?? null,
    plan: doc.plan,
    createdAt,
    expiresAt: doc.expiresAt,
    schemaVersion: doc.schemaVersion,
  };
  await db
    .insert(cachedPlans)
    .values({ shopId, vin: vin.toUpperCase(), payload, cachedAt: createdAt })
    .onConflictDoUpdate({
      target: [cachedPlans.shopId, cachedPlans.vin],
      set: { payload, cachedAt: createdAt },
    });
}

/**
 * In-place partial update of the cached plan's `plan.*` fields (used by
 * the VHI-rebuild mileage-source patch). No-op when the row is absent.
 */
export async function pgPatchCachedPlanFields(
  shopId: number,
  vin: string,
  planFields: AnyDoc,
): Promise<void> {
  const db = getDb();
  const existing = await pgFindCachedPlan(shopId, vin);
  if (!existing) return;
  const plan = { ...(existing.plan as AnyDoc), ...planFields };
  await db
    .update(cachedPlans)
    .set({
      payload: {
        mileage: existing.mileage ?? null,
        plan,
        createdAt: existing.createdAt,
        expiresAt: existing.expiresAt,
        schemaVersion: existing.schemaVersion,
      },
    })
    .where(and(eq(cachedPlans.shopId, shopId), eq(cachedPlans.vin, vin.toUpperCase())));
}

export async function pgDeleteCachedPlan(shopId: number, vin: string): Promise<number> {
  const db = getDb();
  const res = await db
    .delete(cachedPlans)
    .where(and(eq(cachedPlans.shopId, shopId), eq(cachedPlans.vin, vin.toUpperCase())));
  return (res as unknown as { count?: number }).count ?? 0;
}

export async function pgDeleteCachedPlansForShop(shopId: number): Promise<number> {
  const db = getDb();
  const res = await db.delete(cachedPlans).where(eq(cachedPlans.shopId, shopId));
  return (res as unknown as { count?: number }).count ?? 0;
}

export async function pgDeleteAllCachedPlans(): Promise<number> {
  const db = getDb();
  const res = await db.delete(cachedPlans);
  return (res as unknown as { count?: number }).count ?? 0;
}

/** Newest-first summaries for a shop (internal prefetch roster). */
export async function pgListRecentCachedPlans(
  shopId: number | null,
  limit: number,
): Promise<PgCachedPlanDoc[]> {
  const db = getDb();
  const base = db.select().from(cachedPlans);
  const rows = await (shopId != null
    ? base.where(eq(cachedPlans.shopId, shopId))
    : base
  )
    .orderBy(desc(cachedPlans.cachedAt))
    .limit(limit);
  return rows.map(rowToCachedPlanDoc);
}

/** Plans flagged with a mileage discrepancy (data-quality scan). */
export async function pgListMileageDiscrepancyPlans(
  shopId: number | null,
): Promise<PgCachedPlanDoc[]> {
  const db = getDb();
  const discrepancyCond = sql`${cachedPlans.payload} -> 'plan' -> 'mileageDiscrepancy' IS NOT NULL AND ${cachedPlans.payload} -> 'plan' ->> 'mileageDiscrepancy' <> 'null'`;
  const rows = await db
    .select()
    .from(cachedPlans)
    .where(
      shopId != null
        ? and(eq(cachedPlans.shopId, shopId), discrepancyCond)
        : discrepancyCond,
    );
  return rows.map(rowToCachedPlanDoc);
}

/** Latest cached plans for a set of VINs (protection-plan roster). */
export async function pgFindCachedPlansForVins(
  shopId: number,
  vins: string[],
): Promise<PgCachedPlanDoc[]> {
  if (vins.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(cachedPlans)
    .where(and(eq(cachedPlans.shopId, shopId), inArray(cachedPlans.vin, vins)));
  return rows.map(rowToCachedPlanDoc);
}

/* -------------------------------------------------------------------------- */
/* plan_prefetch_cache                                                         */
/* -------------------------------------------------------------------------- */

export async function pgGetPlanPrefetch(shopId: number, vin: string): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(planPrefetchCache)
    .where(
      and(
        eq(planPrefetchCache.shopId, shopId),
        eq(planPrefetchCache.vin, vin.toUpperCase()),
        gt(planPrefetchCache.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!rows[0]) return null;
  const doc = { ...((rows[0].payload ?? {}) as AnyDoc), vin: rows[0].vin, shopId: rows[0].shopId };
  return reviveDates(doc, ["createdAt", "expiresAt"]);
}

export async function pgSetPlanPrefetch(
  shopId: number,
  vin: string,
  doc: AnyDoc,
  expiresAt: Date,
): Promise<void> {
  const db = getDb();
  const payload = { ...doc, vin: vin.toUpperCase(), shopId };
  await db
    .insert(planPrefetchCache)
    .values({ shopId, vin: vin.toUpperCase(), payload, cachedAt: new Date(), expiresAt })
    .onConflictDoUpdate({
      target: [planPrefetchCache.shopId, planPrefetchCache.vin],
      set: { payload, cachedAt: new Date(), expiresAt },
    });
}

/* -------------------------------------------------------------------------- */
/* cached_work_orders (legacy Shop-Ware WO mirror; read-only in the app)       */
/* -------------------------------------------------------------------------- */

export async function pgFindCachedWorkOrderCustomerName(
  shopId: number,
  vin: string,
): Promise<{ customerName: string | null } | null> {
  const db = getDb();
  const rows = await db
    .select({ payload: cachedWorkOrders.payload })
    .from(cachedWorkOrders)
    .where(
      and(
        eq(cachedWorkOrders.shopId, shopId),
        sql`${cachedWorkOrders.payload} ->> 'vin' = ${vin.toUpperCase()}`,
        sql`COALESCE(${cachedWorkOrders.payload} ->> 'customerName', '') <> ''`,
      ),
    )
    .orderBy(desc(cachedWorkOrders.cachedAt))
    .limit(1);
  if (!rows[0]) return null;
  const payload = (rows[0].payload ?? {}) as AnyDoc;
  return { customerName: (payload.customerName as string) ?? null };
}

export async function pgUpsertCachedWorkOrder(
  shopId: number,
  cacheKey: string,
  payload: AnyDoc,
  cachedAt: Date,
): Promise<void> {
  const db = getDb();
  await db
    .insert(cachedWorkOrders)
    .values({ shopId, cacheKey, payload, cachedAt })
    .onConflictDoUpdate({
      target: [cachedWorkOrders.shopId, cachedWorkOrders.cacheKey],
      set: { payload, cachedAt },
    });
}

/* -------------------------------------------------------------------------- */
/* recommendations (durable per-vehicle recommendation rows; read-only path)   */
/* -------------------------------------------------------------------------- */

export async function pgListRecommendations(shopId: number, vin: string): Promise<AnyDoc[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(recommendationsTable)
    .where(and(eq(recommendationsTable.shopId, shopId), eq(recommendationsTable.vin, vin)));
  return rows.map((r) => ({
    _id: r.backfillMongoId ?? String(r.id),
    shopId: r.shopId,
    vin: r.vin,
    ...((r.payload ?? {}) as AnyDoc),
  }));
}

export async function pgInsertRecommendation(
  shopId: number | null,
  vin: string | null,
  mongoId: string,
  payload: AnyDoc,
  createdAt: Date,
): Promise<void> {
  const db = getDb();
  await db
    .insert(recommendationsTable)
    .values({ backfillMongoId: mongoId, shopId, vin, payload, createdAt })
    .onConflictDoUpdate({
      target: recommendationsTable.backfillMongoId,
      set: { payload },
    });
}

/* -------------------------------------------------------------------------- */
/* recommendations_cache                                                       */
/* -------------------------------------------------------------------------- */

export async function pgGetRecommendationsCache(
  shopId: number,
  vin: string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(recommendationsCache)
    .where(and(eq(recommendationsCache.shopId, shopId), eq(recommendationsCache.vin, vin.toUpperCase())))
    .limit(1);
  if (!rows[0]) return null;
  const doc = { ...((rows[0].payload ?? {}) as AnyDoc), shopId: rows[0].shopId, vin: rows[0].vin };
  return reviveDates(doc, ["updatedAt"]);
}

export async function pgUpsertRecommendationsCache(
  shopId: number,
  vin: string,
  payload: AnyDoc,
): Promise<void> {
  const db = getDb();
  await db
    .insert(recommendationsCache)
    .values({ shopId, vin: vin.toUpperCase(), payload, cachedAt: new Date() })
    .onConflictDoUpdate({
      target: [recommendationsCache.shopId, recommendationsCache.vin],
      set: { payload, cachedAt: new Date() },
    });
}

/* -------------------------------------------------------------------------- */
/* recommendation_events (durable, append-only)                                */
/* -------------------------------------------------------------------------- */

export async function pgInsertRecommendationEvent(doc: AnyDoc): Promise<void> {
  const db = getDb();
  const createdAt =
    doc.createdAt instanceof Date ? doc.createdAt : new Date((doc.createdAt as string) ?? Date.now());
  await db.insert(recommendationEvents).values({
    backfillMongoId: (doc._id as { toString(): string } | undefined)?.toString() ?? null,
    shopId: typeof doc.shopId === "number" ? doc.shopId : Number(doc.shopId) || null,
    vin: (doc.vin as string) ?? null,
    eventType: (doc.eventType as string) ?? null,
    receivedAt: createdAt,
    payload: doc,
  });
}

export interface PgRecEventSummaryRow {
  eventType: string | null;
  recommendationType: string | null;
  count: number;
  totalRevenue: number;
  laborRevenue: number;
  partsRevenue: number;
}

export async function pgSummarizeRecommendationEvents(
  shopId: number,
  startDate?: Date,
  endDate?: Date,
): Promise<PgRecEventSummaryRow[]> {
  const db = getDb();
  const conds = [eq(recommendationEvents.shopId, shopId)];
  if (startDate) conds.push(sql`${recommendationEvents.receivedAt} >= ${startDate}`);
  if (endDate) conds.push(sql`${recommendationEvents.receivedAt} <= ${endDate}`);
  const rows = await db
    .select({
      eventType: recommendationEvents.eventType,
      recommendationType: sql<string | null>`${recommendationEvents.payload} ->> 'recommendationType'`,
      count: sql<number>`count(*)::int`,
      totalRevenue: sql<number>`COALESCE(sum((${recommendationEvents.payload} ->> 'totalPrice')::numeric), 0)::float8`,
      laborRevenue: sql<number>`COALESCE(sum((${recommendationEvents.payload} ->> 'laborPrice')::numeric), 0)::float8`,
      partsRevenue: sql<number>`COALESCE(sum((${recommendationEvents.payload} ->> 'partsPrice')::numeric), 0)::float8`,
    })
    .from(recommendationEvents)
    .where(and(...conds))
    .groupBy(
      recommendationEvents.eventType,
      sql`${recommendationEvents.payload} ->> 'recommendationType'`,
    );
  return rows;
}

export interface PgRecEventDailyRow {
  date: string;
  eventType: string | null;
  count: number;
  revenue: number;
}

export async function pgDailyRecommendationEvents(
  shopId: number,
  startDate?: Date,
  endDate?: Date,
  limit = 60,
): Promise<PgRecEventDailyRow[]> {
  const db = getDb();
  const conds = [eq(recommendationEvents.shopId, shopId)];
  if (startDate) conds.push(sql`${recommendationEvents.receivedAt} >= ${startDate}`);
  if (endDate) conds.push(sql`${recommendationEvents.receivedAt} <= ${endDate}`);
  const rows = await db
    .select({
      date: sql<string>`to_char(${recommendationEvents.receivedAt}, 'YYYY-MM-DD')`,
      eventType: recommendationEvents.eventType,
      count: sql<number>`count(*)::int`,
      revenue: sql<number>`COALESCE(sum((${recommendationEvents.payload} ->> 'totalPrice')::numeric), 0)::float8`,
    })
    .from(recommendationEvents)
    .where(and(...conds))
    .groupBy(
      sql`to_char(${recommendationEvents.receivedAt}, 'YYYY-MM-DD')`,
      recommendationEvents.eventType,
    )
    .orderBy(desc(sql`to_char(${recommendationEvents.receivedAt}, 'YYYY-MM-DD')`))
    .limit(limit);
  return rows;
}

/* -------------------------------------------------------------------------- */
/* ai_analysis_cache                                                           */
/* -------------------------------------------------------------------------- */

export async function pgGetAiAnalysis(shopId: number, vin: string): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(aiAnalysisCache)
    .where(and(eq(aiAnalysisCache.shopId, shopId), eq(aiAnalysisCache.vin, vin.toUpperCase())))
    .limit(1);
  if (!rows[0]) return null;
  const payload = (rows[0].payload ?? {}) as AnyDoc;
  return {
    ...payload,
    shopId: rows[0].shopId,
    vin: rows[0].vin,
    createdAt: rows[0].createdAt,
    updatedAt: rows[0].updatedAt,
  };
}

export async function pgUpsertAiAnalysis(
  shopId: number,
  vin: string,
  result: unknown,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(aiAnalysisCache)
    .values({ shopId, vin: vin.toUpperCase(), payload: { result }, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [aiAnalysisCache.shopId, aiAnalysisCache.vin],
      // createdAt is refreshed on conflict to match Mongo semantics — the
      // route's 24h freshness check keys on createdAt, so a re-write must
      // reset the TTL clock (task #998 review fix).
      set: { payload: { result }, createdAt: now, updatedAt: now },
    });
}

/* -------------------------------------------------------------------------- */
/* maintenance_analysis_cache                                                  */
/* -------------------------------------------------------------------------- */

function rowToAnalysisDoc(row: {
  shopId: number;
  vin: string;
  recommendations: unknown;
  showInspectItems: unknown;
  mileageAtAnalysis: number | null;
  source: string | null;
  schemaVersion: number | null;
  analyzedAt: Date;
  raw: unknown;
}): AnyDoc {
  const raw = (row.raw ?? {}) as AnyDoc;
  return {
    ...raw,
    shopId: row.shopId,
    vin: row.vin,
    recommendations: row.recommendations ?? raw.recommendations ?? [],
    showInspectItems: row.showInspectItems ?? raw.showInspectItems,
    mileageAtAnalysis: row.mileageAtAnalysis ?? raw.mileageAtAnalysis ?? null,
    source: row.source ?? raw.source ?? null,
    schemaVersion: row.schemaVersion ?? raw.schemaVersion ?? null,
    analyzedAt: row.analyzedAt,
  };
}

export async function pgGetMaintenanceAnalysis(
  shopId: number,
  vin: string,
): Promise<AnyDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(maintenanceAnalysisCache)
    .where(
      and(
        eq(maintenanceAnalysisCache.shopId, shopId),
        eq(maintenanceAnalysisCache.vin, vin.toUpperCase()),
      ),
    )
    .limit(1);
  return rows[0] ? rowToAnalysisDoc(rows[0]) : null;
}

export async function pgListMaintenanceAnalysisMeta(
  shopId: number,
  vins: string[],
): Promise<Array<{ vin: string; analyzedAt: Date; mileageAtAnalysis: number | null }>> {
  if (vins.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      vin: maintenanceAnalysisCache.vin,
      analyzedAt: maintenanceAnalysisCache.analyzedAt,
      mileageAtAnalysis: maintenanceAnalysisCache.mileageAtAnalysis,
    })
    .from(maintenanceAnalysisCache)
    .where(
      and(eq(maintenanceAnalysisCache.shopId, shopId), inArray(maintenanceAnalysisCache.vin, vins)),
    );
  return rows;
}

export async function pgUpsertMaintenanceAnalysis(doc: AnyDoc): Promise<void> {
  const db = getDb();
  const shopId = Number(doc.shopId);
  const vin = String(doc.vin).toUpperCase();
  const analyzedAt =
    doc.analyzedAt instanceof Date ? doc.analyzedAt : new Date((doc.analyzedAt as string) ?? Date.now());
  const values = {
    shopId,
    vin,
    recommendations: doc.recommendations ?? [],
    showInspectItems: doc.showInspectItems ?? null,
    mileageAtAnalysis:
      typeof doc.mileageAtAnalysis === "number" ? Math.round(doc.mileageAtAnalysis) : null,
    source: (doc.source as string) ?? null,
    schemaVersion: typeof doc.schemaVersion === "number" ? doc.schemaVersion : null,
    analyzedAt,
    raw: doc,
  };
  await db
    .insert(maintenanceAnalysisCache)
    .values(values)
    .onConflictDoUpdate({
      target: [maintenanceAnalysisCache.shopId, maintenanceAnalysisCache.vin],
      set: { ...values },
    });
}

export async function pgDeleteMaintenanceAnalysisForShop(shopId: number): Promise<number> {
  const db = getDb();
  const res = await db
    .delete(maintenanceAnalysisCache)
    .where(eq(maintenanceAnalysisCache.shopId, shopId));
  return (res as unknown as { count?: number }).count ?? 0;
}

/* -------------------------------------------------------------------------- */
/* report_approved_items                                                       */
/* -------------------------------------------------------------------------- */

export async function pgGetReportApprovedItems(
  shopId: number,
  vin: string,
): Promise<{ approvedServiceKeys: string[]; updatedAt: Date } | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(reportApprovedItems)
    .where(and(eq(reportApprovedItems.shopId, shopId), eq(reportApprovedItems.vin, vin.toUpperCase())))
    .limit(1);
  if (!rows[0]) return null;
  return {
    approvedServiceKeys: (rows[0].approvedServiceKeys as string[]) ?? [],
    updatedAt: rows[0].updatedAt,
  };
}

export async function pgUpsertReportApprovedItems(
  shopId: number,
  vin: string,
  approvedServiceKeys: string[],
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(reportApprovedItems)
    .values({ shopId, vin: vin.toUpperCase(), approvedServiceKeys, updatedAt: now })
    .onConflictDoUpdate({
      target: [reportApprovedItems.shopId, reportApprovedItems.vin],
      set: { approvedServiceKeys, updatedAt: now },
    });
}

export async function pgDeleteReportApprovedItems(shopId: number, vin: string): Promise<void> {
  const db = getDb();
  await db
    .delete(reportApprovedItems)
    .where(and(eq(reportApprovedItems.shopId, shopId), eq(reportApprovedItems.vin, vin.toUpperCase())));
}

/* -------------------------------------------------------------------------- */
/* remedied_deferred_work                                                      */
/* -------------------------------------------------------------------------- */

export async function pgListRemediedDeferredWork(
  shopId: number,
  vin: string,
): Promise<AnyDoc[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(remediedDeferredWork)
    .where(and(eq(remediedDeferredWork.shopId, shopId), eq(remediedDeferredWork.vin, vin.toUpperCase())));
  return rows.map((r) => ({
    ...((r.raw ?? {}) as AnyDoc),
    shopId: r.shopId,
    vin: r.vin,
    deferredId: r.deferredId,
    carfaxDate: r.carfaxDate,
    carfaxDescription: r.carfaxDescription,
    remediedAt: r.remediedAt,
  }));
}

export async function pgUpsertRemediedDeferredWork(doc: {
  shopId: number;
  vin: string;
  deferredId: string;
  carfaxDate?: string | null;
  carfaxDescription?: string | null;
  remediedAt: Date;
  [k: string]: unknown;
}): Promise<void> {
  const db = getDb();
  const values = {
    shopId: doc.shopId,
    vin: doc.vin.toUpperCase(),
    deferredId: doc.deferredId,
    carfaxDate: doc.carfaxDate ?? null,
    carfaxDescription: doc.carfaxDescription ?? null,
    remediedAt: doc.remediedAt,
    raw: doc,
  };
  await db
    .insert(remediedDeferredWork)
    .values(values)
    .onConflictDoUpdate({
      target: [remediedDeferredWork.shopId, remediedDeferredWork.vin, remediedDeferredWork.deferredId],
      set: { ...values },
    });
}
