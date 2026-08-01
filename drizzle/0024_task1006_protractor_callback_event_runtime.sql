-- Task #1006 — finish moving `protractor_callback_events` off Mongo.
--
-- The wave3 table only carried the backfill-mirror shape (serial id +
-- backfill_mongo_id + a few columns). The runtime webhook flow threads a
-- stable per-event key across the request; PG gets an app-generated UUID
-- column (`event_key`) plus the full runtime document shape used by
-- app/api/callbacks/protractor and the protractor-sync /
-- protractor-webhook-health / protractor-af-log-tail crons.
--
-- Schema-only: applying this migration is an operator step performed at
-- cutover time; runtime code only touches these columns when
-- PROTRACTOR_OPS_PG_CANONICAL=1 (lib/db/integration-ops-write-mode.ts).

ALTER TABLE "protractor_callback_events"
  ADD COLUMN IF NOT EXISTS "event_key" text,
  ADD COLUMN IF NOT EXISTS "method" text,
  ADD COLUMN IF NOT EXISTS "connection_id" text,
  ADD COLUMN IF NOT EXISTS "object_type" text,
  ADD COLUMN IF NOT EXISTS "object_id" text,
  ADD COLUMN IF NOT EXISTS "operation" text,
  ADD COLUMN IF NOT EXISTS "work_order_id" text,
  ADD COLUMN IF NOT EXISTS "status" text,
  ADD COLUMN IF NOT EXISTS "processed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "attempts" integer,
  ADD COLUMN IF NOT EXISTS "priority" integer,
  ADD COLUMN IF NOT EXISTS "processing_started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_error" text,
  ADD COLUMN IF NOT EXISTS "last_error_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "vin" text,
  ADD COLUMN IF NOT EXISTS "work_order_number" text,
  ADD COLUMN IF NOT EXISTS "no_action" boolean,
  ADD COLUMN IF NOT EXISTS "deleted_from_dashboard" boolean;

CREATE UNIQUE INDEX IF NOT EXISTS "pro_cb_event_key_uniq"
  ON "protractor_callback_events" ("event_key");
CREATE INDEX IF NOT EXISTS "pro_cb_conn_received_idx"
  ON "protractor_callback_events" ("connection_id", "received_at");
CREATE INDEX IF NOT EXISTS "pro_cb_method_received_idx"
  ON "protractor_callback_events" ("method", "received_at");
CREATE INDEX IF NOT EXISTS "pro_cb_method_processed_idx"
  ON "protractor_callback_events" ("method", "processed_at");
CREATE INDEX IF NOT EXISTS "pro_cb_pending_queue_idx"
  ON "protractor_callback_events" ("method", "processed", "priority", "received_at");
CREATE INDEX IF NOT EXISTS "pro_cb_wo_status_idx"
  ON "protractor_callback_events" ("work_order_id", "status", "processed");
CREATE INDEX IF NOT EXISTS "pro_cb_obj_dedup_idx"
  ON "protractor_callback_events" ("shop_id", "object_type", "object_id", "operation");
