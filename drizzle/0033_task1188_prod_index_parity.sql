-- Task #1188 — bring prod-only hand-created indexes into the codebase.
--
-- Prod Supabase had five indexes on normalized_* tables that existed nowhere
-- in drizzle/ (created out-of-band during past incidents). If prod were ever
-- rebuilt from migrations, or a fresh environment stood up via
-- npm run db:migrate:normalized, they would silently vanish and the queries
-- below would fall back to multi-second scans. All five are live per
-- pg_stat_user_indexes (idx_scan 546–2121 as of 2026-08-25):
--
--   * nc_shop_updated_idx / nv_shop_updated_idx / nwo_shop_updated_idx —
--     per-shop incremental/"what changed since" reads ordered by updated_at.
--   * nsj_shop_sj_date_idx — per-shop service-job history windows on
--     COALESCE(completed_at, created_at).
--   * nwo_shop_wo_date_idx — per-shop WO date windows on the 3-arg
--     COALESCE(closed_date, completed_date, created_at). NOTE: this is a
--     DIFFERENT expression from 0032's nwo_shop_close_date_idx (2-arg
--     coalesce); Postgres only matches byte-identical expressions, so both
--     are needed.
--
-- INTENTIONALLY DROPPED (documented, not recreated): prod also carries five
-- whole-provenance GIN indexes — nc/nli/nsj/nv/nwo_provenance_gin_idx
-- (USING gin (provenance jsonb_path_ops)). All five show idx_scan = 0 on
-- prod; the query paths they were built for are served by the narrower
-- (provenance->'sourceIds') GIN indexes (drizzle/0017) and the
-- (provenance->>'contentHash') btree indexes (drizzle/0005). They are not
-- carried into migrations; an operator may DROP them on prod out-of-band to
-- reclaim space/write overhead.
--
-- Idempotent. Plain CREATE INDEX is fine for fresh/empty environments; on a
-- populated prod table build them out-of-band with CREATE INDEX CONCURRENTLY
-- (same names) — same convention as 0019/0021/0032. (On prod these five
-- already exist, so this file is a no-op there.)
CREATE INDEX IF NOT EXISTS nc_shop_updated_idx
  ON normalized_customers (shop_id, updated_at);
CREATE INDEX IF NOT EXISTS nv_shop_updated_idx
  ON normalized_vehicles (shop_id, updated_at);
CREATE INDEX IF NOT EXISTS nwo_shop_updated_idx
  ON normalized_work_orders (shop_id, updated_at);
CREATE INDEX IF NOT EXISTS nsj_shop_sj_date_idx
  ON normalized_service_jobs (shop_id, (COALESCE(completed_at, created_at)));
CREATE INDEX IF NOT EXISTS nwo_shop_wo_date_idx
  ON normalized_work_orders (shop_id, (COALESCE(closed_date, completed_date, created_at)));
