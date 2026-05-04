/**
 * Wave 1 (DB switchover task #342) — reference & leaf data Postgres tables.
 *
 * One Drizzle schema file per cutover wave keeps the migration story
 * easy to follow. Tables here are deliberately flat — `jsonb` is only
 * used where the Mongo doc is genuinely heterogeneous (e.g. announcement
 * targets, data-quality reports, dataone API payloads).
 *
 * See docs/db-migration-map.md §3.4 / §3.8 for the entity list and the
 * reader/writer call sites.
 */
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  doublePrecision,
  jsonb,
  timestamp,
  serial,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/* DataOne API response cache (was Mongo `dataone_cache`)                      */
/* -------------------------------------------------------------------------- */
export const dataoneCache = pgTable(
  "dataone_cache",
  {
    squish: text("squish").primaryKey(),
    vin: text("vin").notNull(),
    data: jsonb("data").notNull(), // { ok, count, items[], error? }
    vehicle: jsonb("vehicle"), // CachedVehicleInfo
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(), // "api" | "cache"
  },
  (t) => ({
    expiresIdx: index("dataone_cache_expires_idx").on(t.expiresAt),
  }),
);

/* -------------------------------------------------------------------------- */
/* DataOne OE snapshot per shop+vin (was Mongo `dataone_oe`)                   */
/* -------------------------------------------------------------------------- */
export const dataoneOe = pgTable(
  "dataone_oe",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    items: jsonb("items"),
    mileageUsed: integer("mileage_used"),
    ok: boolean("ok").notNull().default(false),
    error: text("error"),
    raw: jsonb("raw"),
    source: text("source"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin] }),
  }),
);

/* -------------------------------------------------------------------------- */
/* Legacy denormalized DataOne maintenance tables (Mongo dump v1).             */
/* These collections shipped before the normalized DataOne PG ETL and have a   */
/* DIFFERENT schema than the `dataone_*` tables loaded by                      */
/* scripts/dataone-postgres-import.ts. We keep them as 1:1 column mirrors so   */
/* lib/evidence.ts can switch its read path without rewriting the field map.   */
/* -------------------------------------------------------------------------- */
export const lkpYmmMaintenanceInterval = pgTable(
  "lkp_ymm_maintenance_interval",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"), // nullable; populated by backfill, used as ON CONFLICT key for re-runs
    year: integer("year"),
    make: text("make"),
    model: text("model"),
    trim: text("trim"),
    eventCode: text("event_code"),
    description: text("description"),
    mileageInterval: integer("mileage_interval"),
    timeIntervalMonths: integer("time_interval_months"),
    firstDueMiles: integer("first_due_miles"),
    firstDueMonths: integer("first_due_months"),
    oemNotes: text("oem_notes"),
    raw: jsonb("raw"), // any extra columns we don't model explicitly
  },
  (t) => ({
    ymmIdx: index("lkp_ymm_maint_int_ymm_idx").on(t.year, t.make, t.model),
    ymmTrimIdx: index("lkp_ymm_maint_int_ymm_trim_idx").on(t.year, t.make, t.model, t.trim),
    backfillUniq: uniqueIndex("lkp_ymm_maint_int_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const defMaintenanceEvent = pgTable("def_maintenance_event", {
  eventCode: text("event_code").primaryKey(),
  description: text("description"),
  raw: jsonb("raw"),
});

/* -------------------------------------------------------------------------- */
/* DataOne squish→maintenance lookup (was Mongo `dataone_lkp_squish_maintenance`)
/* Used by app/api/recommended/analyze-stream/route.ts.                        */
/* -------------------------------------------------------------------------- */
export const dataoneLkpSquishMaintenance = pgTable(
  "dataone_lkp_squish_maintenance",
  {
    id: serial("id").primaryKey(),
    squish: text("squish").notNull(),
    vinMaintenanceId: integer("vin_maintenance_id").notNull(),
    maintenanceId: integer("maintenance_id").notNull(),
  },
  (t) => ({
    squishIdx: index("dataone_lkp_squish_maint_squish_idx").on(t.squish),
    uniq: uniqueIndex("dataone_lkp_squish_maint_uniq").on(
      t.squish,
      t.vinMaintenanceId,
      t.maintenanceId,
    ),
  }),
);

/* -------------------------------------------------------------------------- */
/* Part cross references (was Mongo `part_cross_ref`) — lib/job-index.ts       */
/* -------------------------------------------------------------------------- */
export const partCrossRef = pgTable(
  "part_cross_ref",
  {
    shopId: integer("shop_id").notNull(),
    normalizedPartNumber: text("normalized_part_number").notNull(),
    partNumber: text("part_number").notNull(),
    description: text("description"),
    manufacturer: text("manufacturer"),
    usedOn: jsonb("used_on").notNull().default([]),
    crossReferences: jsonb("cross_references").notNull().default([]),
    workOrderIds: jsonb("work_order_ids").notNull().default([]),
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.normalizedPartNumber] }),
    shopPartIdx: index("part_cross_ref_shop_part_idx").on(t.shopId, t.partNumber),
  }),
);

/* -------------------------------------------------------------------------- */
/* Knowledge base articles (was Mongo `knowledge_articles`)                    */
/* -------------------------------------------------------------------------- */
export const knowledgeArticles = pgTable(
  "knowledge_articles",
  {
    id: text("id").primaryKey(), // mirrors Mongo ObjectId hex string
    title: text("title").notNull(),
    problem: text("problem").notNull(),
    solution: text("solution").notNull(),
    category: text("category").notNull(),
    tags: jsonb("tags").notNull().default([]),
    sourceTicketId: text("source_ticket_id"),
    embedding: jsonb("embedding"),
    createdBy: text("created_by").notNull(),
    viewCount: integer("view_count").notNull().default(0),
    helpfulCount: integer("helpful_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    catIdx: index("knowledge_articles_category_idx").on(t.category),
    rankIdx: index("knowledge_articles_rank_idx").on(t.helpfulCount, t.viewCount),
  }),
);

/* -------------------------------------------------------------------------- */
/* Viewed VINs counter (was Mongo `viewed_vins`)                               */
/* -------------------------------------------------------------------------- */
export const viewedVins = pgTable(
  "viewed_vins",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    roNumber: text("ro_number"), // nullable; part of unique key (NULLS NOT DISTINCT in PG 15+; we coalesce)
    roNumberKey: text("ro_number_key").notNull(), // coalesced "" when null — for unique constraint
    firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }).notNull().defaultNow(),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }).notNull().defaultNow(),
    viewCount: integer("view_count").notNull().default(1),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin, t.roNumberKey] }),
    shopFirstViewedIdx: index("viewed_vins_shop_first_viewed_idx").on(t.shopId, t.firstViewedAt),
  }),
);

/* -------------------------------------------------------------------------- */
/* Sync metrics (was Mongo `sync_metrics`)                                     */
/* -------------------------------------------------------------------------- */
export const syncMetrics = pgTable(
  "sync_metrics",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    workerType: text("worker_type").notNull(),
    shopId: integer("shop_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    success: boolean("success").notNull(),
    error: text("error"),
    recordsProcessed: integer("records_processed"),
    recordsSkipped: integer("records_skipped"),
    retryCount: integer("retry_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workerTypeIdx: index("sync_metrics_worker_type_idx").on(t.workerType, t.createdAt),
    backfillUniq: uniqueIndex("sync_metrics_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* -------------------------------------------------------------------------- */
/* Ingestion errors (was Mongo `ingestion_errors`)                             */
/* -------------------------------------------------------------------------- */
export const ingestionErrors = pgTable(
  "ingestion_errors",
  {
    workerType: text("worker_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    shopId: integer("shop_id"),
    error: text("error").notNull(),
    rawData: jsonb("raw_data"),
    retryCount: integer("retry_count").notNull().default(0),
    resolved: boolean("resolved").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workerType, t.entityType, t.entityId] }),
    unresolvedIdx: index("ingestion_errors_unresolved_idx").on(t.resolved, t.createdAt),
  }),
);

/* -------------------------------------------------------------------------- */
/* Data quality reports (was Mongo `data_quality_reports`)                     */
/* -------------------------------------------------------------------------- */
export const dataQualityReports = pgTable(
  "data_quality_reports",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id").notNull(),
    shopName: text("shop_name"),
    report: jsonb("report").notNull(),
    cleanupResult: jsonb("cleanup_result"),
    runType: text("run_type").notNull().default("automated"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopIdx: index("data_quality_reports_shop_idx").on(t.shopId, t.createdAt),
    backfillUniq: uniqueIndex("data_quality_reports_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* -------------------------------------------------------------------------- */
/* Extension analytics (was Mongo `extension_analytics`)                       */
/* -------------------------------------------------------------------------- */
export const extensionAnalytics = pgTable(
  "extension_analytics",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    eventType: text("event_type").notNull(),
    shopId: integer("shop_id").notNull(),
    userId: text("user_id"),
    enterpriseId: text("enterprise_id"),
    vin: text("vin"),
    vehicleYear: integer("vehicle_year"),
    vehicleMake: text("vehicle_make"),
    vehicleModel: text("vehicle_model"),
    jobTitle: text("job_title"),
    jobSource: text("job_source"),
    repairOrderId: text("repair_order_id"),
    laborAmount: doublePrecision("labor_amount"),
    partsAmount: doublePrecision("parts_amount"),
    totalAmount: doublePrecision("total_amount"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopTsIdx: index("extension_analytics_shop_ts_idx").on(t.shopId, t.timestamp),
    eventTypeIdx: index("extension_analytics_event_type_idx").on(t.eventType, t.timestamp),
    enterpriseIdx: index("extension_analytics_enterprise_idx").on(t.enterpriseId, t.timestamp),
    backfillUniq: uniqueIndex("extension_analytics_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* -------------------------------------------------------------------------- */
/* System announcements (was Mongo `system_announcements`)                     */
/* -------------------------------------------------------------------------- */
export const systemAnnouncements = pgTable(
  "system_announcements",
  {
    id: text("id").primaryKey(), // mirrors Mongo ObjectId hex
    title: text("title").notNull(),
    message: text("message").notNull(),
    priority: text("priority").notNull(), // info | warning | critical
    target: jsonb("target").notNull(), // { type, shopIds?, roles?, smsIntegrations? }
    deliveryChannels: jsonb("delivery_channels").notNull(), // { inApp, email }
    status: text("status").notNull(), // draft | sent | scheduled
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    stats: jsonb("stats"),
  },
  (t) => ({
    statusSentIdx: index("system_announcements_status_sent_idx").on(t.status, t.sentAt),
  }),
);

/* -------------------------------------------------------------------------- */
/* SMS historical work orders (was Mongo `sms_historical_work_orders`)         */
/* Backfill scratch space — fully heterogeneous, store the doc as jsonb.       */
/* -------------------------------------------------------------------------- */
export const smsHistoricalWorkOrders = pgTable(
  "sms_historical_work_orders",
  {
    shopId: integer("shop_id").notNull(),
    sourceSystem: text("source_system").notNull(),
    workOrderId: text("work_order_id").notNull(),
    workOrderNumber: text("work_order_number"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.sourceSystem, t.workOrderId] }),
    shopClosedIdx: index("sms_hist_wo_shop_closed_idx").on(t.shopId, t.closedAt),
  }),
);

/* -------------------------------------------------------------------------- */
/* Rate limits (was Mongo `ratelimits`)                                        */
/* `bucketKey` is `${id}:${windowBucket}` — naturally unique. Cleanup by       */
/* `expires_at` (a small lazy-delete hook in lib/rate.ts is fine).             */
/* -------------------------------------------------------------------------- */
export const ratelimits = pgTable(
  "ratelimits",
  {
    bucketKey: text("bucket_key").primaryKey(),
    count: integer("count").notNull().default(0),
    windowSeconds: integer("window_seconds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresIdx: index("ratelimits_expires_idx").on(t.expiresAt),
  }),
);
