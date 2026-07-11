/**
 * Wave 1 (DB switchover task #342) Postgres repository.
 *
 * The reader files that used to call `db.collection(...)` for these
 * entities now call functions in this module. Mongo writes are still
 * issued by the original call sites (best-effort dual-write retained
 * until the per-entity 24–48h soak window passes — see
 * `docs/db-migration-map.md` §3.8).
 *
 * Lint note: this module imports the Drizzle PG handle, NOT the Mongo
 * one, so it is exempt from `scripts/check-direct-db.cjs`.
 */
// Server-only guard. Skipped when running under the Wave 1 backfill /
// parity scripts (which are Node CLIs, not Next.js server components).
if (!process.env.WAVE1_SCRIPT) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("server-only");
}
import {
  sql,
  and,
  or,
  eq,
  gt,
  gte,
  lte,
  isNull,
  desc,
  inArray,
  type InferSelectModel,
  type SQL,
} from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import {
  dataoneCache,
  dataoneOe,
  lkpYmmMaintenanceInterval,
  defMaintenanceEvent,
  dataoneLkpSquishMaintenance,
  partCrossRef,
  knowledgeArticles,
  viewedVins,
  syncMetrics,
  ingestionErrors,
  dataQualityReports,
  extensionAnalytics,
  systemAnnouncements,
  smsHistoricalWorkOrders,
  ratelimits,
} from "@/lib/db/schema/wave1";

export type KnowledgeArticleRow = InferSelectModel<typeof knowledgeArticles>;
export type AnnouncementRow = InferSelectModel<typeof systemAnnouncements>;
export type IngestionErrorRow = InferSelectModel<typeof ingestionErrors>;
export type SyncMetricRow = InferSelectModel<typeof syncMetrics>;
export type DataOneCacheRow = InferSelectModel<typeof dataoneCache>;
export type DataOneOeRow = InferSelectModel<typeof dataoneOe>;
export type PartCrossRefRow = InferSelectModel<typeof partCrossRef>;
export type LkpYmmMaintenanceIntervalRow = InferSelectModel<typeof lkpYmmMaintenanceInterval>;

const db = () => getDb();

/* -------------------------------------------------------------------------- */
/* ratelimits                                                                  */
/* -------------------------------------------------------------------------- */
export async function pgRateLimit(opts: {
  bucketKey: string;
  windowSeconds: number;
  expiresAt: Date;
}): Promise<number> {
  const rows = await db()
    .insert(ratelimits)
    .values({
      bucketKey: opts.bucketKey,
      count: 1,
      windowSeconds: opts.windowSeconds,
      expiresAt: opts.expiresAt,
    })
    .onConflictDoUpdate({
      target: ratelimits.bucketKey,
      set: { count: sql`${ratelimits.count} + 1` },
    })
    .returning({ count: ratelimits.count });
  return rows[0]?.count ?? 1;
}

/* -------------------------------------------------------------------------- */
/* viewed_vins                                                                 */
/* -------------------------------------------------------------------------- */
export async function pgTrackViewedVin(
  shopId: number,
  vin: string,
  roNumber: string | null,
): Promise<{ count: number; isNew: boolean }> {
  const normalizedVin = vin.toUpperCase();
  const roKey = roNumber ?? "";
  const now = new Date();

  const existing = await db()
    .select({ shopId: viewedVins.shopId })
    .from(viewedVins)
    .where(
      and(
        eq(viewedVins.shopId, shopId),
        eq(viewedVins.vin, normalizedVin),
        eq(viewedVins.roNumberKey, roKey),
      ),
    )
    .limit(1);
  const isNew = existing.length === 0;

  await db()
    .insert(viewedVins)
    .values({
      shopId,
      vin: normalizedVin,
      roNumber,
      roNumberKey: roKey,
      firstViewedAt: now,
      lastViewedAt: now,
      viewCount: 1,
    })
    .onConflictDoUpdate({
      target: [viewedVins.shopId, viewedVins.vin, viewedVins.roNumberKey],
      set: {
        lastViewedAt: now,
        viewCount: sql`${viewedVins.viewCount} + 1`,
      },
    });

  const [row] = await db()
    .select({ c: sql<number>`count(*)::int` })
    .from(viewedVins)
    .where(eq(viewedVins.shopId, shopId));
  return { count: Number(row?.c ?? 0), isNew };
}

export async function pgGetViewedVinCount(shopId: number): Promise<number> {
  const [row] = await db()
    .select({ c: sql<number>`count(*)::int` })
    .from(viewedVins)
    .where(eq(viewedVins.shopId, shopId));
  return Number(row?.c ?? 0);
}

export async function pgHasViewedVin(shopId: number, vin: string): Promise<boolean> {
  const [row] = await db()
    .select({ shopId: viewedVins.shopId })
    .from(viewedVins)
    .where(and(eq(viewedVins.shopId, shopId), eq(viewedVins.vin, vin.toUpperCase())))
    .limit(1);
  return !!row;
}

export async function pgCountViewedVinsBetween(
  startDate?: Date,
  endDate?: Date,
): Promise<number> {
  const conds: SQL[] = [];
  if (startDate) conds.push(gte(viewedVins.firstViewedAt, startDate));
  if (endDate) conds.push(lte(viewedVins.firstViewedAt, endDate));
  const [row] = await db()
    .select({ c: sql<number>`count(*)::int` })
    .from(viewedVins)
    .where(conds.length ? and(...conds) : sql`true`);
  return Number(row?.c ?? 0);
}

export async function pgViewedVinsAggregateByShop(): Promise<
  { shopId: number; count: number }[]
> {
  const rows = await db()
    .select({
      shopId: viewedVins.shopId,
      count: sql<number>`count(*)::int`,
    })
    .from(viewedVins)
    .groupBy(viewedVins.shopId);
  return rows.map((r) => ({ shopId: r.shopId, count: Number(r.count) }));
}

/* -------------------------------------------------------------------------- */
/* sync_metrics + ingestion_errors                                             */
/* -------------------------------------------------------------------------- */
export async function pgRecordSyncMetric(row: {
  workerType: string;
  shopId?: number | null;
  startedAt: Date;
  completedAt?: Date | null;
  durationMs?: number | null;
  success: boolean;
  error?: string | null;
  recordsProcessed?: number | null;
  recordsSkipped?: number | null;
  retryCount?: number | null;
}): Promise<void> {
  await db().insert(syncMetrics).values({
    workerType: row.workerType,
    shopId: row.shopId ?? null,
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? null,
    durationMs: row.durationMs ?? null,
    success: row.success,
    error: row.error ?? null,
    recordsProcessed: row.recordsProcessed ?? null,
    recordsSkipped: row.recordsSkipped ?? null,
    retryCount: row.retryCount ?? null,
  });
}

export async function pgUpsertIngestionError(row: {
  workerType: string;
  entityType: string;
  entityId: string;
  shopId?: number | null;
  error: string;
  rawData?: unknown;
}): Promise<void> {
  const now = new Date();
  await db()
    .insert(ingestionErrors)
    .values({
      workerType: row.workerType,
      entityType: row.entityType,
      entityId: row.entityId,
      shopId: row.shopId ?? null,
      error: row.error,
      rawData: row.rawData ?? null,
      retryCount: 1,
      resolved: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [ingestionErrors.workerType, ingestionErrors.entityType, ingestionErrors.entityId],
      set: {
        error: row.error,
        rawData: row.rawData ?? null,
        retryCount: sql`${ingestionErrors.retryCount} + 1`,
        updatedAt: now,
      },
    });
}

export async function pgResolveIngestionError(
  workerType: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  await db()
    .update(ingestionErrors)
    .set({ resolved: true, resolvedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(ingestionErrors.workerType, workerType),
        eq(ingestionErrors.entityType, entityType),
        eq(ingestionErrors.entityId, entityId),
      ),
    );
}

export async function pgListUnresolvedIngestionErrors(
  workerType?: string,
  limit = 100,
): Promise<IngestionErrorRow[]> {
  const where = workerType
    ? and(eq(ingestionErrors.resolved, false), eq(ingestionErrors.workerType, workerType))
    : eq(ingestionErrors.resolved, false);
  return db()
    .select()
    .from(ingestionErrors)
    .where(where)
    .orderBy(desc(ingestionErrors.createdAt))
    .limit(limit);
}

export async function pgSyncMetricsAggregate(
  workerType: string,
  sinceDays = 7,
): Promise<SyncMetricRow[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  return db()
    .select()
    .from(syncMetrics)
    .where(and(eq(syncMetrics.workerType, workerType), gte(syncMetrics.createdAt, since)))
    .orderBy(desc(syncMetrics.createdAt));
}

/**
 * Backfill-only ingestion error writer. Unlike `pgUpsertIngestionError`,
 * this preserves the source `resolved`/`retryCount`/timestamps from the
 * Mongo doc so re-running the backfill is idempotent and never resurrects
 * already-resolved errors.
 */
export async function pgBackfillIngestionError(row: {
  workerType: string;
  entityType: string;
  entityId: string;
  shopId?: number | null;
  error: string;
  rawData?: unknown;
  retryCount?: number;
  resolved?: boolean;
  resolvedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}): Promise<void> {
  const createdAt = row.createdAt ?? new Date();
  const updatedAt = row.updatedAt ?? createdAt;
  await db()
    .insert(ingestionErrors)
    .values({
      workerType: row.workerType,
      entityType: row.entityType,
      entityId: row.entityId,
      shopId: row.shopId ?? null,
      error: row.error,
      rawData: row.rawData ?? null,
      retryCount: row.retryCount ?? 0,
      resolved: row.resolved ?? false,
      resolvedAt: row.resolvedAt ?? null,
      createdAt,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [ingestionErrors.workerType, ingestionErrors.entityType, ingestionErrors.entityId],
      set: {
        error: row.error,
        rawData: row.rawData ?? null,
        retryCount: row.retryCount ?? 0,
        resolved: row.resolved ?? false,
        resolvedAt: row.resolvedAt ?? null,
        updatedAt,
      },
    });
}

/* -------------------------------------------------------------------------- */
/* extension_analytics                                                         */
/* -------------------------------------------------------------------------- */
export async function pgInsertExtensionAnalytics(row: {
  eventType: string;
  shopId: number;
  userId?: string;
  enterpriseId?: string;
  vin?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  jobTitle?: string;
  jobSource?: string;
  repairOrderId?: string;
  laborAmount?: number;
  partsAmount?: number;
  totalAmount?: number;
  timestamp?: Date;
}): Promise<void> {
  await db().insert(extensionAnalytics).values({
    eventType: row.eventType,
    shopId: row.shopId,
    userId: row.userId ?? null,
    enterpriseId: row.enterpriseId ?? null,
    vin: row.vin ?? null,
    vehicleYear: row.vehicleYear ?? null,
    vehicleMake: row.vehicleMake ?? null,
    vehicleModel: row.vehicleModel ?? null,
    jobTitle: row.jobTitle ?? null,
    jobSource: row.jobSource ?? null,
    repairOrderId: row.repairOrderId ?? null,
    laborAmount: row.laborAmount ?? null,
    partsAmount: row.partsAmount ?? null,
    totalAmount: row.totalAmount ?? null,
    timestamp: row.timestamp ?? new Date(),
  });
}

export async function pgPushToROStats(params: {
  shopId?: number;
  enterpriseId?: string;
  startDate?: Date;
  endDate?: Date;
}): Promise<{
  totalPushes: number;
  bySource: Record<string, number>;
  byDay: Array<{ date: string; count: number }>;
  topJobs: Array<{ jobTitle: string; count: number }>;
}> {
  const conds: SQL[] = [eq(extensionAnalytics.eventType, "push_to_ro")];
  if (params.shopId !== undefined) conds.push(eq(extensionAnalytics.shopId, params.shopId));
  if (params.enterpriseId) conds.push(eq(extensionAnalytics.enterpriseId, params.enterpriseId));
  if (params.startDate) conds.push(gte(extensionAnalytics.timestamp, params.startDate));
  if (params.endDate) conds.push(lte(extensionAnalytics.timestamp, params.endDate));
  const where = and(...conds);

  const [{ c: totalPushes }] = await db()
    .select({ c: sql<number>`count(*)::int` })
    .from(extensionAnalytics)
    .where(where);

  const bySourceRows = await db()
    .select({
      source: extensionAnalytics.jobSource,
      count: sql<number>`count(*)::int`,
    })
    .from(extensionAnalytics)
    .where(where)
    .groupBy(extensionAnalytics.jobSource);

  const byDayRows = await db()
    .select({
      day: sql<string>`to_char(${extensionAnalytics.timestamp}, 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(extensionAnalytics)
    .where(where)
    .groupBy(sql`to_char(${extensionAnalytics.timestamp}, 'YYYY-MM-DD')`)
    .orderBy(desc(sql`to_char(${extensionAnalytics.timestamp}, 'YYYY-MM-DD')`))
    .limit(30);

  const topJobsRows = await db()
    .select({
      jobTitle: extensionAnalytics.jobTitle,
      count: sql<number>`count(*)::int`,
    })
    .from(extensionAnalytics)
    .where(where)
    .groupBy(extensionAnalytics.jobTitle)
    .orderBy(desc(sql`count(*)`))
    .limit(20);

  const bySource: Record<string, number> = {};
  for (const r of bySourceRows) bySource[r.source ?? "unknown"] = Number(r.count);

  return {
    totalPushes: Number(totalPushes ?? 0),
    bySource,
    byDay: byDayRows.map((r) => ({ date: r.day, count: Number(r.count) })),
    topJobs: topJobsRows
      .filter((r) => r.jobTitle)
      .map((r) => ({ jobTitle: r.jobTitle as string, count: Number(r.count) })),
  };
}

/* -------------------------------------------------------------------------- */
/* data_quality_reports                                                        */
/* -------------------------------------------------------------------------- */
export async function pgInsertDataQualityReport(row: {
  shopId: number;
  shopName?: string;
  report: unknown;
  cleanupResult?: unknown;
  runType?: string;
}): Promise<void> {
  await db().insert(dataQualityReports).values({
    shopId: row.shopId,
    shopName: row.shopName ?? null,
    report: row.report,
    cleanupResult: row.cleanupResult ?? null,
    runType: row.runType ?? "automated",
  });
}

/* -------------------------------------------------------------------------- */
/* system_announcements                                                        */
/* -------------------------------------------------------------------------- */
export async function pgInsertAnnouncement(row: {
  id: string;
  title: string;
  message: string;
  priority: string;
  target: unknown;
  deliveryChannels: unknown;
  status: string;
  createdBy: string;
  createdAt?: Date;
  sentAt?: Date | null;
  expiresAt?: Date | null;
  stats?: unknown;
}): Promise<void> {
  await db()
    .insert(systemAnnouncements)
    .values({
      id: row.id,
      title: row.title,
      message: row.message,
      priority: row.priority,
      target: row.target,
      deliveryChannels: row.deliveryChannels,
      status: row.status,
      createdBy: row.createdBy,
      createdAt: row.createdAt ?? new Date(),
      sentAt: row.sentAt ?? null,
      expiresAt: row.expiresAt ?? null,
      stats: row.stats ?? null,
    })
    .onConflictDoNothing();
}

export type AnnouncementListOptions = {
  status?: string;
  /** Only return announcements with `expiresAt IS NULL OR expiresAt > now`. */
  notExpiredAt?: Date;
  /** "createdAt" | "sentAt" — defaults to "createdAt". */
  sortField?: "createdAt" | "sentAt";
  /** "asc" | "desc" — defaults to "desc". */
  sortDirection?: "asc" | "desc";
};

export async function pgListAnnouncements(
  limit: number,
  opts: AnnouncementListOptions | string = {},
): Promise<AnnouncementRow[]> {
  // Backwards-compat shim: callers used to pass a status string directly.
  const o: AnnouncementListOptions = typeof opts === "string" ? { status: opts } : opts;
  const conds = [];
  if (o.status) conds.push(eq(systemAnnouncements.status, o.status));
  if (o.notExpiredAt) {
    conds.push(
      or(
        isNull(systemAnnouncements.expiresAt),
        gt(systemAnnouncements.expiresAt, o.notExpiredAt),
      )!,
    );
  }
  const sortCol =
    o.sortField === "sentAt" ? systemAnnouncements.sentAt : systemAnnouncements.createdAt;
  const sortExpr = o.sortDirection === "asc" ? sortCol : desc(sortCol);
  return db()
    .select()
    .from(systemAnnouncements)
    .where(conds.length ? and(...conds) : sql`true`)
    .orderBy(sortExpr)
    .limit(limit);
}

export async function pgFindAnnouncement(id: string): Promise<AnnouncementRow | null> {
  const [row] = await db()
    .select()
    .from(systemAnnouncements)
    .where(eq(systemAnnouncements.id, id))
    .limit(1);
  return row ?? null;
}

export async function pgUpdateAnnouncement(
  id: string,
  set: Partial<AnnouncementRow>,
): Promise<void> {
  await db().update(systemAnnouncements).set(set).where(eq(systemAnnouncements.id, id));
}

export async function pgDeleteAnnouncement(id: string): Promise<void> {
  await db().delete(systemAnnouncements).where(eq(systemAnnouncements.id, id));
}

/* -------------------------------------------------------------------------- */
/* knowledge_articles                                                          */
/* -------------------------------------------------------------------------- */
export async function pgInsertArticle(row: {
  id: string;
  title: string;
  problem: string;
  solution: string;
  category: string;
  tags: string[];
  sourceTicketId?: string | null;
  embedding?: number[] | null;
  createdBy: string;
  viewCount?: number;
  helpfulCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
}): Promise<void> {
  await db()
    .insert(knowledgeArticles)
    .values({
      id: row.id,
      title: row.title,
      problem: row.problem,
      solution: row.solution,
      category: row.category,
      tags: row.tags,
      sourceTicketId: row.sourceTicketId ?? null,
      embedding: row.embedding ?? null,
      createdBy: row.createdBy,
      viewCount: row.viewCount ?? 0,
      helpfulCount: row.helpfulCount ?? 0,
      createdAt: row.createdAt ?? new Date(),
      updatedAt: row.updatedAt ?? new Date(),
    })
    .onConflictDoNothing();
}

export async function pgFindArticle(id: string): Promise<KnowledgeArticleRow | null> {
  const [row] = await db()
    .select()
    .from(knowledgeArticles)
    .where(eq(knowledgeArticles.id, id))
    .limit(1);
  return row ?? null;
}

export async function pgListTopArticles(limit: number): Promise<KnowledgeArticleRow[]> {
  return db()
    .select()
    .from(knowledgeArticles)
    .orderBy(desc(knowledgeArticles.helpfulCount), desc(knowledgeArticles.viewCount))
    .limit(limit);
}

export async function pgListAllArticles(limit: number, skip: number): Promise<KnowledgeArticleRow[]> {
  return db()
    .select()
    .from(knowledgeArticles)
    .orderBy(desc(knowledgeArticles.updatedAt))
    .limit(limit)
    .offset(skip);
}

export async function pgListArticlesByCategory(category: string): Promise<KnowledgeArticleRow[]> {
  return db()
    .select()
    .from(knowledgeArticles)
    .where(eq(knowledgeArticles.category, category))
    .orderBy(desc(knowledgeArticles.helpfulCount));
}

export async function pgSearchArticleCandidates(
  searchTerms: string[],
  limit: number,
): Promise<KnowledgeArticleRow[]> {
  if (searchTerms.length === 0) return [];
  // ILIKE-OR across title/problem/solution/category + tag inclusion, mirroring
  // the Mongo $regex / $in semantics. The leading-wildcard `ILIKE '%term%'`
  // predicate cannot use a b-tree index, so on its own it seq-scans
  // knowledge_articles. The pg_trgm `gin_trgm_ops` indexes shipped in
  // drizzle/0021_task758_kb_search_trgm.sql (and mirrored in
  // scripts/apply-normalized-migration.ts) let the planner serve these ILIKEs
  // with a Bitmap Index Scan instead — the same fix applied to job-search.
  // Terms shorter than 3 chars fall back to a scan (no trigram), which is fine.
  const escaped = searchTerms.map((t) => t.replace(/[%_]/g, (c) => `\\${c}`));
  const likeClauses = escaped
    .map((t) => sql`(${knowledgeArticles.title} ILIKE ${"%" + t + "%"}
       OR ${knowledgeArticles.problem} ILIKE ${"%" + t + "%"}
       OR ${knowledgeArticles.solution} ILIKE ${"%" + t + "%"}
       OR ${knowledgeArticles.category} ILIKE ${"%" + t + "%"}
       OR ${knowledgeArticles.tags}::jsonb ? ${t})`)
    .reduce((acc, cur) => sql`${acc} OR ${cur}`);
  return db().select().from(knowledgeArticles).where(likeClauses).limit(limit);
}

export async function pgIncrementArticleView(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db()
    .update(knowledgeArticles)
    .set({ viewCount: sql`${knowledgeArticles.viewCount} + 1` })
    .where(inArray(knowledgeArticles.id, ids));
}

export async function pgIncrementArticleHelpful(id: string): Promise<void> {
  await db()
    .update(knowledgeArticles)
    .set({ helpfulCount: sql`${knowledgeArticles.helpfulCount} + 1` })
    .where(eq(knowledgeArticles.id, id));
}

export async function pgUpdateArticle(
  id: string,
  set: Partial<KnowledgeArticleRow>,
): Promise<boolean> {
  const rows = await db()
    .update(knowledgeArticles)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(knowledgeArticles.id, id))
    .returning({ id: knowledgeArticles.id });
  return rows.length > 0;
}

export async function pgDeleteArticle(id: string): Promise<boolean> {
  const rows = await db()
    .delete(knowledgeArticles)
    .where(eq(knowledgeArticles.id, id))
    .returning({ id: knowledgeArticles.id });
  return rows.length > 0;
}

export async function pgCountArticles(): Promise<number> {
  const [row] = await db().select({ c: sql<number>`count(*)::int` }).from(knowledgeArticles);
  return Number(row?.c ?? 0);
}

export async function pgDistinctArticleCategories(): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ category: knowledgeArticles.category })
    .from(knowledgeArticles);
  return rows.map((r) => r.category);
}

/* -------------------------------------------------------------------------- */
/* dataone_cache                                                               */
/* -------------------------------------------------------------------------- */
export async function pgFindDataOneCache(squish: string): Promise<DataOneCacheRow | null> {
  const [row] = await db()
    .select()
    .from(dataoneCache)
    .where(eq(dataoneCache.squish, squish))
    .limit(1);
  return row ?? null;
}

export async function pgUpsertDataOneCache(row: {
  squish: string;
  vin: string;
  data: unknown;
  vehicle: unknown;
  fetchedAt: Date;
  expiresAt: Date;
  source: string;
}): Promise<void> {
  await db()
    .insert(dataoneCache)
    .values(row)
    .onConflictDoUpdate({
      target: dataoneCache.squish,
      set: {
        vin: row.vin,
        data: row.data,
        vehicle: row.vehicle,
        fetchedAt: row.fetchedAt,
        expiresAt: row.expiresAt,
        source: row.source,
      },
    });
}

export async function pgDeleteDataOneCache(squish: string): Promise<boolean> {
  const rows = await db()
    .delete(dataoneCache)
    .where(eq(dataoneCache.squish, squish))
    .returning({ squish: dataoneCache.squish });
  return rows.length > 0;
}

export async function pgDataOneCacheStats(): Promise<{
  totalCached: number;
  expiredCount: number;
}> {
  const [t] = await db().select({ c: sql<number>`count(*)::int` }).from(dataoneCache);
  const [e] = await db()
    .select({ c: sql<number>`count(*)::int` })
    .from(dataoneCache)
    .where(lte(dataoneCache.expiresAt, new Date()));
  return { totalCached: Number(t?.c ?? 0), expiredCount: Number(e?.c ?? 0) };
}

/* -------------------------------------------------------------------------- */
/* dataone_oe                                                                  */
/* -------------------------------------------------------------------------- */
export async function pgFindDataOneOe(shopId: number, vin: string): Promise<DataOneOeRow | null> {
  const [row] = await db()
    .select()
    .from(dataoneOe)
    .where(and(eq(dataoneOe.shopId, shopId), eq(dataoneOe.vin, vin)))
    .limit(1);
  return row ?? null;
}

export async function pgUpsertDataOneOe(row: {
  shopId: number;
  vin: string;
  items: unknown;
  mileageUsed: number | null;
  ok: boolean;
  error: string | null;
  raw: unknown;
  source: string;
  fetchedAt: Date;
}): Promise<void> {
  await db()
    .insert(dataoneOe)
    .values({ ...row, createdAt: row.fetchedAt })
    .onConflictDoUpdate({
      target: [dataoneOe.shopId, dataoneOe.vin],
      set: {
        items: row.items,
        mileageUsed: row.mileageUsed,
        ok: row.ok,
        error: row.error,
        raw: row.raw,
        source: row.source,
        fetchedAt: row.fetchedAt,
      },
    });
}

/* -------------------------------------------------------------------------- */
/* lkp_ymm_maintenance_interval + def_maintenance_event                        */
/* -------------------------------------------------------------------------- */
export async function pgFindYmmMaintenanceIntervals(
  year?: number,
  make?: string,
  model?: string,
  trim?: string,
  limit = 5000,
): Promise<LkpYmmMaintenanceIntervalRow[]> {
  const conds = [];
  if (year !== undefined) conds.push(eq(lkpYmmMaintenanceInterval.year, year));
  if (make) conds.push(eq(lkpYmmMaintenanceInterval.make, make));
  if (model) conds.push(eq(lkpYmmMaintenanceInterval.model, model));
  if (trim) conds.push(eq(lkpYmmMaintenanceInterval.trim, trim));
  return db()
    .select()
    .from(lkpYmmMaintenanceInterval)
    .where(conds.length ? and(...conds) : sql`true`)
    .limit(limit);
}

export async function pgFindAllDefMaintenanceEvents(): Promise<
  { eventCode: string; description: string | null }[]
> {
  return db()
    .select({
      eventCode: defMaintenanceEvent.eventCode,
      description: defMaintenanceEvent.description,
    })
    .from(defMaintenanceEvent);
}

/* -------------------------------------------------------------------------- */
/* dataone_lkp_squish_maintenance — squish→OE schedule lookup                  */
/* -------------------------------------------------------------------------- */
export async function pgFindSquishMaintenance(
  squish: string,
): Promise<{ vinMaintenanceId: number; maintenanceId: number }[]> {
  return db()
    .select({
      vinMaintenanceId: dataoneLkpSquishMaintenance.vinMaintenanceId,
      maintenanceId: dataoneLkpSquishMaintenance.maintenanceId,
    })
    .from(dataoneLkpSquishMaintenance)
    .where(eq(dataoneLkpSquishMaintenance.squish, squish));
}

/* -------------------------------------------------------------------------- */
/* part_cross_ref                                                              */
/* -------------------------------------------------------------------------- */
export async function pgCountPartCrossRef(shopId: number): Promise<number> {
  const [row] = await db()
    .select({ c: sql<number>`count(*)::int` })
    .from(partCrossRef)
    .where(eq(partCrossRef.shopId, shopId));
  return Number(row?.c ?? 0);
}

export async function pgFindPartCrossRef(
  shopId: number,
  normalizedPartNumber: string,
): Promise<PartCrossRefRow | null> {
  const [row] = await db()
    .select()
    .from(partCrossRef)
    .where(
      and(
        eq(partCrossRef.shopId, shopId),
        eq(partCrossRef.normalizedPartNumber, normalizedPartNumber),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function pgUpsertPartCrossRef(row: {
  shopId: number;
  normalizedPartNumber: string;
  partNumber: string;
  description?: string | null;
  manufacturer?: string | null;
  usedOn: unknown[];
  workOrderIds: string[];
  newUsageCount: number;
}): Promise<void> {
  const now = new Date();
  // Merge logic in SQL: union of jsonb arrays + count.
  await db()
    .insert(partCrossRef)
    .values({
      shopId: row.shopId,
      normalizedPartNumber: row.normalizedPartNumber,
      partNumber: row.partNumber,
      description: row.description ?? null,
      manufacturer: row.manufacturer ?? null,
      usedOn: row.usedOn,
      crossReferences: [],
      workOrderIds: row.workOrderIds,
      usageCount: Math.max(row.newUsageCount, 1),
      lastUsedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [partCrossRef.shopId, partCrossRef.normalizedPartNumber],
      set: {
        partNumber: row.partNumber,
        description: row.description ?? null,
        manufacturer: row.manufacturer ?? null,
        usedOn: sql`(
          SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
          FROM jsonb_array_elements(${partCrossRef.usedOn} || ${JSON.stringify(row.usedOn)}::jsonb) AS v
        )`,
        workOrderIds: sql`(
          SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
          FROM jsonb_array_elements(${partCrossRef.workOrderIds} || ${JSON.stringify(row.workOrderIds)}::jsonb) AS v
        )`,
        usageCount: sql`${partCrossRef.usageCount} + ${row.newUsageCount}`,
        lastUsedAt: now,
        updatedAt: now,
      },
    });
}

/**
 * Search part_cross_ref by part-number / description / vehicle filters.
 * Wave 1 read path for app/api/parts/search/route.ts.
 */
export async function pgSearchPartCrossRef(opts: {
  shopId: number;
  query?: string;
  make?: string;
  model?: string;
  year?: number;
  limit: number;
}): Promise<PartCrossRefRow[]> {
  const conds: SQL[] = [eq(partCrossRef.shopId, opts.shopId)];

  if (opts.query) {
    const normalizedQuery = opts.query.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    const likeRaw = `%${opts.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const likeNorm = `%${normalizedQuery.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(
      or(
        sql`${partCrossRef.normalizedPartNumber} ILIKE ${likeNorm}`,
        sql`${partCrossRef.partNumber} ILIKE ${likeRaw}`,
        sql`COALESCE(${partCrossRef.description}, '') ILIKE ${likeRaw}`,
      )!,
    );
  }

  // Vehicle filters live inside the `usedOn` jsonb array. We use an
  // EXISTS-over-jsonb_array_elements pattern so each predicate matches
  // the SAME element, mirroring Mongo's "usedOn.*" semantics.
  if (opts.make || opts.model || opts.year !== undefined) {
    const sub: SQL[] = [];
    if (opts.year !== undefined) {
      sub.push(sql`(elem->>'year')::int = ${opts.year}`);
    }
    if (opts.make) {
      sub.push(sql`LOWER(elem->>'make') LIKE ${"%" + opts.make.toLowerCase() + "%"}`);
    }
    if (opts.model) {
      sub.push(sql`LOWER(elem->>'model') LIKE ${"%" + opts.model.toLowerCase() + "%"}`);
    }
    conds.push(
      sql`EXISTS (
        SELECT 1 FROM jsonb_array_elements(${partCrossRef.usedOn}) elem
        WHERE ${sql.join(sub, sql` AND `)}
      )`,
    );
  }

  return db()
    .select()
    .from(partCrossRef)
    .where(and(...conds))
    .orderBy(desc(partCrossRef.usageCount), desc(partCrossRef.lastUsedAt))
    .limit(opts.limit);
}

/**
 * Find parts compatible with a given (year, make, model) for a shop.
 * Wave 1 read path for app/api/parts/compatible/route.ts. Make/model
 * matched case-insensitively to mirror the legacy ^…$ regex.
 */
export async function pgFindCompatibleParts(opts: {
  shopId: number;
  year: number;
  make: string;
  model: string;
  limit: number;
}): Promise<PartCrossRefRow[]> {
  return db()
    .select()
    .from(partCrossRef)
    .where(
      and(
        eq(partCrossRef.shopId, opts.shopId),
        sql`EXISTS (
          SELECT 1 FROM jsonb_array_elements(${partCrossRef.usedOn}) elem
          WHERE (elem->>'year')::int = ${opts.year}
            AND LOWER(elem->>'make') = ${opts.make.toLowerCase()}
            AND LOWER(elem->>'model') = ${opts.model.toLowerCase()}
        )`,
      ),
    )
    .orderBy(desc(partCrossRef.usageCount))
    .limit(opts.limit);
}

/* -------------------------------------------------------------------------- */
/* sms_historical_work_orders                                                  */
/* -------------------------------------------------------------------------- */
/**
 * Set/replace part_cross_ref writer. Unlike `pgUpsertPartCrossRef` (which
 * MERGES arrays and INCREMENTS `usageCount` for live ingestion), this
 * helper SETS `usageCount` to the absolute value and REPLACES the arrays.
 *
 * Use it whenever the caller already has the absolute aggregated state for
 * a (shopId, normalizedPartNumber) — e.g. the Mongo→PG backfill, or the
 * "build parts database" rebuild route which scans all work orders and
 * computes totals from scratch. Re-running is idempotent.
 *
 * The legacy name `pgBackfillPartCrossRef` is kept as a re-export for the
 * one-shot Mongo backfill script.
 */
export async function pgSetPartCrossRef(row: {
  shopId: number;
  normalizedPartNumber: string;
  partNumber: string;
  description?: string | null;
  manufacturer?: string | null;
  usedOn: unknown[];
  crossReferences?: unknown[];
  workOrderIds: string[];
  usageCount: number;
  lastUsedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}): Promise<void> {
  const now = new Date();
  await db()
    .insert(partCrossRef)
    .values({
      shopId: row.shopId,
      normalizedPartNumber: row.normalizedPartNumber,
      partNumber: row.partNumber,
      description: row.description ?? null,
      manufacturer: row.manufacturer ?? null,
      usedOn: row.usedOn,
      crossReferences: row.crossReferences ?? [],
      workOrderIds: row.workOrderIds,
      usageCount: row.usageCount,
      lastUsedAt: row.lastUsedAt ?? null,
      createdAt: row.createdAt ?? now,
      updatedAt: row.updatedAt ?? now,
    })
    .onConflictDoUpdate({
      target: [partCrossRef.shopId, partCrossRef.normalizedPartNumber],
      set: {
        partNumber: row.partNumber,
        description: row.description ?? null,
        manufacturer: row.manufacturer ?? null,
        usedOn: row.usedOn,
        crossReferences: row.crossReferences ?? [],
        workOrderIds: row.workOrderIds,
        usageCount: row.usageCount,
        lastUsedAt: row.lastUsedAt ?? null,
        updatedAt: row.updatedAt ?? now,
      },
    });
}

/** @deprecated Backward-compat alias for the Mongo→PG backfill script.
 *  Prefer `pgSetPartCrossRef` in new code. */
export const pgBackfillPartCrossRef = pgSetPartCrossRef;

export async function pgUpsertSmsHistoricalWorkOrder(row: {
  shopId: number;
  sourceSystem: string;
  workOrderId: string;
  workOrderNumber?: string | null;
  closedAt?: Date | null;
  data: unknown;
}): Promise<void> {
  const now = new Date();
  await db()
    .insert(smsHistoricalWorkOrders)
    .values({
      shopId: row.shopId,
      sourceSystem: row.sourceSystem,
      workOrderId: row.workOrderId,
      workOrderNumber: row.workOrderNumber ?? null,
      closedAt: row.closedAt ?? null,
      data: row.data,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        smsHistoricalWorkOrders.shopId,
        smsHistoricalWorkOrders.sourceSystem,
        smsHistoricalWorkOrders.workOrderId,
      ],
      set: {
        workOrderNumber: row.workOrderNumber ?? null,
        closedAt: row.closedAt ?? null,
        data: row.data,
        updatedAt: now,
      },
    });
}
