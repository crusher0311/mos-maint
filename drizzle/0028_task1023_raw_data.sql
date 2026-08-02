-- Task #1023 — schema-drift check found lib/db/schema/normalized.ts declares
-- raw_data jsonb on the six core normalized_* tables, but the hand-written
-- CREATE TABLE statements in scripts/apply-normalized-migration.ts predate
-- that column, so fresh environments were missing it (writers that include
-- rawData would fail with "column does not exist").
-- Idempotent: safe to re-run anywhere, no-op where the column already exists.
ALTER TABLE IF EXISTS "normalized_vehicles" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;
ALTER TABLE IF EXISTS "normalized_customers" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;
ALTER TABLE IF EXISTS "normalized_work_orders" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;
ALTER TABLE IF EXISTS "normalized_service_jobs" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;
ALTER TABLE IF EXISTS "normalized_line_items" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;
ALTER TABLE IF EXISTS "normalized_payments" ADD COLUMN IF NOT EXISTS "raw_data" jsonb;
