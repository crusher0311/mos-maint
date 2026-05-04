-- Wave 3b (DB switchover task #345): integration mirrors, pre-normalized layer,
-- plan/recommendation caches, events, api_keys, counters, job_index family,
-- and Carfax → Postgres. Mirrors lib/db/schema/wave3.ts.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) so it
-- is safe to re-run during the per-sub-group soak windows that follow the
-- schema landing. Counters / api_keys / events flip reads + dual-writes in
-- this same task; the mirror groups land schemas only and ship cutover in
-- per-integration follow-ups.

/* -------------------- Counters / sequences ------------------------------- */

CREATE TABLE IF NOT EXISTS "pg_counters" (
  "name" text PRIMARY KEY,
  "seq" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

/* -------------------- api_keys ------------------------------------------- */

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" text PRIMARY KEY,
  "shop_id" integer NOT NULL,
  "key_hash" text NOT NULL,
  "key_prefix" text NOT NULL,
  "name" text NOT NULL,
  "permissions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "rate_limit" integer NOT NULL,
  "rate_limit_tier" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "revoked" boolean NOT NULL DEFAULT false,
  "revoked_at" timestamptz,
  "revoked_by" text,
  "last_used_at" timestamptz,
  "usage_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by" text NOT NULL,
  "expires_at" timestamptz,
  "is_partner" boolean NOT NULL DEFAULT false,
  "partner_id" text,
  "partner_name" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_uniq" ON "api_keys" ("key_hash");
CREATE INDEX IF NOT EXISTS "api_keys_shop_idx" ON "api_keys" ("shop_id");

CREATE TABLE IF NOT EXISTS "external_api_usage_logs" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "key_hash" text NOT NULL,
  "shop_id" integer NOT NULL,
  "endpoint" text NOT NULL,
  "method" text NOT NULL,
  "status_code" integer NOT NULL,
  "response_time" integer NOT NULL,
  "timestamp" timestamptz NOT NULL,
  "ip" text
);
CREATE INDEX IF NOT EXISTS "ext_api_usage_logs_key_ts_idx" ON "external_api_usage_logs" ("key_hash","timestamp");
CREATE INDEX IF NOT EXISTS "ext_api_usage_logs_shop_ts_idx" ON "external_api_usage_logs" ("shop_id","timestamp");
CREATE UNIQUE INDEX IF NOT EXISTS "ext_api_usage_logs_backfill_uniq" ON "external_api_usage_logs" ("backfill_mongo_id");

/* -------------------- events --------------------------------------------- */

CREATE TABLE IF NOT EXISTS "events" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "provider" text,
  "event" text,
  "type" text,
  "shop_id" text,
  "vehicle_vin" text,
  "vin" text,
  "received_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "payload" jsonb
);
CREATE INDEX IF NOT EXISTS "events_shop_received_idx" ON "events" ("shop_id","received_at");
CREATE INDEX IF NOT EXISTS "events_vin_received_idx" ON "events" ("vin","received_at");
CREATE INDEX IF NOT EXISTS "events_provider_event_idx" ON "events" ("provider","event","received_at");
CREATE UNIQUE INDEX IF NOT EXISTS "events_backfill_uniq" ON "events" ("backfill_mongo_id");

/* -------------------- Tekmetric mirrors ---------------------------------- */

CREATE TABLE IF NOT EXISTS "tekmetric_work_orders" (
  "shop_id" integer NOT NULL,
  "work_order_id" text NOT NULL,
  "repair_order_number" integer,
  "status" text,
  "vin" text,
  "customer_id" text,
  "vehicle_id" text,
  "completed_date" timestamptz,
  "posted_date" timestamptz,
  "updated_date" timestamptz,
  "payload" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tekmetric_work_orders_pk" PRIMARY KEY ("shop_id","work_order_id")
);
CREATE INDEX IF NOT EXISTS "tek_wo_shop_updated_idx" ON "tekmetric_work_orders" ("shop_id","updated_date");
CREATE INDEX IF NOT EXISTS "tek_wo_shop_ro_idx" ON "tekmetric_work_orders" ("shop_id","repair_order_number");
CREATE INDEX IF NOT EXISTS "tek_wo_vin_idx" ON "tekmetric_work_orders" ("vin");

CREATE TABLE IF NOT EXISTS "tekmetric_repair_orders" (
  "shop_id" integer NOT NULL,
  "repair_order_id" text NOT NULL,
  "repair_order_number" integer,
  "status" text,
  "vin" text,
  "completed_date" timestamptz,
  "updated_date" timestamptz,
  "payload" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tekmetric_repair_orders_pk" PRIMARY KEY ("shop_id","repair_order_id")
);
CREATE INDEX IF NOT EXISTS "tek_ro_shop_updated_idx" ON "tekmetric_repair_orders" ("shop_id","updated_date");

CREATE TABLE IF NOT EXISTS "tekmetric_vehicles" (
  "shop_id" integer NOT NULL,
  "vehicle_id" text NOT NULL,
  "vin" text,
  "customer_id" text,
  "year" integer,
  "make" text,
  "model" text,
  "payload" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tekmetric_vehicles_pk" PRIMARY KEY ("shop_id","vehicle_id")
);
CREATE INDEX IF NOT EXISTS "tek_veh_shop_vin_idx" ON "tekmetric_vehicles" ("shop_id","vin");

CREATE TABLE IF NOT EXISTS "tekmetric_vehicle_cache" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tekmetric_vehicle_cache_pk" PRIMARY KEY ("shop_id","vin")
);

CREATE TABLE IF NOT EXISTS "tekmetric_customer_cache" (
  "shop_id" integer NOT NULL,
  "customer_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tekmetric_customer_cache_pk" PRIMARY KEY ("shop_id","customer_id")
);

CREATE TABLE IF NOT EXISTS "tekmetric_jobs_cache" (
  "shop_id" integer NOT NULL,
  "cache_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tekmetric_jobs_cache_pk" PRIMARY KEY ("shop_id","cache_key")
);
CREATE INDEX IF NOT EXISTS "tek_jobs_cache_cached_at_idx" ON "tekmetric_jobs_cache" ("cached_at");

CREATE TABLE IF NOT EXISTS "tekmetric_canned_jobs_cache" (
  "shop_id" integer PRIMARY KEY,
  "items" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  "source" text
);

CREATE TABLE IF NOT EXISTS "tekmetric_tokens" (
  "shop_id" integer PRIMARY KEY,
  "access_token" text NOT NULL,
  "refresh_token" text,
  "token_type" text,
  "expires_at" timestamptz,
  "scope" text,
  "raw" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "tekmetric_api_usage" (
  "shop_id" integer NOT NULL,
  "day_key" text NOT NULL,
  "requests" integer NOT NULL DEFAULT 0,
  "errors" integer NOT NULL DEFAULT 0,
  "breakdown" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tekmetric_api_usage_pk" PRIMARY KEY ("shop_id","day_key")
);

/* -------------------- Protractor mirrors --------------------------------- */

CREATE TABLE IF NOT EXISTS "protractor_work_orders" (
  "shop_id" integer NOT NULL,
  "work_order_id" text NOT NULL,
  "work_order_guid" text,
  "work_order_number" integer,
  "type" text,
  "status" text,
  "vin" text,
  "service_item_id" text,
  "contact_id" text,
  "odometer" integer,
  "workflow_stage" text,
  "completed" boolean,
  "scheduled_time" text,
  "promised_time" text,
  "payload" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "protractor_work_orders_pk" PRIMARY KEY ("shop_id","work_order_id")
);
CREATE INDEX IF NOT EXISTS "pro_wo_shop_ronum_idx" ON "protractor_work_orders" ("shop_id","work_order_number");
CREATE INDEX IF NOT EXISTS "pro_wo_service_item_idx" ON "protractor_work_orders" ("shop_id","service_item_id");
CREATE INDEX IF NOT EXISTS "pro_wo_vin_idx" ON "protractor_work_orders" ("vin");

CREATE TABLE IF NOT EXISTS "protractor_invoices" (
  "shop_id" integer NOT NULL,
  "invoice_id" text NOT NULL,
  "invoice_number" integer,
  "vin" text,
  "completed_date" timestamptz,
  "payload" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "protractor_invoices_pk" PRIMARY KEY ("shop_id","invoice_id")
);
CREATE INDEX IF NOT EXISTS "pro_inv_shop_vin_idx" ON "protractor_invoices" ("shop_id","vin");

CREATE TABLE IF NOT EXISTS "protractor_invoice_cache" (
  "shop_id" integer NOT NULL,
  "invoice_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "protractor_invoice_cache_pk" PRIMARY KEY ("shop_id","invoice_id")
);
CREATE INDEX IF NOT EXISTS "pro_inv_cache_cached_at_idx" ON "protractor_invoice_cache" ("cached_at");

CREATE TABLE IF NOT EXISTS "protractor_vehicles" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "protractor_id" text,
  "year" integer,
  "make" text,
  "model" text,
  "odometer" integer,
  "odometer_date" text,
  "license_plate" text,
  "owner_id" text,
  "payload" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "protractor_vehicles_pk" PRIMARY KEY ("shop_id","vin")
);

CREATE TABLE IF NOT EXISTS "protractor_canned_jobs" (
  "shop_id" integer PRIMARY KEY,
  "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  "source" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "protractor_canned_jobs_cache" (
  "shop_id" integer NOT NULL,
  "cache_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "protractor_canned_jobs_cache_pk" PRIMARY KEY ("shop_id","cache_key")
);

CREATE TABLE IF NOT EXISTS "protractor_ro_cache" (
  "shop_id" integer NOT NULL,
  "cache_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "protractor_ro_cache_pk" PRIMARY KEY ("shop_id","cache_key")
);
CREATE INDEX IF NOT EXISTS "pro_ro_cache_cached_at_idx" ON "protractor_ro_cache" ("cached_at");

CREATE TABLE IF NOT EXISTS "protractor_template_cache" (
  "shop_id" integer NOT NULL,
  "template_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "protractor_template_cache_pk" PRIMARY KEY ("shop_id","template_id")
);

CREATE TABLE IF NOT EXISTS "protractor_service_items" (
  "shop_id" integer NOT NULL,
  "service_item_id" text NOT NULL,
  "vin" text,
  "contact_id" text,
  "payload" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "protractor_service_items_pk" PRIMARY KEY ("shop_id","service_item_id")
);
CREATE INDEX IF NOT EXISTS "pro_si_shop_vin_idx" ON "protractor_service_items" ("shop_id","vin");

CREATE TABLE IF NOT EXISTS "protractor_deferred_work" (
  "shop_id" integer NOT NULL,
  "deferred_work_id" text NOT NULL,
  "service_item_id" text,
  "vin" text,
  "payload" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "protractor_deferred_work_pk" PRIMARY KEY ("shop_id","deferred_work_id")
);
CREATE INDEX IF NOT EXISTS "pro_def_shop_vin_idx" ON "protractor_deferred_work" ("shop_id","vin");

CREATE TABLE IF NOT EXISTS "protractor_callback_events" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "callback_token" text,
  "event_type" text,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "payload" jsonb,
  "processed" boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS "pro_cb_shop_received_idx" ON "protractor_callback_events" ("shop_id","received_at");
CREATE UNIQUE INDEX IF NOT EXISTS "pro_cb_backfill_uniq" ON "protractor_callback_events" ("backfill_mongo_id");

/* -------------------- Shopware mirrors ----------------------------------- */

CREATE TABLE IF NOT EXISTS "shopware_repair_orders" (
  "mos_shop_id" integer NOT NULL,
  "ro_id" integer NOT NULL,
  "tenant_id" integer,
  "sw_shop_id" integer,
  "number" integer,
  "state" text,
  "vin" text,
  "customer_id" integer,
  "vehicle_id" integer,
  "customer_name" text,
  "vehicle_year" integer,
  "vehicle_make" text,
  "vehicle_model" text,
  "odometer" integer,
  "service_count" integer,
  "created_at_src" timestamptz,
  "updated_at_src" timestamptz,
  "closed_at" timestamptz,
  "deleted" boolean NOT NULL DEFAULT false,
  "deleted_at" timestamptz,
  "deleted_via_webhook" boolean,
  "partial_from_webhook" boolean,
  "fetch_error" text,
  "raw" jsonb,
  "synced_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "shopware_repair_orders_pk" PRIMARY KEY ("mos_shop_id","ro_id")
);
CREATE INDEX IF NOT EXISTS "sw_ro_shop_updated_idx" ON "shopware_repair_orders" ("mos_shop_id","updated_at_src");
CREATE INDEX IF NOT EXISTS "sw_ro_shop_vin_idx" ON "shopware_repair_orders" ("mos_shop_id","vin");

CREATE TABLE IF NOT EXISTS "shopware_vehicles" (
  "mos_shop_id" integer NOT NULL,
  "vehicle_id" integer NOT NULL,
  "vin" text,
  "year" integer,
  "make" text,
  "model" text,
  "customer_id" integer,
  "payload" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "shopware_vehicles_pk" PRIMARY KEY ("mos_shop_id","vehicle_id")
);
CREATE INDEX IF NOT EXISTS "sw_veh_shop_vin_idx" ON "shopware_vehicles" ("mos_shop_id","vin");

CREATE TABLE IF NOT EXISTS "shopware_customers" (
  "mos_shop_id" integer NOT NULL,
  "customer_id" integer NOT NULL,
  "name" text,
  "payload" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "shopware_customers_pk" PRIMARY KEY ("mos_shop_id","customer_id")
);

CREATE TABLE IF NOT EXISTS "shopware_backfill_progress" (
  "mos_shop_id" integer PRIMARY KEY,
  "cursor" jsonb,
  "completed" boolean NOT NULL DEFAULT false,
  "completed_at" timestamptz,
  "last_run_at" timestamptz,
  "ros_processed" integer NOT NULL DEFAULT 0,
  "extra" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "shopware_webhook_logs" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "mos_shop_id" integer,
  "sw_shop_id" integer,
  "event_type" text,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "payload" jsonb,
  "processed" boolean NOT NULL DEFAULT false,
  "process_error" text
);
CREATE INDEX IF NOT EXISTS "sw_webhook_shop_received_idx" ON "shopware_webhook_logs" ("mos_shop_id","received_at");
CREATE UNIQUE INDEX IF NOT EXISTS "sw_webhook_backfill_uniq" ON "shopware_webhook_logs" ("backfill_mongo_id");

/* -------------------- Autoflow mirrors ----------------------------------- */

CREATE TABLE IF NOT EXISTS "autoflow_credentials" (
  "shop_id" integer PRIMARY KEY,
  "api_base" text,
  "api_key_enc" text,
  "api_password_enc" text,
  "payload" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "autoflow_dvi_items" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer NOT NULL,
  "dvi_id" text,
  "item_id" text,
  "vin" text,
  "label" text,
  "severity" text,
  "note" text,
  "payload" jsonb,
  "received_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "af_dvi_items_shop_vin_idx" ON "autoflow_dvi_items" ("shop_id","vin");
CREATE INDEX IF NOT EXISTS "af_dvi_items_vin_idx" ON "autoflow_dvi_items" ("vin");
CREATE UNIQUE INDEX IF NOT EXISTS "af_dvi_items_backfill_uniq" ON "autoflow_dvi_items" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "autoflow_events" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "event_type" text,
  "vin" text,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "payload" jsonb
);
CREATE INDEX IF NOT EXISTS "af_events_shop_received_idx" ON "autoflow_events" ("shop_id","received_at");
CREATE UNIQUE INDEX IF NOT EXISTS "af_events_backfill_uniq" ON "autoflow_events" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "af_open" (
  "shop_id" integer NOT NULL,
  "ro_number" text NOT NULL,
  "payload" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "af_open_pk" PRIMARY KEY ("shop_id","ro_number")
);

/* -------------------- Autovitals mirrors --------------------------------- */

CREATE TABLE IF NOT EXISTS "autovitals_vehicles" (
  "shop_id" text NOT NULL,
  "vehicle_id" integer NOT NULL,
  "vin" text,
  "year" integer,
  "make" text,
  "model" text,
  "mileage" integer,
  "license_plate" text,
  "color" text,
  "customer_id" integer,
  "customer_name" text,
  "payload" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "autovitals_vehicles_pk" PRIMARY KEY ("shop_id","vehicle_id")
);
CREATE INDEX IF NOT EXISTS "av_veh_shop_vin_idx" ON "autovitals_vehicles" ("shop_id","vin");

CREATE TABLE IF NOT EXISTS "autovitals_appointments" (
  "shop_id" text NOT NULL,
  "appointment_id" integer NOT NULL,
  "vehicle_id" integer,
  "vin" text,
  "customer_id" integer,
  "customer_name" text,
  "customer_phone" text,
  "status" text,
  "promised_time" text,
  "service_advisor_id" integer,
  "technician_id" integer,
  "concern" text,
  "mileage_in" integer,
  "payload" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "autovitals_appointments_pk" PRIMARY KEY ("shop_id","appointment_id")
);
CREATE INDEX IF NOT EXISTS "av_appt_shop_vehicle_idx" ON "autovitals_appointments" ("shop_id","vehicle_id");

CREATE TABLE IF NOT EXISTS "autovitals_inspections" (
  "shop_id" text NOT NULL,
  "appointment_id" integer NOT NULL,
  "inspection_result_id" integer,
  "completed_at" text,
  "technician_id" integer,
  "technician_name" text,
  "items" jsonb,
  "payload" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "autovitals_inspections_pk" PRIMARY KEY ("shop_id","appointment_id")
);

CREATE TABLE IF NOT EXISTS "autovitals_imports" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" text,
  "import_type" text,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "success" boolean,
  "summary" jsonb,
  "payload" jsonb
);
CREATE INDEX IF NOT EXISTS "av_imports_shop_started_idx" ON "autovitals_imports" ("shop_id","started_at");
CREATE UNIQUE INDEX IF NOT EXISTS "av_imports_backfill_uniq" ON "autovitals_imports" ("backfill_mongo_id");

/* -------------------- Pre-normalized layer ------------------------------- */

CREATE TABLE IF NOT EXISTS "pre_normalized_repair_orders" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "ro_number" text,
  "vin" text,
  "customer_id" text,
  "status" text,
  "mileage" integer,
  "opened_at" timestamptz,
  "closed_at" timestamptz,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "pre_ro_shop_ro_idx" ON "pre_normalized_repair_orders" ("shop_id","ro_number");
CREATE INDEX IF NOT EXISTS "pre_ro_shop_vin_idx" ON "pre_normalized_repair_orders" ("shop_id","vin");
CREATE UNIQUE INDEX IF NOT EXISTS "pre_ro_backfill_uniq" ON "pre_normalized_repair_orders" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "pre_normalized_vehicles" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "vin" text,
  "year" integer,
  "make" text,
  "model" text,
  "trim" text,
  "last_mileage" integer,
  "declined" jsonb,
  "components" jsonb,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "pre_veh_shop_vin_idx" ON "pre_normalized_vehicles" ("shop_id","vin");
CREATE UNIQUE INDEX IF NOT EXISTS "pre_veh_backfill_uniq" ON "pre_normalized_vehicles" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "pre_normalized_customers" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" text,
  "name" text,
  "first_name" text,
  "last_name" text,
  "email" text,
  "phone" text,
  "external_id" text,
  "status" text,
  "provider" text,
  "last_vin" text,
  "last_ro" text,
  "last_mileage" integer,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "pre_cust_shop_ext_idx" ON "pre_normalized_customers" ("shop_id","external_id");
CREATE INDEX IF NOT EXISTS "pre_cust_shop_phone_idx" ON "pre_normalized_customers" ("shop_id","phone");
CREATE UNIQUE INDEX IF NOT EXISTS "pre_cust_backfill_uniq" ON "pre_normalized_customers" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "pre_normalized_manual_vehicles" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "vin" text,
  "year" integer,
  "make" text,
  "model" text,
  "entered_by" text,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "pre_man_veh_shop_vin_idx" ON "pre_normalized_manual_vehicles" ("shop_id","vin");
CREATE UNIQUE INDEX IF NOT EXISTS "pre_man_veh_backfill_uniq" ON "pre_normalized_manual_vehicles" ("backfill_mongo_id");

/* -------------------- DVI / canned jobs ---------------------------------- */

CREATE TABLE IF NOT EXISTS "dvi" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "ro_number" text,
  "vin" text,
  "sheet_id" text,
  "mileage" integer,
  "ok" boolean,
  "empty" boolean,
  "error" text,
  "fetched_at" timestamptz,
  "notes" text,
  "customer" jsonb,
  "vehicle" jsonb,
  "lines" jsonb,
  "raw" jsonb,
  "source" text
);
CREATE INDEX IF NOT EXISTS "dvi_shop_ro_idx" ON "dvi" ("shop_id","ro_number");
CREATE INDEX IF NOT EXISTS "dvi_vin_idx" ON "dvi" ("vin");
CREATE UNIQUE INDEX IF NOT EXISTS "dvi_backfill_uniq" ON "dvi" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "dvi_results" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "dvi_id" text,
  "ro_number" text,
  "vin" text,
  "payload" jsonb,
  "received_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "dvi_results_shop_ro_idx" ON "dvi_results" ("shop_id","ro_number");
CREATE UNIQUE INDEX IF NOT EXISTS "dvi_results_backfill_uniq" ON "dvi_results" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "canned_jobs" (
  "shop_id" integer NOT NULL,
  "canned_job_id" text NOT NULL,
  "title" text,
  "code" text,
  "payload" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "canned_jobs_pk" PRIMARY KEY ("shop_id","canned_job_id")
);

CREATE TABLE IF NOT EXISTS "canned_job_applications" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "canned_job_id" text,
  "vin" text,
  "ro_number" text,
  "applied_at" timestamptz NOT NULL DEFAULT now(),
  "payload" jsonb
);
CREATE INDEX IF NOT EXISTS "cja_shop_applied_idx" ON "canned_job_applications" ("shop_id","applied_at");
CREATE UNIQUE INDEX IF NOT EXISTS "cja_backfill_uniq" ON "canned_job_applications" ("backfill_mongo_id");

/* -------------------- Plan / recommendation caches ----------------------- */

CREATE TABLE IF NOT EXISTS "plans" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "vin" text,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "plans_shop_vin_idx" ON "plans" ("shop_id","vin");
CREATE UNIQUE INDEX IF NOT EXISTS "plans_backfill_uniq" ON "plans" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "plan_cache" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  CONSTRAINT "plan_cache_pk" PRIMARY KEY ("shop_id","vin")
);
CREATE INDEX IF NOT EXISTS "plan_cache_expires_idx" ON "plan_cache" ("expires_at");

CREATE TABLE IF NOT EXISTS "plan_prefetch_cache" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  CONSTRAINT "plan_prefetch_cache_pk" PRIMARY KEY ("shop_id","vin")
);

CREATE TABLE IF NOT EXISTS "cached_plans" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cached_plans_pk" PRIMARY KEY ("shop_id","vin")
);

CREATE TABLE IF NOT EXISTS "cached_work_orders" (
  "shop_id" integer NOT NULL,
  "cache_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cached_work_orders_pk" PRIMARY KEY ("shop_id","cache_key")
);
CREATE INDEX IF NOT EXISTS "cached_wo_cached_at_idx" ON "cached_work_orders" ("cached_at");

CREATE TABLE IF NOT EXISTS "recommendations" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "vin" text,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "recs_shop_vin_idx" ON "recommendations" ("shop_id","vin");
CREATE UNIQUE INDEX IF NOT EXISTS "recs_backfill_uniq" ON "recommendations" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "recommendations_cache" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "recommendations_cache_pk" PRIMARY KEY ("shop_id","vin")
);

CREATE TABLE IF NOT EXISTS "recommendation_events" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "vin" text,
  "event_type" text,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "payload" jsonb
);
CREATE INDEX IF NOT EXISTS "rec_evt_shop_received_idx" ON "recommendation_events" ("shop_id","received_at");
CREATE UNIQUE INDEX IF NOT EXISTS "rec_evt_backfill_uniq" ON "recommendation_events" ("backfill_mongo_id");

/* -------------------- Job index family ----------------------------------- */

CREATE TABLE IF NOT EXISTS "job_index" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer NOT NULL,
  "work_order_number" integer,
  "job_title" text,
  "job_code" text,
  "vehicle_vin" text,
  "service_item_id" text,
  "performed_at" timestamptz,
  "lines" jsonb,
  "payload" jsonb
);
CREATE INDEX IF NOT EXISTS "ji_shop_title_idx" ON "job_index" ("shop_id","job_title");
CREATE INDEX IF NOT EXISTS "ji_shop_vin_idx" ON "job_index" ("shop_id","vehicle_vin");
CREATE INDEX IF NOT EXISTS "ji_service_item_idx" ON "job_index" ("shop_id","service_item_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ji_backfill_uniq" ON "job_index" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "job_history" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "payload" jsonb,
  "received_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "jh_shop_received_idx" ON "job_history" ("shop_id","received_at");
CREATE UNIQUE INDEX IF NOT EXISTS "jh_backfill_uniq" ON "job_history" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "jobs" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "vin" text,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "jobs_shop_vin_idx" ON "jobs" ("shop_id","vin");
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_backfill_uniq" ON "jobs" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "sms_historical_work_orders" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "vin" text,
  "ro_number" text,
  "provider" text,
  "payload" jsonb,
  "received_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "smshwo_shop_vin_idx" ON "sms_historical_work_orders" ("shop_id","vin");
CREATE UNIQUE INDEX IF NOT EXISTS "smshwo_backfill_uniq" ON "sms_historical_work_orders" ("backfill_mongo_id");

/* -------------------- Carfax mirrors ------------------------------------- */

CREATE TABLE IF NOT EXISTS "carfax_reports" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "fetched_at" timestamptz,
  "report_date" text,
  "number_of_owners" integer,
  "accidents" integer,
  "damage_reports" integer,
  "last_reported_mileage" integer,
  "service_records" jsonb,
  "title_issues" jsonb,
  "recalls" jsonb,
  "ok" boolean,
  "error" text,
  "raw" jsonb,
  "source" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "carfax_reports_pk" PRIMARY KEY ("shop_id","vin")
);

CREATE TABLE IF NOT EXISTS "carfax_history" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "vin" text NOT NULL,
  "date" text,
  "mileage" integer,
  "service" text,
  "label" text,
  "payload" jsonb
);
CREATE INDEX IF NOT EXISTS "cfh_vin_idx" ON "carfax_history" ("vin");
CREATE UNIQUE INDEX IF NOT EXISTS "cfh_backfill_uniq" ON "carfax_history" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "carfax_cache" (
  "cache_key" text PRIMARY KEY,
  "payload" jsonb NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "cfc_expires_idx" ON "carfax_cache" ("expires_at");
