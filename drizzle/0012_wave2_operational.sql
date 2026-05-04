-- Wave 2 (DB switchover task #343): operational caches, queues, audit/notif,
-- external-API surface, and Tekmetric operational state → Postgres.
-- Mirrors lib/db/schema/wave2.ts. Idempotent (CREATE IF NOT EXISTS / ADD
-- COLUMN IF NOT EXISTS) so it is safe to re-run during the per-sub-group
-- soak windows that follow this schema landing.
--
-- Schema-only PR. No reads have been switched and no Mongo writes removed.
-- `tekmetric_drain_lock` has no destination table — it ports to a
-- `pg_try_advisory_lock(<int8>)` call at cutover time.

/* -------------------- AI / recommendation caches -------------------------- */

CREATE TABLE IF NOT EXISTS "ai_analysis_cache" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "payload" jsonb NOT NULL,
  "schema_version" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_analysis_cache_pk" PRIMARY KEY ("shop_id","vin")
);

CREATE TABLE IF NOT EXISTS "maintenance_analysis_cache" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "recommendations" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "show_inspect_items" jsonb,
  "mileage_at_analysis" integer,
  "source" text,
  "schema_version" integer,
  "analyzed_at" timestamptz NOT NULL DEFAULT now(),
  "raw" jsonb,
  CONSTRAINT "maintenance_analysis_cache_pk" PRIMARY KEY ("shop_id","vin")
);
CREATE INDEX IF NOT EXISTS "maint_analysis_cache_shop_analyzed_idx"
  ON "maintenance_analysis_cache" ("shop_id","analyzed_at");

CREATE TABLE IF NOT EXISTS "ai_budget_alerts" (
  "alert_key" text PRIMARY KEY,
  "shop_id" integer NOT NULL,
  "day_key" text NOT NULL,
  "plan" text NOT NULL,
  "threshold" double precision NOT NULL,
  "used_at_alert" double precision NOT NULL,
  "limit" double precision NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ai_budget_alerts_shop_day_idx"
  ON "ai_budget_alerts" ("shop_id","day_key");

CREATE TABLE IF NOT EXISTS "vhi_analysis_log" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "vin" text NOT NULL,
  "shop_id" integer,
  "sms" text,
  "sms_shop_id" text,
  "provider" text,
  "ro_number" text,
  "mileage" integer,
  "score" double precision,
  "tier" text,
  "summary" text,
  "authorized_jobs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "triggered_by" text,
  "analyzed_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "vhi_analysis_log_vin_analyzed_idx"
  ON "vhi_analysis_log" ("vin","analyzed_at");
CREATE INDEX IF NOT EXISTS "vhi_analysis_log_shop_analyzed_idx"
  ON "vhi_analysis_log" ("shop_id","analyzed_at");
CREATE UNIQUE INDEX IF NOT EXISTS "vhi_analysis_log_backfill_uniq"
  ON "vhi_analysis_log" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "concern_conversations" (
  "id" text PRIMARY KEY,
  "shop_id" integer NOT NULL,
  "mos_shop_id" integer,
  "vin" text,
  "user_email" text,
  "concern" text,
  "symptom_category" text,
  "questions" jsonb,
  "answered_questions" jsonb,
  "round_results" jsonb,
  "review" jsonb,
  "injected_to_protractor" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "concern_conversations_shop_vin_idx"
  ON "concern_conversations" ("shop_id","vin");
CREATE INDEX IF NOT EXISTS "concern_conversations_created_idx"
  ON "concern_conversations" ("created_at");

CREATE TABLE IF NOT EXISTS "report_approved_items" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "approved_service_keys" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "report_approved_items_pk" PRIMARY KEY ("shop_id","vin")
);

CREATE TABLE IF NOT EXISTS "remedied_deferred_work" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "deferred_id" text NOT NULL,
  "carfax_date" text,
  "carfax_description" text,
  "remedied_at" timestamptz NOT NULL DEFAULT now(),
  "raw" jsonb,
  CONSTRAINT "remedied_deferred_work_pk" PRIMARY KEY ("shop_id","vin","deferred_id")
);
CREATE INDEX IF NOT EXISTS "remedied_deferred_work_shop_vin_idx"
  ON "remedied_deferred_work" ("shop_id","vin");

CREATE TABLE IF NOT EXISTS "shop_repair_patterns" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer NOT NULL,
  "pattern" text NOT NULL,
  "service_name" text,
  "sample_count" integer NOT NULL DEFAULT 0,
  "confidence" double precision,
  "metadata" jsonb,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "shop_repair_patterns_shop_pattern_uniq"
  ON "shop_repair_patterns" ("shop_id","pattern");
CREATE UNIQUE INDEX IF NOT EXISTS "shop_repair_patterns_backfill_uniq"
  ON "shop_repair_patterns" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "oem_schedules" (
  "vin" text PRIMARY KEY,
  "items" jsonb,
  "source" text,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  "raw" jsonb
);

CREATE TABLE IF NOT EXISTS "oem_carfax_mappings" (
  "oem_name" text PRIMARY KEY,
  "carfax_name" text NOT NULL,
  "category" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

/* -------------------- External-API surface -------------------------------- */

CREATE TABLE IF NOT EXISTS "external_api_appointments" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer NOT NULL,
  "external_id" text,
  "provider" text NOT NULL,
  "customer_id" text,
  "customer_name" text,
  "vehicle_id" text,
  "vin" text,
  "scheduled_date" text,
  "scheduled_time" text,
  "service_type" text,
  "is_drop_off" boolean,
  "ride_option" text,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ext_api_appts_shop_created_idx"
  ON "external_api_appointments" ("shop_id","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "ext_api_appts_backfill_uniq"
  ON "external_api_appointments" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "external_api_keytags" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer NOT NULL,
  "vin" text,
  "customer_id" text,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ext_api_keytags_shop_created_idx"
  ON "external_api_keytags" ("shop_id","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "ext_api_keytags_backfill_uniq"
  ON "external_api_keytags" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "external_api_stickers" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer NOT NULL,
  "vin" text,
  "customer_id" text,
  "customer_name" text,
  "vehicle_year" integer,
  "vehicle_make" text,
  "vehicle_model" text,
  "current_mileage" integer,
  "next_service_mileage" integer,
  "next_service_date" text,
  "oil_type" text,
  "oil_brand" text,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ext_api_stickers_shop_created_idx"
  ON "external_api_stickers" ("shop_id","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "ext_api_stickers_backfill_uniq"
  ON "external_api_stickers" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "sticker_generations" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer NOT NULL,
  "generated_at" timestamptz NOT NULL DEFAULT now(),
  "generated_by" text,
  "vin" text,
  "vehicle_year" integer,
  "vehicle_make" text,
  "vehicle_model" text,
  "size" text,
  "unit" text,
  "source" text
);
CREATE INDEX IF NOT EXISTS "sticker_gen_shop_generated_idx"
  ON "sticker_generations" ("shop_id","generated_at");
CREATE UNIQUE INDEX IF NOT EXISTS "sticker_gen_backfill_uniq"
  ON "sticker_generations" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "sticker_qr_scans" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer NOT NULL,
  "scanned_at" timestamptz NOT NULL DEFAULT now(),
  "user_agent" text,
  "referer" text
);
CREATE INDEX IF NOT EXISTS "sticker_qr_shop_scanned_idx"
  ON "sticker_qr_scans" ("shop_id","scanned_at");
CREATE UNIQUE INDEX IF NOT EXISTS "sticker_qr_backfill_uniq"
  ON "sticker_qr_scans" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "shop_media" (
  "shop_id" integer NOT NULL,
  "type" text NOT NULL,
  "data_uri" text NOT NULL,
  "content_type" text,
  "hovercode_id" text,
  "updated_by" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "shop_media_pk" PRIMARY KEY ("shop_id","type")
);

/* -------------------- Audit / notifications ------------------------------- */

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "actor_email" text,
  "action" text,
  "target_shop_id" text,
  "details" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "audit_logs_actor_created_idx"
  ON "audit_logs" ("actor_email","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "audit_logs_backfill_uniq"
  ON "audit_logs" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "action" text NOT NULL,
  "admin_email" text NOT NULL,
  "target_shop_id" text,
  "target_shop_name" text,
  "target_user_email" text,
  "details" jsonb,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "admin_audit_logs_action_created_idx"
  ON "admin_audit_logs" ("action","created_at");
CREATE INDEX IF NOT EXISTS "admin_audit_logs_admin_created_idx"
  ON "admin_audit_logs" ("admin_email","created_at");
CREATE INDEX IF NOT EXISTS "admin_audit_logs_target_shop_created_idx"
  ON "admin_audit_logs" ("target_shop_id","created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "admin_audit_logs_backfill_uniq"
  ON "admin_audit_logs" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL,
  "shop_id" integer,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "message" text NOT NULL,
  "link" text,
  "read" boolean NOT NULL DEFAULT false,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "notifications_user_created_idx"
  ON "notifications" ("user_id","created_at");
CREATE INDEX IF NOT EXISTS "notifications_user_unread_idx"
  ON "notifications" ("user_id","read");
-- markAllReadForTicket() filters on metadata.ticketId; the gin index lets that
-- query stay sub-linear on million-row tables. Cutover task may swap this for
-- an expression index on ((metadata->>'ticketId')) if the query plan picks it.
CREATE INDEX IF NOT EXISTS "notifications_metadata_gin_idx"
  ON "notifications" USING GIN ("metadata");

CREATE TABLE IF NOT EXISTS "dashboard_updates" (
  "key" text PRIMARY KEY,
  "shop_id" integer,
  "timestamp_ms" bigint NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "support_chat_sessions" (
  "session_id" text PRIMARY KEY,
  "user_email" text NOT NULL,
  "shop_id" integer NOT NULL,
  "messages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "resolved" boolean NOT NULL DEFAULT false,
  "escalated_to_ticket" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "support_chat_user_updated_idx"
  ON "support_chat_sessions" ("user_email","updated_at");
CREATE INDEX IF NOT EXISTS "support_chat_shop_updated_idx"
  ON "support_chat_sessions" ("shop_id","updated_at");
CREATE INDEX IF NOT EXISTS "support_chat_active_idx"
  ON "support_chat_sessions" ("user_email","shop_id","resolved","updated_at");

/* -------------------- Queues & locks -------------------------------------- */

CREATE TABLE IF NOT EXISTS "enrichment_queue" (
  "shop_id" integer NOT NULL,
  "vin" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "priority" integer NOT NULL DEFAULT 1,
  "attempts" integer NOT NULL DEFAULT 0,
  "error" text,
  "oem_fetched" boolean,
  "carfax_fetched" boolean,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "next_attempt_at" timestamptz,
  "last_attempt_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "enrichment_queue_pk" PRIMARY KEY ("shop_id","vin")
);
CREATE INDEX IF NOT EXISTS "enrichment_queue_shop_status_idx"
  ON "enrichment_queue" ("shop_id","status");
CREATE INDEX IF NOT EXISTS "enrichment_queue_pending_claim_idx"
  ON "enrichment_queue" ("status","priority","created_at");

CREATE TABLE IF NOT EXISTS "extension_prefetch_locks" (
  "shop_id" integer PRIMARY KEY,
  "started_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "auto_booking_queue" (
  "id" text PRIMARY KEY,
  "shop_id" integer NOT NULL,
  "status" text,
  "vin" text,
  "customer_id" text,
  "vehicle_id" text,
  "scheduled_date" text,
  "scheduled_time" text,
  "service_type" text,
  "external_appointment_id" text,
  "provider" text,
  "confirmation_mode" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "data" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "auto_booking_shop_status_idx"
  ON "auto_booking_queue" ("shop_id","status");
CREATE INDEX IF NOT EXISTS "auto_booking_shop_created_idx"
  ON "auto_booking_queue" ("shop_id","created_at");

/* -------------------- Tekmetric operational state ------------------------- */

CREATE TABLE IF NOT EXISTS "tekmetric_backfill_progress" (
  "shop_id" integer PRIMARY KEY,
  "started_at" timestamptz,
  "current_chunk_end" timestamptz,
  "completed" boolean NOT NULL DEFAULT false,
  "completed_at" timestamptz,
  "complete" boolean,
  "logic_version" integer,
  "last_run_at" timestamptz,
  "last_error" text,
  "last_error_at" timestamptz,
  "recent_skipped_ros" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "last_stale_skipped_ros_archived_at" timestamptz,
  "stale_skipped_ros_archived_total" integer NOT NULL DEFAULT 0,
  "extra" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "tekmetric_backfill_health_alerts" (
  "shop_id" integer PRIMARY KEY,
  "first_alerted_at" timestamptz NOT NULL DEFAULT now(),
  "last_alerted_at" timestamptz NOT NULL DEFAULT now(),
  "alert_count" integer NOT NULL DEFAULT 1,
  "payload" jsonb,
  "resolved_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "tekmetric_permfailed_ro_alerts" (
  "shop_id" integer PRIMARY KEY,
  "name" text,
  "current_count" integer NOT NULL DEFAULT 0,
  "first_alerted_at" timestamptz NOT NULL DEFAULT now(),
  "last_alerted_at" timestamptz NOT NULL DEFAULT now(),
  "payload" jsonb,
  "resolved_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "tekmetric_skipped_ro_archive" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "shop_id" integer NOT NULL,
  "ro_id" text NOT NULL,
  "skipped_at" timestamptz,
  "archived_at" timestamptz NOT NULL DEFAULT now(),
  "stale" boolean NOT NULL DEFAULT false,
  "permanently_failed" boolean NOT NULL DEFAULT false,
  "reason" text,
  "payload" jsonb
);
CREATE INDEX IF NOT EXISTS "tek_skipped_ro_shop_archived_idx"
  ON "tekmetric_skipped_ro_archive" ("shop_id","archived_at");
CREATE INDEX IF NOT EXISTS "tek_skipped_ro_stale_idx"
  ON "tekmetric_skipped_ro_archive" ("stale","archived_at");
CREATE UNIQUE INDEX IF NOT EXISTS "tek_skipped_ro_backfill_uniq"
  ON "tekmetric_skipped_ro_archive" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "tekmetric_catchup_runs" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "started_at" timestamptz NOT NULL,
  "finished_at" timestamptz,
  "shops_processed" integer,
  "ros_processed" integer,
  "success" boolean,
  "summary" jsonb
);
CREATE INDEX IF NOT EXISTS "tek_catchup_runs_started_idx"
  ON "tekmetric_catchup_runs" ("started_at");
CREATE UNIQUE INDEX IF NOT EXISTS "tek_catchup_runs_backfill_uniq"
  ON "tekmetric_catchup_runs" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "tekmetric_mileage_backfill_progress" (
  "shop_id" integer PRIMARY KEY,
  "cursor_ro_id" text,
  "completed" boolean NOT NULL DEFAULT false,
  "completed_at" timestamptz,
  "last_run_at" timestamptz,
  "ros_updated" integer NOT NULL DEFAULT 0,
  "extra" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "tekmetric_webhook_logs" (
  "id" serial PRIMARY KEY,
  "backfill_mongo_id" text,
  "tekmetric_shop_id" integer,
  "mos_shop_id" integer,
  "event_type" text,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "payload" jsonb,
  "processed" boolean NOT NULL DEFAULT false,
  "process_error" text
);
CREATE INDEX IF NOT EXISTS "tek_webhook_logs_shop_received_idx"
  ON "tekmetric_webhook_logs" ("tekmetric_shop_id","received_at");
CREATE INDEX IF NOT EXISTS "tek_webhook_logs_event_type_idx"
  ON "tekmetric_webhook_logs" ("event_type","received_at");
CREATE UNIQUE INDEX IF NOT EXISTS "tek_webhook_logs_backfill_uniq"
  ON "tekmetric_webhook_logs" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "tekmetric_webhook_subscriptions" (
  "tekmetric_shop_id" integer PRIMARY KEY,
  "mos_shop_id" integer,
  "events" jsonb,
  "public_url" text,
  "first_attempt_at" timestamptz,
  "last_attempt_at" timestamptz,
  "last_result" jsonb
);

CREATE TABLE IF NOT EXISTS "tekmetric_webhook_health_alerts" (
  "tekmetric_shop_id" integer NOT NULL,
  "alert_date" text NOT NULL,
  "alerted_at" timestamptz NOT NULL DEFAULT now(),
  "payload" jsonb,
  CONSTRAINT "tek_webhook_health_alerts_pk" PRIMARY KEY ("tekmetric_shop_id","alert_date")
);

/* -------------------- Misc ------------------------------------------------ */

CREATE TABLE IF NOT EXISTS "platform_plans" (
  "slug" text PRIMARY KEY,
  "name" text,
  "monthly_price" double precision,
  "annual_price" double precision,
  "stripe_monthly_price_id" text,
  "stripe_annual_price_id" text,
  "features" jsonb,
  "raw" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
