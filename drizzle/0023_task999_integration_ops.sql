-- Integration operational stores (task #999) — Postgres destinations for the
-- remaining Mongo-only operational collections not covered by wave2/wave3:
-- Protractor `backfill_progress`, `protractor_webhook_subscriptions`, and the
-- drain-worker lease (`tekmetric_drain_lock` → one row per provider).
-- Source-of-truth Drizzle definitions: lib/db/schema/integration-ops.ts.
--
-- Schema-only: applying this migration is an operator step performed at
-- cutover time; runtime code only touches these tables when
-- <INTEGRATION>_OPS_PG_CANONICAL=1 (lib/db/integration-ops-write-mode.ts).

CREATE TABLE IF NOT EXISTS "protractor_backfill_progress" (
  "shop_id" integer PRIMARY KEY NOT NULL,
  "started_at" timestamp with time zone,
  "completed" boolean DEFAULT false NOT NULL,
  "completed_at" timestamp with time zone,
  "complete" boolean,
  "last_run_at" timestamp with time zone,
  "last_error" text,
  "last_error_at" timestamp with time zone,
  "current_chunk_end" timestamp with time zone,
  "lock_owner" text,
  "lock_expires_at" timestamp with time zone,
  "extra" jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "protractor_backfill_progress_completed_idx"
  ON "protractor_backfill_progress" ("completed", "last_run_at");

CREATE TABLE IF NOT EXISTS "protractor_webhook_subscriptions" (
  "shop_id" integer PRIMARY KEY NOT NULL,
  "token" text,
  "url" text,
  "active" boolean DEFAULT true NOT NULL,
  "verified_at" timestamp with time zone,
  "last_checked_at" timestamp with time zone,
  "payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "api_usage" (
  "id" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "shop_id" integer,
  "shop_name" text,
  "endpoint" text,
  "method" text,
  "status_code" integer,
  "is_error" boolean DEFAULT false NOT NULL,
  "is_rate_limited" boolean DEFAULT false NOT NULL,
  "error_message" text,
  "error_code" text,
  "latency_ms" integer,
  "request_id" text,
  "source_worker" text,
  "timestamp" timestamp with time zone NOT NULL,
  "extra" jsonb
);
CREATE INDEX IF NOT EXISTS "api_usage_provider_ts_idx" ON "api_usage" ("provider", "timestamp");
CREATE INDEX IF NOT EXISTS "api_usage_shop_ts_idx" ON "api_usage" ("shop_id", "timestamp");

CREATE TABLE IF NOT EXISTS "api_rate_limits" (
  "slot_key" text PRIMARY KEY NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "api_rate_limits_expires_idx" ON "api_rate_limits" ("expires_at");

CREATE TABLE IF NOT EXISTS "integration_drain_locks" (
  "provider" text PRIMARY KEY NOT NULL,
  "owner" text NOT NULL,
  "acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "last_refresh_at" timestamp with time zone,
  "meta" jsonb
);
CREATE INDEX IF NOT EXISTS "integration_drain_locks_expires_idx"
  ON "integration_drain_locks" ("expires_at");
