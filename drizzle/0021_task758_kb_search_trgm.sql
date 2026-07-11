-- Knowledge-base search trigram indexes (task #758).
--
-- The KB search (lib/db/repositories/wave1.ts :: pgSearchArticleCandidates)
-- matches typed terms with leading-wildcard `ILIKE '%term%'` across
-- knowledge_articles.title / .problem / .solution / .category. A plain b-tree
-- cannot serve a leading-wildcard ILIKE, so those predicates seq-scan the whole
-- table — the same class of full-scan slowness fixed for job-search in
-- drizzle/0019_job_search_trgm.sql.
--
-- pg_trgm + per-column `gin_trgm_ops` GIN indexes let those ILIKE predicates
-- use a Bitmap Index Scan (BitmapOr across the columns) instead of a seq scan.
-- Terms shorter than 3 chars have no trigram and fall back to a scan, which is
-- fine for a rare edge case.
--
-- IF NOT EXISTS keeps this idempotent and aligned with
-- scripts/apply-normalized-migration.ts. On a populated production table apply
-- each CREATE INDEX with CONCURRENTLY (outside a transaction) to avoid a write
-- lock; the plain CREATE INDEX below is for fresh/empty environments.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "knowledge_articles_title_trgm_idx" ON "knowledge_articles" USING gin ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "knowledge_articles_problem_trgm_idx" ON "knowledge_articles" USING gin ("problem" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "knowledge_articles_solution_trgm_idx" ON "knowledge_articles" USING gin ("solution" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "knowledge_articles_category_trgm_idx" ON "knowledge_articles" USING gin ("category" gin_trgm_ops);
