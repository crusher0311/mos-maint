-- Job-history search trigram indexes.
--
-- The extension/dashboard job-history search (lib/supabase-job-search.ts)
-- matches typed terms with leading-wildcard `ILIKE '%token%'` across
-- normalized_service_jobs.title / .description / .canned_job_name. A plain
-- b-tree cannot serve a leading-wildcard ILIKE, so the planner satisfied the
-- `ORDER BY created_at DESC LIMIT` by scanning nsj_created_at_idx backward and
-- filtering every row. For a common term ("brake") that finds the LIMIT fast,
-- but for a rare term, a multi-token AND, or a zero-match/typo it walked a huge
-- fraction of the rows and hit the statement timeout (>25s) — the "painfully
-- slow" search reported on large enterprise shops (e.g. the 7-shop HEART group,
-- ~246k service jobs).
--
-- pg_trgm + per-column `gin_trgm_ops` GIN indexes let those ILIKE predicates
-- use a Bitmap Index Scan (BitmapOr across the three columns, BitmapAnd across
-- tokens), turning the worst cases from a 25s timeout into sub-second.
--
-- IF NOT EXISTS keeps this idempotent and aligned with
-- scripts/apply-normalized-migration.ts. On production these indexes were
-- created with CREATE INDEX CONCURRENTLY (no write lock on the live table);
-- the plain CREATE INDEX below is for fresh environments where the table is
-- empty/small. To apply CONCURRENTLY on a populated DB, run each statement
-- outside a transaction.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "nsj_title_trgm_idx" ON "normalized_service_jobs" USING gin ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "nsj_description_trgm_idx" ON "normalized_service_jobs" USING gin ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "nsj_canned_job_name_trgm_idx" ON "normalized_service_jobs" USING gin ("canned_job_name" gin_trgm_ops);
