-- Task #1183 — Missed Opportunities closed-RO window query speed.
--
-- The report filters and orders by coalesce(closed_date, completed_date),
-- which cannot use nwo_closed_date_idx (plain column index) nor prod's
-- out-of-band nwo_shop_wo_date_idx (3-arg coalesce incl. created_at — a
-- different expression, and falling back to created_at = import time would
-- be wrong for "closed at" anyway). Measured ~3-11s per shop per window on
-- the largest prod shops via a shop_id index scan + filter.
--
-- This composite expression index matches the query exactly:
--   WHERE shop_id = $1 AND coalesce(closed_date, completed_date) >= $2
--   ORDER BY coalesce(closed_date, completed_date) DESC LIMIT n
-- (backward index scan, no sort).
--
-- Idempotent. NOTE: plain CREATE INDEX here is fine for fresh/empty
-- environments; on populated prod build it out-of-band with
-- CREATE INDEX CONCURRENTLY (same name) instead — same convention as the
-- trgm indexes in 0019/0021.
CREATE INDEX IF NOT EXISTS nwo_shop_close_date_idx
  ON normalized_work_orders (shop_id, (COALESCE(closed_date, completed_date)));
