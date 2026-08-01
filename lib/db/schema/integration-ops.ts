/**
 * Integration operational stores (task #999) — the Postgres destinations
 * for the last Mongo-only operational collections that wave2/wave3 did
 * not cover:
 *
 *   - `backfill_progress` (Protractor per-shop backfill cursor + inline
 *     chunk lease) → `protractor_backfill_progress`
 *   - `protractor_webhook_subscriptions` → same name
 *   - `tekmetric_drain_lock` (and future per-provider drain locks) →
 *     `integration_drain_locks` (one lease row per provider, preserving
 *     the Mongo findOneAndUpdate acquire / owner-guarded refresh /
 *     owner-guarded release semantics)
 *
 * Everything else in scope already has a wave2/wave3 table
 * (tekmetric_* operational state, tokens, api usage, webhook stores,
 * protractor deferred/callback/service-item/template stores,
 * shopware_backfill_progress for the Mongo `ln` collection,
 * shopware_webhook_logs, autovitals_* stores).
 *
 * Hand-written SQL twin: `drizzle/0023_task999_integration_ops.sql`
 * (db:generate is dead — journal drift; see docs/db-migration-map.md).
 * Applying it is an operator step; runtime code only touches these
 * tables when `<INTEGRATION>_OPS_PG_CANONICAL=1`
 * (`lib/db/integration-ops-write-mode.ts`).
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Mongo `backfill_progress` — Protractor per-shop backfill walk state. */
export const protractorBackfillProgress = pgTable(
  "protractor_backfill_progress",
  {
    shopId: integer("shop_id").primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completed: boolean("completed").notNull().default(false),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    complete: boolean("complete"), // legacy flag, kept for parity with Mongo
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    currentChunkEnd: timestamp("current_chunk_end", { withTimezone: true }),
    // Inline per-shop chunk lease (Mongo does findOneAndUpdate on the
    // progress doc itself).
    lockOwner: text("lock_owner"),
    lockExpiresAt: timestamp("lock_expires_at", { withTimezone: true }),
    // Catch-all for the evolving chunk-metrics / reconcile bookkeeping
    // fields the sync engine grows over time.
    extra: jsonb("extra"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    completedIdx: index("protractor_backfill_progress_completed_idx").on(
      t.completed,
      t.lastRunAt,
    ),
  }),
);

/** `protractor_webhook_subscriptions` — per-shop callback registration bookkeeping. */
export const protractorWebhookSubscriptions = pgTable(
  "protractor_webhook_subscriptions",
  {
    shopId: integer("shop_id").primaryKey(),
    token: text("token"),
    url: text("url"),
    active: boolean("active").notNull().default(true),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

/**
 * Mongo `api_usage` — unified cross-provider per-request usage log
 * (provider="tekmetric" | "protractor" | ...). Backs the admin usage
 * dashboards and the 429/window stats readers. Time-window scans are
 * the hot read (`timestamp >= now()-60m` count / group-by-shop), hence
 * the (provider, timestamp) index. Durable log → operator backfill via
 * `scripts/backfill-integration-ops.ts`.
 */
export const apiUsage = pgTable(
  "api_usage",
  {
    id: text("id").primaryKey(), // Mongo _id hex, so backfill is idempotent
    provider: text("provider").notNull(),
    shopId: integer("shop_id"),
    shopName: text("shop_name"),
    endpoint: text("endpoint"),
    method: text("method"),
    statusCode: integer("status_code"),
    isError: boolean("is_error").notNull().default(false),
    isRateLimited: boolean("is_rate_limited").notNull().default(false),
    errorMessage: text("error_message"),
    errorCode: text("error_code"),
    latencyMs: integer("latency_ms"),
    requestId: text("request_id"),
    sourceWorker: text("source_worker"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    extra: jsonb("extra"),
  },
  (t) => ({
    providerTsIdx: index("api_usage_provider_ts_idx").on(t.provider, t.timestamp),
    shopTsIdx: index("api_usage_shop_ts_idx").on(t.shopId, t.timestamp),
  }),
);

/**
 * Mongo `api_rate_limits` — transient cross-worker rate-limiter slots
 * (string `_id` slot key + count + TTL). Pure flag flip, no backfill —
 * same precedent as `tekmetric_rate_buckets`.
 */
export const apiRateLimits = pgTable(
  "api_rate_limits",
  {
    slotKey: text("slot_key").primaryKey(),
    count: integer("count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => ({
    expiresIdx: index("api_rate_limits_expires_idx").on(t.expiresAt),
  }),
);

/**
 * Drain-worker global lease, one row per provider
 * (`tekmetric` today; `protractor` / `shopware` when their drains grow
 * locks). Mongo twin: `tekmetric_drain_lock` `_id:"global"` doc.
 * Semantics preserved exactly:
 *   acquire  — insert, or take over iff expired (unique-violation ⇒ held);
 *   refresh  — update WHERE provider AND owner (0 rows ⇒ lost lock);
 *   release  — delete WHERE provider AND owner.
 */
export const integrationDrainLocks = pgTable(
  "integration_drain_locks",
  {
    provider: text("provider").primaryKey(),
    owner: text("owner").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    meta: jsonb("meta"),
  },
  (t) => ({
    expiresIdx: index("integration_drain_locks_expires_idx").on(t.expiresAt),
  }),
);
