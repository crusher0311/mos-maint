/**
 * Wave 2 (DB switchover task #343) — operational caches, queues, audit/notif,
 * external-API surface, and Tekmetric operational state Postgres tables.
 *
 * **Schema-only PR.** No reads have been switched yet and no Mongo writes
 * removed. This file lays down the destination tables so subsequent
 * sub-group cutover tasks (AI caches, Tekmetric op state, external-API
 * surface, audit/notifications, queues+drain_lock) can each ship a small,
 * coherent PR that flips reads + dual-writes to PG without re-arguing
 * column shapes.
 *
 * Conventions (carried over from `lib/db/schema/wave1.ts`):
 *   - Natural keys are the primary key wherever the Mongo collection has one
 *     (e.g. `(shop_id, vin)`, `slug`, `tekmetric_shop_id`). Append-only
 *     collections without a natural key get a `serial` `id` plus a
 *     `backfill_mongo_id text UNIQUE` column so the backfill upsert is
 *     idempotent on re-run.
 *   - Loose / heterogeneous Mongo shapes (queue items, dashboard payloads,
 *     audit details) are captured as `jsonb` rather than expanded into
 *     dozens of nullable columns. Indexed fields are pulled out as columns.
 *   - All timestamps are `timestamptz`.
 *
 * `tekmetric_drain_lock` is intentionally absent — it is being ported to a
 * PG advisory lock (`pg_try_advisory_lock`) at the same time as the
 * Tekmetric op-state cutover, so there is no destination table for it.
 *
 * See docs/db-migration-map.md §9 for the per-entity reader/writer map and
 * the cutover sub-group breakdown.
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

/* ========================================================================== */
/* AI / recommendation caches  (sub-group: ai-caches)                         */
/* These are caches: rebuild-on-miss is allowed, so the cutover does not      */
/* require a soak window. Backfill is a convenience, not a correctness gate. */
/* ========================================================================== */

/** `ai_analysis_cache` — per (shop, vin) recommended-services analysis blob. */
export const aiAnalysisCache = pgTable(
  "ai_analysis_cache",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    payload: jsonb("payload").notNull(),
    schemaVersion: integer("schema_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin] }),
  }),
);

/** `maintenance_analysis_cache` — per (shop, vin) maintenance plan cache. */
export const maintenanceAnalysisCache = pgTable(
  "maintenance_analysis_cache",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    recommendations: jsonb("recommendations").notNull().default([]),
    showInspectItems: jsonb("show_inspect_items"),
    mileageAtAnalysis: integer("mileage_at_analysis"),
    source: text("source"),
    schemaVersion: integer("schema_version"),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull().defaultNow(),
    raw: jsonb("raw"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin] }),
    shopAnalyzedIdx: index("maint_analysis_cache_shop_analyzed_idx").on(t.shopId, t.analyzedAt),
  }),
);

/** `ai_budget_alerts` — once-per-day per-shop 80% budget alert idempotency lock. */
export const aiBudgetAlerts = pgTable(
  "ai_budget_alerts",
  {
    alertKey: text("alert_key").primaryKey(), // `${shopId}:${YYYY-MM-DD}`
    shopId: integer("shop_id").notNull(),
    dayKey: text("day_key").notNull(),
    plan: text("plan").notNull(),
    threshold: doublePrecision("threshold").notNull(),
    usedAtAlert: doublePrecision("used_at_alert").notNull(),
    limit: doublePrecision("limit").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopDayIdx: index("ai_budget_alerts_shop_day_idx").on(t.shopId, t.dayKey),
  }),
);

/** `vhi_analysis_log` — append-only per-build VHI analysis record. */
export const vhiAnalysisLog = pgTable(
  "vhi_analysis_log",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    vin: text("vin").notNull(),
    shopId: integer("shop_id"),
    sms: text("sms"),
    smsShopId: text("sms_shop_id"),
    provider: text("provider"),
    roNumber: text("ro_number"),
    mileage: integer("mileage"),
    score: doublePrecision("score"),
    tier: text("tier"),
    summary: text("summary"),
    authorizedJobs: jsonb("authorized_jobs").notNull().default([]),
    triggeredBy: text("triggered_by"),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    vinAnalyzedIdx: index("vhi_analysis_log_vin_analyzed_idx").on(t.vin, t.analyzedAt),
    shopAnalyzedIdx: index("vhi_analysis_log_shop_analyzed_idx").on(t.shopId, t.analyzedAt),
    backfillUniq: uniqueIndex("vhi_analysis_log_backfill_uniq").on(t.backfillMongoId),
  }),
);

/** `concern_conversations` — concern-assistant chat threads. ID is the Mongo
 * ObjectId hex string because callers pass it back as `conversationId`. */
export const concernConversations = pgTable(
  "concern_conversations",
  {
    id: text("id").primaryKey(), // mirrors Mongo ObjectId hex
    shopId: integer("shop_id").notNull(),
    mosShopId: integer("mos_shop_id"),
    vin: text("vin"),
    userEmail: text("user_email"),
    concern: text("concern"),
    symptomCategory: text("symptom_category"),
    questions: jsonb("questions"),
    answeredQuestions: jsonb("answered_questions"),
    roundResults: jsonb("round_results"),
    review: jsonb("review"),
    injectedToProtractor: boolean("injected_to_protractor").notNull().default(false),
    // Task #1000: the concern-assistant Mongo doc is heterogeneous
    // (userId, vehicleDisplay, exchanges, status, source, cleanedText,
    // injectedAt/injectedTo/injectedWorkOrderId, …). The full doc is stored
    // verbatim in `payload` so the legacy shape survives the cutover; the
    // typed columns above back the indexed lookups.
    userId: text("user_id"),
    status: text("status"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopVinIdx: index("concern_conversations_shop_vin_idx").on(t.shopId, t.vin),
    createdIdx: index("concern_conversations_created_idx").on(t.createdAt),
    userUpdatedIdx: index("concern_conversations_user_updated_idx").on(t.userId, t.updatedAt),
  }),
);

/** `report_approved_items` — per (shop, vin) list of approved service keys. */
export const reportApprovedItems = pgTable(
  "report_approved_items",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    approvedServiceKeys: jsonb("approved_service_keys").notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin] }),
  }),
);

/** `remedied_deferred_work` — per (shop, vin, deferredId) Carfax-confirmed remediation. */
export const remediedDeferredWork = pgTable(
  "remedied_deferred_work",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    deferredId: text("deferred_id").notNull(),
    carfaxDate: text("carfax_date"),
    carfaxDescription: text("carfax_description"),
    remediedAt: timestamp("remedied_at", { withTimezone: true }).notNull().defaultNow(),
    raw: jsonb("raw"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin, t.deferredId] }),
    shopVinIdx: index("remedied_deferred_work_shop_vin_idx").on(t.shopId, t.vin),
  }),
);

/** `shop_repair_patterns` — learned per (shop, vehicle, mileage bucket, job)
 * repair patterns (Mongo `shop_repair_patterns`, see `lib/repair-patterns.ts`).
 *
 * Task #1000: the original wave2 stub (`pattern`/`serviceName`/`sampleCount`)
 * modelled a different concept than the collection the app actually writes.
 * The real doc is keyed by
 * `(shopId, year, make, model, mileageBucket, jobTitleNormalized)` and carries
 * rolling occurrence/labour/parts/hours aggregates plus a capped `vinsSeen`
 * array. The extra columns below (added idempotently in drizzle/0025) back the
 * PG-canonical reads/aggregates; the legacy stub columns are kept nullable for
 * backward compatibility. `pattern` is relaxed to nullable there too.
 */
export const shopRepairPatterns = pgTable(
  "shop_repair_patterns",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id").notNull(),
    pattern: text("pattern"),
    serviceName: text("service_name"),
    sampleCount: integer("sample_count").notNull().default(0),
    confidence: doublePrecision("confidence"),
    metadata: jsonb("metadata"),
    // Task #1000: natural-key + aggregate columns mirroring the Mongo doc.
    enterpriseId: text("enterprise_id"),
    year: integer("year"),
    make: text("make"),
    model: text("model"),
    mileageBucket: integer("mileage_bucket"),
    jobTitle: text("job_title"),
    jobTitleNormalized: text("job_title_normalized"),
    occurrences: integer("occurrences").notNull().default(0),
    totalLabor: doublePrecision("total_labor").notNull().default(0),
    totalParts: doublePrecision("total_parts").notNull().default(0),
    totalAmount: doublePrecision("total_amount").notNull().default(0),
    avgLabor: doublePrecision("avg_labor").notNull().default(0),
    avgParts: doublePrecision("avg_parts").notNull().default(0),
    avgTotal: doublePrecision("avg_total").notNull().default(0),
    avgHours: doublePrecision("avg_hours").notNull().default(0),
    lastPerformed: timestamp("last_performed", { withTimezone: true }),
    firstPerformed: timestamp("first_performed", { withTimezone: true }),
    vinsSeen: jsonb("vins_seen").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopPatternIdx: uniqueIndex("shop_repair_patterns_shop_pattern_uniq").on(t.shopId, t.pattern),
    backfillUniq: uniqueIndex("shop_repair_patterns_backfill_uniq").on(t.backfillMongoId),
    shopVehicleJobUniq: uniqueIndex("shop_repair_patterns_shop_vehicle_job_uniq").on(
      t.shopId,
      t.year,
      t.make,
      t.model,
      t.mileageBucket,
      t.jobTitleNormalized,
    ),
    enterpriseVehicleIdx: index("shop_repair_patterns_enterprise_vehicle_idx").on(
      t.enterpriseId,
      t.year,
      t.make,
      t.model,
      t.mileageBucket,
    ),
    shopTopIdx: index("shop_repair_patterns_shop_top_idx").on(t.shopId, t.occurrences),
  }),
);

/** `oem_schedules` — per-VIN OEM maintenance schedule cache. */
export const oemSchedules = pgTable(
  "oem_schedules",
  {
    vin: text("vin").primaryKey(),
    items: jsonb("items"),
    source: text("source"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    raw: jsonb("raw"),
  },
);

/** `oem_carfax_mappings` — admin-curated OEM→Carfax service-name lookup. */
export const oemCarfaxMappings = pgTable(
  "oem_carfax_mappings",
  {
    oemName: text("oem_name").primaryKey(),
    carfaxName: text("carfax_name").notNull(),
    category: text("category"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/* ========================================================================== */
/* External-API surface  (sub-group: external-api)                            */
/* Self-contained, single-writer per route. Append-only.                     */
/* ========================================================================== */

/** `external_api_appointments` — appointments booked via the external API. */
export const externalApiAppointments = pgTable(
  "external_api_appointments",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id").notNull(),
    externalId: text("external_id"),
    provider: text("provider").notNull(), // tekmetric | protractor
    customerId: text("customer_id"),
    customerName: text("customer_name"),
    vehicleId: text("vehicle_id"),
    vin: text("vin"),
    scheduledDate: text("scheduled_date"),
    scheduledTime: text("scheduled_time"),
    serviceType: text("service_type"),
    isDropOff: boolean("is_drop_off"),
    rideOption: text("ride_option"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopCreatedIdx: index("ext_api_appts_shop_created_idx").on(t.shopId, t.createdAt),
    backfillUniq: uniqueIndex("ext_api_appts_backfill_uniq").on(t.backfillMongoId),
  }),
);

/** `external_api_keytags` — keytag-generation requests via the external API. */
export const externalApiKeytags = pgTable(
  "external_api_keytags",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id").notNull(),
    vin: text("vin"),
    customerId: text("customer_id"),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopCreatedIdx: index("ext_api_keytags_shop_created_idx").on(t.shopId, t.createdAt),
    backfillUniq: uniqueIndex("ext_api_keytags_backfill_uniq").on(t.backfillMongoId),
  }),
);

/** `external_api_stickers` — sticker-generation requests via the external API. */
export const externalApiStickers = pgTable(
  "external_api_stickers",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id").notNull(),
    vin: text("vin"),
    customerId: text("customer_id"),
    customerName: text("customer_name"),
    vehicleYear: integer("vehicle_year"),
    vehicleMake: text("vehicle_make"),
    vehicleModel: text("vehicle_model"),
    currentMileage: integer("current_mileage"),
    nextServiceMileage: integer("next_service_mileage"),
    nextServiceDate: text("next_service_date"),
    oilType: text("oil_type"),
    oilBrand: text("oil_brand"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopCreatedIdx: index("ext_api_stickers_shop_created_idx").on(t.shopId, t.createdAt),
    backfillUniq: uniqueIndex("ext_api_stickers_backfill_uniq").on(t.backfillMongoId),
  }),
);

/** `sticker_generations` — append-only sticker-print analytics. */
export const stickerGenerations = pgTable(
  "sticker_generations",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    generatedBy: text("generated_by"),
    vin: text("vin"),
    vehicleYear: integer("vehicle_year"),
    vehicleMake: text("vehicle_make"),
    vehicleModel: text("vehicle_model"),
    size: text("size"),
    unit: text("unit"),
    source: text("source"), // dashboard | extension
  },
  (t) => ({
    shopGeneratedIdx: index("sticker_gen_shop_generated_idx").on(t.shopId, t.generatedAt),
    backfillUniq: uniqueIndex("sticker_gen_backfill_uniq").on(t.backfillMongoId),
  }),
);

/** `sticker_qr_scans` — append-only QR-scan beacon. */
export const stickerQrScans = pgTable(
  "sticker_qr_scans",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    referer: text("referer"),
  },
  (t) => ({
    shopScannedIdx: index("sticker_qr_shop_scanned_idx").on(t.shopId, t.scannedAt),
    backfillUniq: uniqueIndex("sticker_qr_backfill_uniq").on(t.backfillMongoId),
  }),
);

/** `shop_media` — per-shop media blobs (logo, qr_code) keyed by (shopId, type). */
export const shopMedia = pgTable(
  "shop_media",
  {
    shopId: integer("shop_id").notNull(),
    type: text("type").notNull(), // logo | qr_code
    dataUri: text("data_uri").notNull(),
    contentType: text("content_type"),
    hovercodeId: text("hovercode_id"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.type] }),
  }),
);

/* ========================================================================== */
/* Audit / notifications  (sub-group: audit-notif)                            */
/* Append-only logs and per-user notifications. Notifications need a stable   */
/* string id because the API URL exposes it (`/api/notifications/[id]`).     */
/* ========================================================================== */

/** `audit_logs` — legacy human-readable bulk audit rows. Free-form details. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    actorEmail: text("actor_email"),
    action: text("action"),
    targetShopId: text("target_shop_id"), // text because Mongo allows number | string
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actorCreatedIdx: index("audit_logs_actor_created_idx").on(t.actorEmail, t.createdAt),
    backfillUniq: uniqueIndex("audit_logs_backfill_uniq").on(t.backfillMongoId),
  }),
);

/** `admin_audit_logs` — structured admin actions. */
export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    action: text("action").notNull(),
    adminEmail: text("admin_email").notNull(),
    targetShopId: text("target_shop_id"),
    targetShopName: text("target_shop_name"),
    targetUserEmail: text("target_user_email"),
    details: jsonb("details"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    actionCreatedIdx: index("admin_audit_logs_action_created_idx").on(t.action, t.createdAt),
    adminCreatedIdx: index("admin_audit_logs_admin_created_idx").on(t.adminEmail, t.createdAt),
    targetShopCreatedIdx: index("admin_audit_logs_target_shop_created_idx").on(t.targetShopId, t.createdAt),
    backfillUniq: uniqueIndex("admin_audit_logs_backfill_uniq").on(t.backfillMongoId),
  }),
);

/** `notifications` — per-user inbox. ID is the Mongo ObjectId hex string so
 * the existing URL surface (`/api/notifications/[id]`) keeps working. */
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(), // mirrors Mongo ObjectId hex
    userId: text("user_id").notNull(),
    shopId: integer("shop_id"),
    type: text("type").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    link: text("link"),
    read: boolean("read").notNull().default(false),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index("notifications_user_created_idx").on(t.userId, t.createdAt),
    userUnreadIdx: index("notifications_user_unread_idx").on(t.userId, t.read),
    ticketIdIdx: index("notifications_ticket_id_idx").on(t.metadata),
  }),
);

/** `dashboard_updates` — singleton-ish heartbeat for dashboard cache busting.
 * Mongo uses a mix of `_id="lastUpdate"` and per-shop `{shopId}` docs. We
 * canonicalize on a single string key so both writers can target the same
 * table: the global heartbeat lives at `key='lastUpdate'`, per-shop rows at
 * `key='shop:<id>'`. The cutover PR is responsible for the rewrite. */
export const dashboardUpdates = pgTable(
  "dashboard_updates",
  {
    key: text("key").primaryKey(),
    shopId: integer("shop_id"),
    timestampMs: bigint("timestamp_ms", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/** `support_chat_sessions` — escalation-eligible knowledge-base chat threads. */
export const supportChatSessions = pgTable(
  "support_chat_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    userEmail: text("user_email").notNull(),
    shopId: integer("shop_id").notNull(),
    messages: jsonb("messages").notNull().default([]),
    resolved: boolean("resolved").notNull().default(false),
    escalatedToTicket: text("escalated_to_ticket"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userUpdatedIdx: index("support_chat_user_updated_idx").on(t.userEmail, t.updatedAt),
    shopUpdatedIdx: index("support_chat_shop_updated_idx").on(t.shopId, t.updatedAt),
    activeIdx: index("support_chat_active_idx").on(t.userEmail, t.shopId, t.resolved, t.updatedAt),
  }),
);

/* ========================================================================== */
/* Queues & locks  (sub-group: queues-locks)                                  */
/* These are candidates for SELECT … FOR UPDATE SKIP LOCKED rewrites at       */
/* cutover time, but for the schema landing we mirror the Mongo shape.        */
/* `tekmetric_drain_lock` is intentionally absent — it becomes a              */
/* `pg_try_advisory_lock(<int8>)` call, no table required.                    */
/* ========================================================================== */

/** `enrichment_queue` — per (shopId, vin) enrichment work item. */
export const enrichmentQueue = pgTable(
  "enrichment_queue",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    status: text("status").notNull().default("pending"), // pending | processing | completed | failed
    priority: integer("priority").notNull().default(1),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    oemFetched: boolean("oem_fetched"),
    carfaxFetched: boolean("carfax_fetched"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin] }),
    shopStatusIdx: index("enrichment_queue_shop_status_idx").on(t.shopId, t.status),
    pendingClaimIdx: index("enrichment_queue_pending_claim_idx").on(t.status, t.priority, t.createdAt),
  }),
);

/** `extension_prefetch_locks` — per-shop extension prefetch lock. */
export const extensionPrefetchLocks = pgTable(
  "extension_prefetch_locks",
  {
    shopId: integer("shop_id").primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/** `auto_booking_queue` — heterogeneous booking-queue items. ID is the Mongo
 * ObjectId hex (callers pass it back as `replacesBookingId`). The full shape
 * lives in `data jsonb` because the shop_id + status + scheduled fields are
 * the only ones the queries actually filter on. */
export const autoBookingQueue = pgTable(
  "auto_booking_queue",
  {
    id: text("id").primaryKey(), // mirrors Mongo ObjectId hex
    shopId: integer("shop_id").notNull(),
    status: text("status"),
    vin: text("vin"),
    customerId: text("customer_id"),
    vehicleId: text("vehicle_id"),
    scheduledDate: text("scheduled_date"),
    scheduledTime: text("scheduled_time"),
    serviceType: text("service_type"),
    externalAppointmentId: text("external_appointment_id"),
    provider: text("provider"),
    confirmationMode: text("confirmation_mode"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    data: jsonb("data").notNull(), // full original Mongo doc
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopStatusIdx: index("auto_booking_shop_status_idx").on(t.shopId, t.status),
    shopCreatedIdx: index("auto_booking_shop_created_idx").on(t.shopId, t.createdAt),
  }),
);

/* ========================================================================== */
/* Tekmetric operational state  (sub-group: tekmetric-op-state)               */
/* Every table here is single-writer (the Tekmetric backfill / webhook /      */
/* health crons), which is why it is the lowest-risk slice of W2.             */
/* ========================================================================== */

/** `tekmetric_backfill_progress` — per-shop backfill walk cursor + skipped-RO buffer. */
export const tekmetricBackfillProgress = pgTable(
  "tekmetric_backfill_progress",
  {
    shopId: integer("shop_id").primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    currentChunkEnd: timestamp("current_chunk_end", { withTimezone: true }),
    completed: boolean("completed").notNull().default(false),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    complete: boolean("complete"), // legacy flag, kept for parity with Mongo
    logicVersion: integer("logic_version"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    recentSkippedRos: jsonb("recent_skipped_ros").notNull().default([]),
    lastStaleSkippedRosArchivedAt: timestamp("last_stale_skipped_ros_archived_at", { withTimezone: true }),
    staleSkippedRosArchivedTotal: integer("stale_skipped_ros_archived_total").notNull().default(0),
    extra: jsonb("extra"), // catch-all for fields the cron writers grow over time
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/** `tekmetric_backfill_health_alerts` — once-per-shop stuck-shop alert idempotency. */
export const tekmetricBackfillHealthAlerts = pgTable(
  "tekmetric_backfill_health_alerts",
  {
    shopId: integer("shop_id").primaryKey(),
    firstAlertedAt: timestamp("first_alerted_at", { withTimezone: true }).notNull().defaultNow(),
    lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }).notNull().defaultNow(),
    alertCount: integer("alert_count").notNull().default(1),
    payload: jsonb("payload"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
);

/** `tekmetric_permfailed_ro_alerts` — once-per-shop permanently-failed RO alert. */
export const tekmetricPermfailedRoAlerts = pgTable(
  "tekmetric_permfailed_ro_alerts",
  {
    shopId: integer("shop_id").primaryKey(),
    name: text("name"),
    currentCount: integer("current_count").notNull().default(0),
    firstAlertedAt: timestamp("first_alerted_at", { withTimezone: true }).notNull().defaultNow(),
    lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
);

/** `tekmetric_skipped_ro_archive` — append-only postmortem of skipped ROs. */
export const tekmetricSkippedRoArchive = pgTable(
  "tekmetric_skipped_ro_archive",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id").notNull(),
    roId: text("ro_id").notNull(),
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
    stale: boolean("stale").notNull().default(false),
    permanentlyFailed: boolean("permanently_failed").notNull().default(false),
    reason: text("reason"),
    payload: jsonb("payload"),
  },
  (t) => ({
    shopArchivedIdx: index("tek_skipped_ro_shop_archived_idx").on(t.shopId, t.archivedAt),
    staleIdx: index("tek_skipped_ro_stale_idx").on(t.stale, t.archivedAt),
    backfillUniq: uniqueIndex("tek_skipped_ro_backfill_uniq").on(t.backfillMongoId),
  }),
);

/** `tekmetric_catchup_runs` — append-only per-cron-run catchup ledger. */
export const tekmetricCatchupRuns = pgTable(
  "tekmetric_catchup_runs",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    shopsProcessed: integer("shops_processed"),
    rosProcessed: integer("ros_processed"),
    success: boolean("success"),
    summary: jsonb("summary"),
  },
  (t) => ({
    startedIdx: index("tek_catchup_runs_started_idx").on(t.startedAt),
    backfillUniq: uniqueIndex("tek_catchup_runs_backfill_uniq").on(t.backfillMongoId),
  }),
);

/** `tekmetric_mileage_backfill_progress` — per-shop mileage-backfill cursor. */
export const tekmetricMileageBackfillProgress = pgTable(
  "tekmetric_mileage_backfill_progress",
  {
    shopId: integer("shop_id").primaryKey(),
    cursorRoId: text("cursor_ro_id"),
    completed: boolean("completed").notNull().default(false),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    rosUpdated: integer("ros_updated").notNull().default(0),
    extra: jsonb("extra"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/** `tekmetric_webhook_logs` — append-only Tekmetric webhook event log. */
export const tekmetricWebhookLogs = pgTable(
  "tekmetric_webhook_logs",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    tekmetricShopId: integer("tekmetric_shop_id"),
    mosShopId: integer("mos_shop_id"),
    eventType: text("event_type"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload"),
    processed: boolean("processed").notNull().default(false),
    processError: text("process_error"),
  },
  (t) => ({
    shopReceivedIdx: index("tek_webhook_logs_shop_received_idx").on(t.tekmetricShopId, t.receivedAt),
    eventTypeIdx: index("tek_webhook_logs_event_type_idx").on(t.eventType, t.receivedAt),
    backfillUniq: uniqueIndex("tek_webhook_logs_backfill_uniq").on(t.backfillMongoId),
  }),
);

/** `tekmetric_webhook_subscriptions` — per-Tekmetric-shop subscription state. */
export const tekmetricWebhookSubscriptions = pgTable(
  "tekmetric_webhook_subscriptions",
  {
    tekmetricShopId: integer("tekmetric_shop_id").primaryKey(),
    mosShopId: integer("mos_shop_id"),
    events: jsonb("events"),
    publicUrl: text("public_url"),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastResult: jsonb("last_result"),
  },
);

/** `tekmetric_webhook_health_alerts` — once-per (shop, day) silent-shop alert. */
export const tekmetricWebhookHealthAlerts = pgTable(
  "tekmetric_webhook_health_alerts",
  {
    tekmetricShopId: integer("tekmetric_shop_id").notNull(),
    alertDate: text("alert_date").notNull(), // YYYY-MM-DD UTC
    alertedAt: timestamp("alerted_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tekmetricShopId, t.alertDate] }),
  }),
);

/* ========================================================================== */
/* Misc  (sub-group: misc)                                                    */
/* ========================================================================== */

/** `platform_plans` — Stripe plan catalog. */
export const platformPlans = pgTable(
  "platform_plans",
  {
    slug: text("slug").primaryKey(),
    name: text("name"),
    monthlyPrice: doublePrecision("monthly_price"),
    annualPrice: doublePrecision("annual_price"),
    stripeMonthlyPriceId: text("stripe_monthly_price_id"),
    stripeAnnualPriceId: text("stripe_annual_price_id"),
    features: jsonb("features"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
