-- Operator applied only. No runtime DDL, backfill, or canonical switch.
CREATE TABLE IF NOT EXISTS enterprise_vehicle_history_policies (
  enterprise_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  stage text NOT NULL DEFAULT 'performed' CHECK (stage IN ('performed', 'deferred', 'reconcile')),
  shop_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(shop_ids) = 'array'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Inspect pg_indexes first; create only in an operator-approved quiet window.
-- Run these separately with CONCURRENTLY in production, outside a transaction.
CREATE INDEX IF NOT EXISTS nwo_history_shop_vin_closed_idx
  ON normalized_work_orders (shop_id, (vehicle->>'vin'), closed_date DESC, id);
CREATE INDEX IF NOT EXISTS nsj_history_shop_work_order_idx
  ON normalized_service_jobs (shop_id, work_order_id, id);
