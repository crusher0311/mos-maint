-- Reporting KPI query support. These indexes match the bounded range and
-- relationship predicates used by the consolidated business/staff/event stages.
-- CONCURRENTLY keeps this canonical migration safe when rerun against populated
-- production tables. The migration runner executes each statement separately
-- because PostgreSQL forbids concurrent index builds inside a transaction block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS normalized_payments_shop_work_order_idx
  ON normalized_payments (shop_id, work_order_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS normalized_service_jobs_shop_work_order_idx
  ON normalized_service_jobs (shop_id, work_order_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS recommendation_events_shop_received_idx
  ON recommendation_events (shop_id, received_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS viewed_vins_shop_last_viewed_idx
  ON viewed_vins (shop_id, last_viewed_at);