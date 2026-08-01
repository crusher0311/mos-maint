-- support_tickets Mongo→PG cutover bridge columns (task #1000, PACKAGE 4).
--
-- The PG `support_tickets` table (lib/db/schema/support-tickets.ts) uses a
-- `serial` primary key, but the legacy Mongo repo interface
-- (lib/data/repositories/support-tickets.ts) hands callers ObjectId **string**
-- ids and validates them with `ObjectId.isValid(...)`. To keep that string-id
-- contract across the flag flip we bridge identity through a text column:
--
--   * `mongo_id` — the canonical string id returned to callers. For rows
--     backfilled from Mongo this is the original `_id` hex string; for
--     tickets created directly in PG (while PG-canonical) it's a freshly
--     generated 24-char ObjectId-shaped hex string, so callers'
--     `ObjectId.isValid()` guards keep passing.
--
-- Also add `closed_at` / `auto_closed_at` (the Mongo repo sets these on the
-- resolved→closed sweep) which the original PG schema omitted.
--
-- IF NOT EXISTS / ADD COLUMN IF NOT EXISTS keeps this idempotent and aligned
-- with scripts/apply-normalized-migration.ts.
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "mongo_id" text;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "closed_at" timestamptz;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "auto_closed_at" timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS "support_tickets_mongo_id_key"
  ON "support_tickets" ("mongo_id");
