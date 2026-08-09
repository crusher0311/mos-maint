-- Sales script cache (task #987, feature/sales-coach branch).
--
-- Dashboard "Sales Coach" feature: generates an AI sales script for an open
-- work order's estimate. Scripts are cached per (work_order_id, context_hash)
-- so an advisor viewing a script repeatedly costs one OpenAI call; a changed
-- estimate produces a new hash and a fresh script.
--
-- IF NOT EXISTS keeps this idempotent and aligned with
-- scripts/apply-normalized-migration.ts.
CREATE TABLE IF NOT EXISTS "sales_script_cache" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" integer NOT NULL,
  "work_order_id" varchar NOT NULL,
  "context_hash" text NOT NULL,
  "script" jsonb NOT NULL,
  "model" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "ssc_wo_hash_idx" ON "sales_script_cache" ("work_order_id", "context_hash");
CREATE INDEX IF NOT EXISTS "ssc_shop_id_idx" ON "sales_script_cache" ("shop_id");
