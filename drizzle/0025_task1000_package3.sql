-- Task #1000 — Package 3 (canned_jobs / canned_job_applications,
-- concern_conversations, shop_repair_patterns) legacy pre-normalized Mongo
-- store cutover.
--
-- canned_jobs + canned_job_applications already have the columns the gated
-- repos need (drizzle/0014_wave3.sql:632-653), so nothing is added for them
-- here.
--
-- All statements are idempotent (IF NOT EXISTS / IF EXISTS) so re-running is a
-- no-op.

/* -------------------------------------------------------------------------- */
/* concern_conversations — heterogeneous doc columns                           */
/* The concern-assistant doc grows fields over time (userId, vehicleDisplay,   */
/* exchanges, status, source, cleanedText, injected*); the full doc is stored  */
/* verbatim in `payload`, with userId/status pulled out for indexing.          */
/* -------------------------------------------------------------------------- */

ALTER TABLE "concern_conversations" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "concern_conversations" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "concern_conversations" ADD COLUMN IF NOT EXISTS "payload" jsonb;

CREATE INDEX IF NOT EXISTS "concern_conversations_user_updated_idx"
  ON "concern_conversations" ("user_id", "updated_at");

/* -------------------------------------------------------------------------- */
/* shop_repair_patterns — real Mongo doc shape                                 */
/* The wave2 stub (pattern/service_name/sample_count) modelled a different     */
/* concept than lib/repair-patterns.ts actually writes. Add the natural-key +  */
/* rolling-aggregate columns and relax the legacy `pattern` NOT NULL.          */
/* -------------------------------------------------------------------------- */

ALTER TABLE "shop_repair_patterns" ALTER COLUMN "pattern" DROP NOT NULL;

ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "enterprise_id" text;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "year" integer;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "make" text;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "model" text;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "mileage_bucket" integer;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "job_title" text;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "job_title_normalized" text;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "occurrences" integer NOT NULL DEFAULT 0;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "total_labor" double precision NOT NULL DEFAULT 0;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "total_parts" double precision NOT NULL DEFAULT 0;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "total_amount" double precision NOT NULL DEFAULT 0;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "avg_labor" double precision NOT NULL DEFAULT 0;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "avg_parts" double precision NOT NULL DEFAULT 0;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "avg_total" double precision NOT NULL DEFAULT 0;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "avg_hours" double precision NOT NULL DEFAULT 0;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "last_performed" timestamptz;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "first_performed" timestamptz;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "vins_seen" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS "shop_repair_patterns_shop_vehicle_job_uniq"
  ON "shop_repair_patterns" ("shop_id", "year", "make", "model", "mileage_bucket", "job_title_normalized");
CREATE INDEX IF NOT EXISTS "shop_repair_patterns_enterprise_vehicle_idx"
  ON "shop_repair_patterns" ("enterprise_id", "year", "make", "model", "mileage_bucket");
CREATE INDEX IF NOT EXISTS "shop_repair_patterns_shop_top_idx"
  ON "shop_repair_patterns" ("shop_id", "occurrences");
