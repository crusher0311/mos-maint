-- Operational primitives (task #557) — Postgres destination tables for the
-- cron distributed lock and the Tekmetric shared rate-limiter token buckets.
-- See lib/db/schema/operational.ts for the source-of-truth Drizzle definitions
-- and docs/db-migration-map.md §12 for the cutover (flag-flip, no backfill).
--
-- Schema-only: applying this migration is an operator step performed at
-- cutover time; the runtime code only touches these tables when
-- CRON_LOCK_PG_CANONICAL=1 / TEKMETRIC_SHARED_LIMITER_PG_CANONICAL=1.

CREATE TABLE IF NOT EXISTS "cron_locks" (
  "job_name" text PRIMARY KEY NOT NULL,
  "locked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "instance_id" text NOT NULL
);
CREATE INDEX IF NOT EXISTS "cron_locks_expires_at_idx" ON "cron_locks" ("expires_at");

CREATE TABLE IF NOT EXISTS "tekmetric_rate_buckets" (
  "bucket_key" text PRIMARY KEY NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
CREATE INDEX IF NOT EXISTS "tekmetric_rate_buckets_expires_at_idx" ON "tekmetric_rate_buckets" ("expires_at");
