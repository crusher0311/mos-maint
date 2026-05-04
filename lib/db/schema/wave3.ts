/**
 * Wave 3b (DB switchover task #345) — integration source-of-truth mirrors,
 * the legacy pre-normalized layer, plan/recommendation caches, the audit
 * `events` log, `api_keys`, `counters`, the `job_index` family, and Carfax.
 *
 * **Schema-only landing for the bulk of these.** Per-integration soak
 * windows (Tekmetric / Protractor / Shopware / Autoflow / Autovitals)
 * happen in follow-up tasks: schema lands here so the per-group cutover
 * tasks ship a small, focused PR that flips reads + dual-writes without
 * re-arguing column shapes. The end-to-end cutovers that DO ship in
 * #345 are `counters`, `api_keys` (+ `api_usage_logs`), and `events`.
 *
 * Conventions (carried over from `wave1.ts` / `wave2.ts`):
 *   - Natural keys are the primary key wherever the Mongo collection has
 *     one (e.g. `(shop_id, ro_id)`, `(shop_id, vin)`,
 *     `(tekmetric_shop_id)`). Append-only collections without a natural
 *     key get a `serial id` plus a `backfill_mongo_id text UNIQUE` so the
 *     backfill upsert is idempotent on re-run.
 *   - Heterogeneous Mongo shapes (cached API payloads, webhook events,
 *     plan blobs) are captured as `jsonb` rather than expanded into
 *     dozens of nullable columns. Indexed lookup fields are pulled out
 *     as columns alongside the `payload` jsonb.
 *   - All timestamps are `timestamptz`.
 *
 * See `docs/db-migration-map.md` §3.3 / §3.5 / §3.6 / §3.7 for the
 * per-entity reader/writer map and the cutover sub-group breakdown.
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
/* Counters / sequences  (sub-group: counters — END-TO-END in #345)           */
/* ========================================================================== */

/**
 * `counters` (Mongo) → `pg_counters` (Postgres).
 *
 * Mongo doc shape: `{ _id: "shopId", seq: <int> }`.
 *
 * Atomic next-value via `UPDATE pg_counters SET seq = seq + 1 WHERE name
 * = $1 RETURNING seq` (callers should `INSERT ... ON CONFLICT DO NOTHING`
 * with `seq = 0` first to seed). This replaces `lib/ids.ts`'s
 * `findOneAndUpdate({ $inc: { seq: 1 } })`.
 */
export const pgCounters = pgTable("pg_counters", {
  name: text("name").primaryKey(),
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/* ========================================================================== */
/* api_keys  (sub-group: api-keys — END-TO-END in #345)                       */
/* ========================================================================== */

/** `api_keys` — per-shop API credentials, hashed. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(), // ObjectId-as-string for legacy callers
    shopId: integer("shop_id").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    name: text("name").notNull(),
    permissions: jsonb("permissions").notNull().default([]),
    rateLimit: integer("rate_limit").notNull(),
    rateLimitTier: text("rate_limit_tier"),
    isActive: boolean("is_active").notNull().default(true),
    revoked: boolean("revoked").notNull().default(false),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    usageCount: integer("usage_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    isPartner: boolean("is_partner").notNull().default(false),
    partnerId: text("partner_id"),
    partnerName: text("partner_name"),
  },
  (t) => ({
    keyHashUniq: uniqueIndex("api_keys_key_hash_uniq").on(t.keyHash),
    shopIdx: index("api_keys_shop_idx").on(t.shopId),
  }),
);

/**
 * `api_usage_logs` (Mongo) — per-request append-only log.
 *
 * Note: there is *also* an `api_usage_logs` Postgres table owned by
 * `lib/db/schema/rescue-rover` (now removed). To avoid colliding with
 * any leftover migration state, this one is named
 * `external_api_usage_logs`.
 */
export const externalApiUsageLogs = pgTable(
  "external_api_usage_logs",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    keyHash: text("key_hash").notNull(),
    shopId: integer("shop_id").notNull(),
    endpoint: text("endpoint").notNull(),
    method: text("method").notNull(),
    statusCode: integer("status_code").notNull(),
    responseTime: integer("response_time").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    ip: text("ip"),
  },
  (t) => ({
    keyHashTsIdx: index("ext_api_usage_logs_key_ts_idx").on(t.keyHash, t.timestamp),
    shopTsIdx: index("ext_api_usage_logs_shop_ts_idx").on(t.shopId, t.timestamp),
    backfillUniq: uniqueIndex("ext_api_usage_logs_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* ========================================================================== */
/* events  (sub-group: events — END-TO-END in #345)                           */
/* ========================================================================== */

/**
 * `events` — append-only firehose for AutoFlow webhook payloads + a
 * handful of UI-emitted markers. Read by `lib/evidence.ts` and the
 * dashboard list views.
 */
export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    provider: text("provider"),
    event: text("event"),
    type: text("type"),
    shopId: text("shop_id"), // shopId is sometimes string, sometimes number in mongo
    vehicleVin: text("vehicle_vin"),
    vin: text("vin"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload"),
  },
  (t) => ({
    shopReceivedIdx: index("events_shop_received_idx").on(t.shopId, t.receivedAt),
    vinReceivedIdx: index("events_vin_received_idx").on(t.vin, t.receivedAt),
    providerEventIdx: index("events_provider_event_idx").on(t.provider, t.event, t.receivedAt),
    backfillUniq: uniqueIndex("events_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* ========================================================================== */
/* Tekmetric mirrors  (sub-group: tekmetric — schema-only)                    */
/* ========================================================================== */

export const tekmetricWorkOrders = pgTable(
  "tekmetric_work_orders",
  {
    shopId: integer("shop_id").notNull(),
    workOrderId: text("work_order_id").notNull(), // tekmetric numeric id as text
    repairOrderNumber: integer("repair_order_number"),
    status: text("status"),
    vin: text("vin"),
    customerId: text("customer_id"),
    vehicleId: text("vehicle_id"),
    completedDate: timestamp("completed_date", { withTimezone: true }),
    postedDate: timestamp("posted_date", { withTimezone: true }),
    updatedDate: timestamp("updated_date", { withTimezone: true }),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.workOrderId] }),
    shopUpdatedIdx: index("tek_wo_shop_updated_idx").on(t.shopId, t.updatedDate),
    shopRoNumberIdx: index("tek_wo_shop_ro_idx").on(t.shopId, t.repairOrderNumber),
    vinIdx: index("tek_wo_vin_idx").on(t.vin),
  }),
);

export const tekmetricRepairOrders = pgTable(
  "tekmetric_repair_orders",
  {
    shopId: integer("shop_id").notNull(),
    repairOrderId: text("repair_order_id").notNull(),
    repairOrderNumber: integer("repair_order_number"),
    status: text("status"),
    vin: text("vin"),
    completedDate: timestamp("completed_date", { withTimezone: true }),
    updatedDate: timestamp("updated_date", { withTimezone: true }),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.repairOrderId] }),
    shopUpdatedIdx: index("tek_ro_shop_updated_idx").on(t.shopId, t.updatedDate),
  }),
);

export const tekmetricVehicles = pgTable(
  "tekmetric_vehicles",
  {
    shopId: integer("shop_id").notNull(),
    vehicleId: text("vehicle_id").notNull(),
    vin: text("vin"),
    customerId: text("customer_id"),
    year: integer("year"),
    make: text("make"),
    model: text("model"),
    payload: jsonb("payload").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vehicleId] }),
    shopVinIdx: index("tek_veh_shop_vin_idx").on(t.shopId, t.vin),
  }),
);

/** Per-shop vehicle cache keyed by VIN (separate from `tekmetric_vehicles`). */
export const tekmetricVehicleCache = pgTable(
  "tekmetric_vehicle_cache",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin] }),
  }),
);

export const tekmetricCustomerCache = pgTable(
  "tekmetric_customer_cache",
  {
    shopId: integer("shop_id").notNull(),
    customerId: text("customer_id").notNull(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.customerId] }),
  }),
);

/** Per-shop pre-warmed jobs cache (variable shapes — payload-only). */
export const tekmetricJobsCache = pgTable(
  "tekmetric_jobs_cache",
  {
    shopId: integer("shop_id").notNull(),
    cacheKey: text("cache_key").notNull(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.cacheKey] }),
    cachedAtIdx: index("tek_jobs_cache_cached_at_idx").on(t.cachedAt),
  }),
);

export const tekmetricCannedJobsCache = pgTable(
  "tekmetric_canned_jobs_cache",
  {
    shopId: integer("shop_id").primaryKey(),
    items: jsonb("items").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source"),
  },
);

/** Tekmetric OAuth tokens — security-sensitive, narrow shape. */
export const tekmetricTokens = pgTable(
  "tekmetric_tokens",
  {
    shopId: integer("shop_id").primaryKey(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    tokenType: text("token_type"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    scope: text("scope"),
    raw: jsonb("raw"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/** Tekmetric daily/per-shop API usage counters. */
export const tekmetricApiUsage = pgTable(
  "tekmetric_api_usage",
  {
    shopId: integer("shop_id").notNull(),
    dayKey: text("day_key").notNull(), // YYYY-MM-DD UTC
    requests: integer("requests").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    breakdown: jsonb("breakdown"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.dayKey] }),
  }),
);

/* ========================================================================== */
/* Protractor mirrors  (sub-group: protractor — schema-only)                  */
/* ========================================================================== */

export const protractorWorkOrders = pgTable(
  "protractor_work_orders",
  {
    shopId: integer("shop_id").notNull(),
    workOrderId: text("work_order_id").notNull(),
    workOrderGuid: text("work_order_guid"),
    workOrderNumber: integer("work_order_number"),
    type: text("type"),
    status: text("status"),
    vin: text("vin"),
    serviceItemId: text("service_item_id"),
    contactId: text("contact_id"),
    odometer: integer("odometer"),
    workflowStage: text("workflow_stage"),
    completed: boolean("completed"),
    scheduledTime: text("scheduled_time"),
    promisedTime: text("promised_time"),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.workOrderId] }),
    shopRoNumberIdx: index("pro_wo_shop_ronum_idx").on(t.shopId, t.workOrderNumber),
    serviceItemIdx: index("pro_wo_service_item_idx").on(t.shopId, t.serviceItemId),
    vinIdx: index("pro_wo_vin_idx").on(t.vin),
  }),
);

export const protractorInvoices = pgTable(
  "protractor_invoices",
  {
    shopId: integer("shop_id").notNull(),
    invoiceId: text("invoice_id").notNull(),
    invoiceNumber: integer("invoice_number"),
    vin: text("vin"),
    completedDate: timestamp("completed_date", { withTimezone: true }),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.invoiceId] }),
    shopVinIdx: index("pro_inv_shop_vin_idx").on(t.shopId, t.vin),
  }),
);

export const protractorInvoiceCache = pgTable(
  "protractor_invoice_cache",
  {
    shopId: integer("shop_id").notNull(),
    invoiceId: text("invoice_id").notNull(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.invoiceId] }),
    cachedAtIdx: index("pro_inv_cache_cached_at_idx").on(t.cachedAt),
  }),
);

export const protractorVehicles = pgTable(
  "protractor_vehicles",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    protractorId: text("protractor_id"),
    year: integer("year"),
    make: text("make"),
    model: text("model"),
    odometer: integer("odometer"),
    odometerDate: text("odometer_date"),
    licensePlate: text("license_plate"),
    ownerId: text("owner_id"),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin] }),
  }),
);

export const protractorCannedJobs = pgTable(
  "protractor_canned_jobs",
  {
    shopId: integer("shop_id").primaryKey(),
    items: jsonb("items").notNull().default([]),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const protractorCannedJobsCache = pgTable(
  "protractor_canned_jobs_cache",
  {
    shopId: integer("shop_id").notNull(),
    cacheKey: text("cache_key").notNull(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.cacheKey] }),
  }),
);

export const protractorRoCache = pgTable(
  "protractor_ro_cache",
  {
    shopId: integer("shop_id").notNull(),
    cacheKey: text("cache_key").notNull(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.cacheKey] }),
    cachedAtIdx: index("pro_ro_cache_cached_at_idx").on(t.cachedAt),
  }),
);

export const protractorTemplateCache = pgTable(
  "protractor_template_cache",
  {
    shopId: integer("shop_id").notNull(),
    templateId: text("template_id").notNull(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.templateId] }),
  }),
);

export const protractorServiceItems = pgTable(
  "protractor_service_items",
  {
    shopId: integer("shop_id").notNull(),
    serviceItemId: text("service_item_id").notNull(),
    vin: text("vin"),
    contactId: text("contact_id"),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.serviceItemId] }),
    shopVinIdx: index("pro_si_shop_vin_idx").on(t.shopId, t.vin),
  }),
);

export const protractorDeferredWork = pgTable(
  "protractor_deferred_work",
  {
    shopId: integer("shop_id").notNull(),
    deferredWorkId: text("deferred_work_id").notNull(),
    serviceItemId: text("service_item_id"),
    vin: text("vin"),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.deferredWorkId] }),
    shopVinIdx: index("pro_def_shop_vin_idx").on(t.shopId, t.vin),
  }),
);

export const protractorCallbackEvents = pgTable(
  "protractor_callback_events",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    callbackToken: text("callback_token"),
    eventType: text("event_type"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload"),
    processed: boolean("processed").notNull().default(false),
  },
  (t) => ({
    shopReceivedIdx: index("pro_cb_shop_received_idx").on(t.shopId, t.receivedAt),
    backfillUniq: uniqueIndex("pro_cb_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* ========================================================================== */
/* Shopware mirrors  (sub-group: shopware — schema-only)                      */
/* ========================================================================== */

export const shopwareRepairOrders = pgTable(
  "shopware_repair_orders",
  {
    mosShopId: integer("mos_shop_id").notNull(),
    roId: integer("ro_id").notNull(),
    tenantId: integer("tenant_id"),
    swShopId: integer("sw_shop_id"),
    number: integer("number"),
    state: text("state"),
    vin: text("vin"),
    customerId: integer("customer_id"),
    vehicleId: integer("vehicle_id"),
    customerName: text("customer_name"),
    vehicleYear: integer("vehicle_year"),
    vehicleMake: text("vehicle_make"),
    vehicleModel: text("vehicle_model"),
    odometer: integer("odometer"),
    serviceCount: integer("service_count"),
    createdAtSrc: timestamp("created_at_src", { withTimezone: true }),
    updatedAtSrc: timestamp("updated_at_src", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    deleted: boolean("deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedViaWebhook: boolean("deleted_via_webhook"),
    partialFromWebhook: boolean("partial_from_webhook"),
    fetchError: text("fetch_error"),
    raw: jsonb("raw"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.mosShopId, t.roId] }),
    shopUpdatedIdx: index("sw_ro_shop_updated_idx").on(t.mosShopId, t.updatedAtSrc),
    shopVinIdx: index("sw_ro_shop_vin_idx").on(t.mosShopId, t.vin),
  }),
);

export const shopwareVehicles = pgTable(
  "shopware_vehicles",
  {
    mosShopId: integer("mos_shop_id").notNull(),
    vehicleId: integer("vehicle_id").notNull(),
    vin: text("vin"),
    year: integer("year"),
    make: text("make"),
    model: text("model"),
    customerId: integer("customer_id"),
    payload: jsonb("payload").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.mosShopId, t.vehicleId] }),
    shopVinIdx: index("sw_veh_shop_vin_idx").on(t.mosShopId, t.vin),
  }),
);

export const shopwareCustomers = pgTable(
  "shopware_customers",
  {
    mosShopId: integer("mos_shop_id").notNull(),
    customerId: integer("customer_id").notNull(),
    name: text("name"),
    payload: jsonb("payload").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.mosShopId, t.customerId] }),
  }),
);

export const shopwareBackfillProgress = pgTable(
  "shopware_backfill_progress",
  {
    mosShopId: integer("mos_shop_id").primaryKey(),
    cursor: jsonb("cursor"),
    completed: boolean("completed").notNull().default(false),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    rosProcessed: integer("ros_processed").notNull().default(0),
    extra: jsonb("extra"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const shopwareWebhookLogs = pgTable(
  "shopware_webhook_logs",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    mosShopId: integer("mos_shop_id"),
    swShopId: integer("sw_shop_id"),
    eventType: text("event_type"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload"),
    processed: boolean("processed").notNull().default(false),
    processError: text("process_error"),
  },
  (t) => ({
    shopReceivedIdx: index("sw_webhook_shop_received_idx").on(t.mosShopId, t.receivedAt),
    backfillUniq: uniqueIndex("sw_webhook_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* ========================================================================== */
/* Autoflow mirrors  (sub-group: autoflow — schema-only)                      */
/* ========================================================================== */

export const autoflowCredentials = pgTable(
  "autoflow_credentials",
  {
    shopId: integer("shop_id").primaryKey(),
    apiBase: text("api_base"),
    apiKeyEnc: text("api_key_enc"),
    apiPasswordEnc: text("api_password_enc"),
    payload: jsonb("payload"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const autoflowDviItems = pgTable(
  "autoflow_dvi_items",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id").notNull(),
    dviId: text("dvi_id"),
    itemId: text("item_id"),
    vin: text("vin"),
    label: text("label"),
    severity: text("severity"),
    note: text("note"),
    payload: jsonb("payload"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopVinIdx: index("af_dvi_items_shop_vin_idx").on(t.shopId, t.vin),
    vinIdx: index("af_dvi_items_vin_idx").on(t.vin),
    backfillUniq: uniqueIndex("af_dvi_items_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const autoflowEvents = pgTable(
  "autoflow_events",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    eventType: text("event_type"),
    vin: text("vin"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload"),
  },
  (t) => ({
    shopReceivedIdx: index("af_events_shop_received_idx").on(t.shopId, t.receivedAt),
    backfillUniq: uniqueIndex("af_events_backfill_uniq").on(t.backfillMongoId),
  }),
);

/** `af_open` — open AutoFlow ticket roll-up by shop. */
export const afOpen = pgTable(
  "af_open",
  {
    shopId: integer("shop_id").notNull(),
    roNumber: text("ro_number").notNull(),
    payload: jsonb("payload").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.roNumber] }),
  }),
);

/* ========================================================================== */
/* Autovitals mirrors  (sub-group: autovitals — schema-only)                  */
/* ========================================================================== */

export const autovitalsVehicles = pgTable(
  "autovitals_vehicles",
  {
    shopId: text("shop_id").notNull(), // shopId stored as string in mongo
    vehicleId: integer("vehicle_id").notNull(),
    vin: text("vin"),
    year: integer("year"),
    make: text("make"),
    model: text("model"),
    mileage: integer("mileage"),
    licensePlate: text("license_plate"),
    color: text("color"),
    customerId: integer("customer_id"),
    customerName: text("customer_name"),
    payload: jsonb("payload"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vehicleId] }),
    shopVinIdx: index("av_veh_shop_vin_idx").on(t.shopId, t.vin),
  }),
);

export const autovitalsAppointments = pgTable(
  "autovitals_appointments",
  {
    shopId: text("shop_id").notNull(),
    appointmentId: integer("appointment_id").notNull(),
    vehicleId: integer("vehicle_id"),
    vin: text("vin"),
    customerId: integer("customer_id"),
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"),
    status: text("status"),
    promisedTime: text("promised_time"),
    serviceAdvisorId: integer("service_advisor_id"),
    technicianId: integer("technician_id"),
    concern: text("concern"),
    mileageIn: integer("mileage_in"),
    payload: jsonb("payload"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.appointmentId] }),
    shopVehicleIdx: index("av_appt_shop_vehicle_idx").on(t.shopId, t.vehicleId),
  }),
);

export const autovitalsInspections = pgTable(
  "autovitals_inspections",
  {
    shopId: text("shop_id").notNull(),
    appointmentId: integer("appointment_id").notNull(),
    inspectionResultId: integer("inspection_result_id"),
    completedAt: text("completed_at"),
    technicianId: integer("technician_id"),
    technicianName: text("technician_name"),
    items: jsonb("items"),
    payload: jsonb("payload"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.appointmentId] }),
  }),
);

export const autovitalsImports = pgTable(
  "autovitals_imports",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: text("shop_id"),
    importType: text("import_type"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    success: boolean("success"),
    summary: jsonb("summary"),
    payload: jsonb("payload"),
  },
  (t) => ({
    shopStartedIdx: index("av_imports_shop_started_idx").on(t.shopId, t.startedAt),
    backfillUniq: uniqueIndex("av_imports_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* ========================================================================== */
/* Pre-normalized layer  (sub-group: pre-normalized — schema-only).           */
/* These tables exist for the "port one-for-one" fallback. The preferred      */
/* path is to migrate readers to `normalized_*` and drop these — see the      */
/* per-reader decision table in docs/db-migration-map.md §3.6.                */
/* ========================================================================== */

export const preNormalizedRepairOrders = pgTable(
  "pre_normalized_repair_orders",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    roNumber: text("ro_number"),
    vin: text("vin"),
    customerId: text("customer_id"),
    status: text("status"),
    mileage: integer("mileage"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopRoIdx: index("pre_ro_shop_ro_idx").on(t.shopId, t.roNumber),
    shopVinIdx: index("pre_ro_shop_vin_idx").on(t.shopId, t.vin),
    backfillUniq: uniqueIndex("pre_ro_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const preNormalizedVehicles = pgTable(
  "pre_normalized_vehicles",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    vin: text("vin"),
    year: integer("year"),
    make: text("make"),
    model: text("model"),
    trim: text("trim"),
    lastMileage: integer("last_mileage"),
    declined: jsonb("declined"),
    components: jsonb("components"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopVinIdx: index("pre_veh_shop_vin_idx").on(t.shopId, t.vin),
    backfillUniq: uniqueIndex("pre_veh_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const preNormalizedCustomers = pgTable(
  "pre_normalized_customers",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: text("shop_id"),
    name: text("name"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    externalId: text("external_id"),
    status: text("status"),
    provider: text("provider"),
    lastVin: text("last_vin"),
    lastRo: text("last_ro"),
    lastMileage: integer("last_mileage"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopExternalIdx: index("pre_cust_shop_ext_idx").on(t.shopId, t.externalId),
    shopPhoneIdx: index("pre_cust_shop_phone_idx").on(t.shopId, t.phone),
    backfillUniq: uniqueIndex("pre_cust_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const preNormalizedManualVehicles = pgTable(
  "pre_normalized_manual_vehicles",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    vin: text("vin"),
    year: integer("year"),
    make: text("make"),
    model: text("model"),
    enteredBy: text("entered_by"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopVinIdx: index("pre_man_veh_shop_vin_idx").on(t.shopId, t.vin),
    backfillUniq: uniqueIndex("pre_man_veh_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* ========================================================================== */
/* DVI / canned jobs (Mongo `dvi`, `dvi_results`, `canned_jobs`,              */
/* `canned_job_applications`) — schema-only                                   */
/* ========================================================================== */

export const dvi = pgTable(
  "dvi",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    roNumber: text("ro_number"),
    vin: text("vin"),
    sheetId: text("sheet_id"),
    mileage: integer("mileage"),
    ok: boolean("ok"),
    empty: boolean("empty"),
    error: text("error"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    notes: text("notes"),
    customer: jsonb("customer"),
    vehicle: jsonb("vehicle"),
    lines: jsonb("lines"),
    raw: jsonb("raw"),
    source: text("source"),
  },
  (t) => ({
    shopRoIdx: index("dvi_shop_ro_idx").on(t.shopId, t.roNumber),
    vinIdx: index("dvi_vin_idx").on(t.vin),
    backfillUniq: uniqueIndex("dvi_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const dviResults = pgTable(
  "dvi_results",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    dviId: text("dvi_id"),
    roNumber: text("ro_number"),
    vin: text("vin"),
    payload: jsonb("payload"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopRoIdx: index("dvi_results_shop_ro_idx").on(t.shopId, t.roNumber),
    backfillUniq: uniqueIndex("dvi_results_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const cannedJobs = pgTable(
  "canned_jobs",
  {
    shopId: integer("shop_id").notNull(),
    cannedJobId: text("canned_job_id").notNull(),
    title: text("title"),
    code: text("code"),
    payload: jsonb("payload").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.cannedJobId] }),
  }),
);

export const cannedJobApplications = pgTable(
  "canned_job_applications",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    cannedJobId: text("canned_job_id"),
    vin: text("vin"),
    roNumber: text("ro_number"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload"),
  },
  (t) => ({
    shopAppliedIdx: index("cja_shop_applied_idx").on(t.shopId, t.appliedAt),
    backfillUniq: uniqueIndex("cja_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* ========================================================================== */
/* Plan / recommendation caches  (sub-group: plan-caches — schema-only)       */
/* All of these are caches: rebuild-on-miss is allowed, so cutover does not   */
/* require a long soak. Backfill is convenience, not correctness.             */
/* ========================================================================== */

export const plans = pgTable(
  "plans",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    vin: text("vin"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopVinIdx: index("plans_shop_vin_idx").on(t.shopId, t.vin),
    backfillUniq: uniqueIndex("plans_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const planCache = pgTable(
  "plan_cache",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin] }),
    expiresIdx: index("plan_cache_expires_idx").on(t.expiresAt),
  }),
);

export const planPrefetchCache = pgTable(
  "plan_prefetch_cache",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin] }),
  }),
);

export const cachedPlans = pgTable(
  "cached_plans",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin] }),
  }),
);

export const cachedWorkOrders = pgTable(
  "cached_work_orders",
  {
    shopId: integer("shop_id").notNull(),
    cacheKey: text("cache_key").notNull(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.cacheKey] }),
    cachedAtIdx: index("cached_wo_cached_at_idx").on(t.cachedAt),
  }),
);

export const recommendations = pgTable(
  "recommendations",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    vin: text("vin"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopVinIdx: index("recs_shop_vin_idx").on(t.shopId, t.vin),
    backfillUniq: uniqueIndex("recs_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const recommendationsCache = pgTable(
  "recommendations_cache",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin] }),
  }),
);

export const recommendationEvents = pgTable(
  "recommendation_events",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    vin: text("vin"),
    eventType: text("event_type"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload"),
  },
  (t) => ({
    shopReceivedIdx: index("rec_evt_shop_received_idx").on(t.shopId, t.receivedAt),
    backfillUniq: uniqueIndex("rec_evt_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* ========================================================================== */
/* Job index family  (sub-group: job-index — schema-only)                     */
/* ========================================================================== */

export const jobIndex = pgTable(
  "job_index",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id").notNull(),
    workOrderNumber: integer("work_order_number"),
    jobTitle: text("job_title"),
    jobCode: text("job_code"),
    vehicleVin: text("vehicle_vin"),
    serviceItemId: text("service_item_id"),
    performedAt: timestamp("performed_at", { withTimezone: true }),
    lines: jsonb("lines"),
    payload: jsonb("payload"),
  },
  (t) => ({
    shopTitleIdx: index("ji_shop_title_idx").on(t.shopId, t.jobTitle),
    shopVinIdx: index("ji_shop_vin_idx").on(t.shopId, t.vehicleVin),
    serviceItemIdx: index("ji_service_item_idx").on(t.shopId, t.serviceItemId),
    backfillUniq: uniqueIndex("ji_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const jobHistory = pgTable(
  "job_history",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    payload: jsonb("payload"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopReceivedIdx: index("jh_shop_received_idx").on(t.shopId, t.receivedAt),
    backfillUniq: uniqueIndex("jh_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const jobs = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    vin: text("vin"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopVinIdx: index("jobs_shop_vin_idx").on(t.shopId, t.vin),
    backfillUniq: uniqueIndex("jobs_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const smsHistoricalWorkOrders = pgTable(
  "sms_historical_work_orders",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    shopId: integer("shop_id"),
    vin: text("vin"),
    roNumber: text("ro_number"),
    provider: text("provider"),
    payload: jsonb("payload"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shopVinIdx: index("smshwo_shop_vin_idx").on(t.shopId, t.vin),
    backfillUniq: uniqueIndex("smshwo_backfill_uniq").on(t.backfillMongoId),
  }),
);

/* ========================================================================== */
/* Carfax mirrors  (sub-group: carfax — schema-only)                          */
/* ========================================================================== */

export const carfaxReports = pgTable(
  "carfax_reports",
  {
    shopId: integer("shop_id").notNull(),
    vin: text("vin").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    reportDate: text("report_date"),
    numberOfOwners: integer("number_of_owners"),
    accidents: integer("accidents"),
    damageReports: integer("damage_reports"),
    lastReportedMileage: integer("last_reported_mileage"),
    serviceRecords: jsonb("service_records"),
    titleIssues: jsonb("title_issues"),
    recalls: jsonb("recalls"),
    ok: boolean("ok"),
    error: text("error"),
    raw: jsonb("raw"),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.shopId, t.vin] }),
  }),
);

export const carfaxHistory = pgTable(
  "carfax_history",
  {
    id: serial("id").primaryKey(),
    backfillMongoId: text("backfill_mongo_id"),
    vin: text("vin").notNull(),
    date: text("date"),
    mileage: integer("mileage"),
    service: text("service"),
    label: text("label"),
    payload: jsonb("payload"),
  },
  (t) => ({
    vinIdx: index("cfh_vin_idx").on(t.vin),
    backfillUniq: uniqueIndex("cfh_backfill_uniq").on(t.backfillMongoId),
  }),
);

export const carfaxCache = pgTable(
  "carfax_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    payload: jsonb("payload").notNull(),
    cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => ({
    expiresIdx: index("cfc_expires_idx").on(t.expiresAt),
  }),
);
