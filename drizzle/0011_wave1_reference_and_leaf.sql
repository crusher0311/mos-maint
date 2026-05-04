-- Wave 1 (DB switchover task #342): reference & leaf data → Postgres.
-- Mirrors lib/db/schema/wave1.ts. Idempotent (CREATE IF NOT EXISTS) so it is
-- safe to re-run during the soak window.

CREATE TABLE IF NOT EXISTS "dataone_cache" (
  "squish" text PRIMARY KEY,
  "vin" text NOT NULL,
  "data" jsonb NOT NULL,
  "vehicle" jsonb,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "source" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "dataone_cache_expires_idx" ON "dataone_cache" ("expires_at");

CREATE TABLE IF NOT EXISTS "dataone_oe" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "items" jsonb,
  "mileage_used" integer,
  "ok" boolean NOT NULL DEFAULT false,
  "error" text,
  "raw" jsonb,
  "source" text,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dataone_oe_pk" PRIMARY KEY ("shop_id","vin")
);

CREATE TABLE IF NOT EXISTS "lkp_ymm_maintenance_interval" (
  "id" serial PRIMARY KEY,
  "year" integer,
  "make" text,
  "model" text,
  "trim" text,
  "event_code" text,
  "description" text,
  "mileage_interval" integer,
  "time_interval_months" integer,
  "first_due_miles" integer,
  "first_due_months" integer,
  "oem_notes" text,
  "raw" jsonb
);
CREATE INDEX IF NOT EXISTS "lkp_ymm_maint_int_ymm_idx" ON "lkp_ymm_maintenance_interval" ("year","make","model");
CREATE INDEX IF NOT EXISTS "lkp_ymm_maint_int_ymm_trim_idx" ON "lkp_ymm_maintenance_interval" ("year","make","model","trim");

CREATE TABLE IF NOT EXISTS "def_maintenance_event" (
  "event_code" text PRIMARY KEY,
  "description" text,
  "raw" jsonb
);

CREATE TABLE IF NOT EXISTS "dataone_lkp_squish_maintenance" (
  "id" serial PRIMARY KEY,
  "squish" text NOT NULL,
  "vin_maintenance_id" integer NOT NULL,
  "maintenance_id" integer NOT NULL
);
CREATE INDEX IF NOT EXISTS "dataone_lkp_squish_maint_squish_idx" ON "dataone_lkp_squish_maintenance" ("squish");
CREATE UNIQUE INDEX IF NOT EXISTS "dataone_lkp_squish_maint_uniq" ON "dataone_lkp_squish_maintenance" ("squish","vin_maintenance_id","maintenance_id");

CREATE TABLE IF NOT EXISTS "part_cross_ref" (
  "shop_id" integer NOT NULL,
  "normalized_part_number" text NOT NULL,
  "part_number" text NOT NULL,
  "description" text,
  "manufacturer" text,
  "used_on" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "cross_references" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "work_order_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "usage_count" integer NOT NULL DEFAULT 0,
  "last_used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "part_cross_ref_pk" PRIMARY KEY ("shop_id","normalized_part_number")
);
CREATE INDEX IF NOT EXISTS "part_cross_ref_shop_part_idx" ON "part_cross_ref" ("shop_id","part_number");

CREATE TABLE IF NOT EXISTS "knowledge_articles" (
  "id" text PRIMARY KEY,
  "title" text NOT NULL,
  "problem" text NOT NULL,
  "solution" text NOT NULL,
  "category" text NOT NULL,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "source_ticket_id" text,
  "embedding" jsonb,
  "created_by" text NOT NULL,
  "view_count" integer NOT NULL DEFAULT 0,
  "helpful_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "knowledge_articles_category_idx" ON "knowledge_articles" ("category");
CREATE INDEX IF NOT EXISTS "knowledge_articles_rank_idx" ON "knowledge_articles" ("helpful_count","view_count");

CREATE TABLE IF NOT EXISTS "viewed_vins" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "ro_number" text,
  "ro_number_key" text NOT NULL,
  "first_viewed_at" timestamptz NOT NULL DEFAULT now(),
  "last_viewed_at" timestamptz NOT NULL DEFAULT now(),
  "view_count" integer NOT NULL DEFAULT 1,
  CONSTRAINT "viewed_vins_pk" PRIMARY KEY ("shop_id","vin","ro_number_key")
);
CREATE INDEX IF NOT EXISTS "viewed_vins_shop_first_viewed_idx" ON "viewed_vins" ("shop_id","first_viewed_at");

CREATE TABLE IF NOT EXISTS "sync_metrics" (
  "id" serial PRIMARY KEY,
  "worker_type" text NOT NULL,
  "shop_id" integer,
  "started_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  "duration_ms" integer,
  "success" boolean NOT NULL,
  "error" text,
  "records_processed" integer,
  "records_skipped" integer,
  "retry_count" integer,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "sync_metrics_worker_type_idx" ON "sync_metrics" ("worker_type","created_at");

CREATE TABLE IF NOT EXISTS "ingestion_errors" (
  "worker_type" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "shop_id" integer,
  "error" text NOT NULL,
  "raw_data" jsonb,
  "retry_count" integer NOT NULL DEFAULT 0,
  "resolved" boolean NOT NULL DEFAULT false,
  "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ingestion_errors_pk" PRIMARY KEY ("worker_type","entity_type","entity_id")
);
CREATE INDEX IF NOT EXISTS "ingestion_errors_unresolved_idx" ON "ingestion_errors" ("resolved","created_at");

CREATE TABLE IF NOT EXISTS "data_quality_reports" (
  "id" serial PRIMARY KEY,
  "shop_id" integer NOT NULL,
  "shop_name" text,
  "report" jsonb NOT NULL,
  "cleanup_result" jsonb,
  "run_type" text NOT NULL DEFAULT 'automated',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "data_quality_reports_shop_idx" ON "data_quality_reports" ("shop_id","created_at");

CREATE TABLE IF NOT EXISTS "extension_analytics" (
  "id" serial PRIMARY KEY,
  "event_type" text NOT NULL,
  "shop_id" integer NOT NULL,
  "user_id" text,
  "enterprise_id" text,
  "vin" text,
  "vehicle_year" integer,
  "vehicle_make" text,
  "vehicle_model" text,
  "job_title" text,
  "job_source" text,
  "repair_order_id" text,
  "labor_amount" double precision,
  "parts_amount" double precision,
  "total_amount" double precision,
  "timestamp" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "extension_analytics_shop_ts_idx" ON "extension_analytics" ("shop_id","timestamp");
CREATE INDEX IF NOT EXISTS "extension_analytics_event_type_idx" ON "extension_analytics" ("event_type","timestamp");
CREATE INDEX IF NOT EXISTS "extension_analytics_enterprise_idx" ON "extension_analytics" ("enterprise_id","timestamp");

CREATE TABLE IF NOT EXISTS "system_announcements" (
  "id" text PRIMARY KEY,
  "title" text NOT NULL,
  "message" text NOT NULL,
  "priority" text NOT NULL,
  "target" jsonb NOT NULL,
  "delivery_channels" jsonb NOT NULL,
  "status" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  "expires_at" timestamptz,
  "stats" jsonb
);
CREATE INDEX IF NOT EXISTS "system_announcements_status_sent_idx" ON "system_announcements" ("status","sent_at");

CREATE TABLE IF NOT EXISTS "sms_historical_work_orders" (
  "shop_id" integer NOT NULL,
  "source_system" text NOT NULL,
  "work_order_id" text NOT NULL,
  "work_order_number" text,
  "closed_at" timestamptz,
  "data" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sms_hist_wo_pk" PRIMARY KEY ("shop_id","source_system","work_order_id")
);
CREATE INDEX IF NOT EXISTS "sms_hist_wo_shop_closed_idx" ON "sms_historical_work_orders" ("shop_id","closed_at");

CREATE TABLE IF NOT EXISTS "ratelimits" (
  "bucket_key" text PRIMARY KEY,
  "count" integer NOT NULL DEFAULT 0,
  "window_seconds" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "ratelimits_expires_idx" ON "ratelimits" ("expires_at");

-- Round-5: backfill_mongo_id columns for append-only entities so the
-- Mongo→PG backfill is idempotent on re-run (task #342).
ALTER TABLE "sync_metrics"           ADD COLUMN IF NOT EXISTS "backfill_mongo_id" text;
ALTER TABLE "extension_analytics"    ADD COLUMN IF NOT EXISTS "backfill_mongo_id" text;
ALTER TABLE "data_quality_reports"   ADD COLUMN IF NOT EXISTS "backfill_mongo_id" text;
ALTER TABLE "lkp_ymm_maintenance_interval" ADD COLUMN IF NOT EXISTS "backfill_mongo_id" text;
CREATE UNIQUE INDEX IF NOT EXISTS "sync_metrics_backfill_uniq"        ON "sync_metrics" ("backfill_mongo_id");
CREATE UNIQUE INDEX IF NOT EXISTS "extension_analytics_backfill_uniq" ON "extension_analytics" ("backfill_mongo_id");
CREATE UNIQUE INDEX IF NOT EXISTS "data_quality_reports_backfill_uniq" ON "data_quality_reports" ("backfill_mongo_id");
CREATE UNIQUE INDEX IF NOT EXISTS "lkp_ymm_maint_int_backfill_uniq"   ON "lkp_ymm_maintenance_interval" ("backfill_mongo_id");
