-- Operator-gated; execute statements individually, outside a transaction,
-- with capacity approval and independent health monitoring between builds.
-- Not part of automatic startup or deployment.
CREATE INDEX CONCURRENTLY IF NOT EXISTS reporting_src_payments_cursor
ON public.normalized_payments (shop_id, (id::text COLLATE "C"));
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS reporting_src_wo_cursor
ON public.protractor_work_orders (shop_id, (work_order_id::text COLLATE "C"));
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS reporting_src_invoices_cursor
ON public.protractor_invoices (shop_id, (invoice_id::text COLLATE "C"));
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS reporting_src_cache_cursor
ON public.protractor_invoice_cache (shop_id, (invoice_id::text COLLATE "C"));
--> statement-breakpoint
DO $$
DECLARE target record;
BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('reporting_src_payments_cursor','normalized_payments'),
  ('reporting_src_wo_cursor','protractor_work_orders'),
  ('reporting_src_invoices_cursor','protractor_invoices'),
  ('reporting_src_cache_cursor','protractor_invoice_cache')
 ) AS targets(index_name,table_name)
 LOOP
  IF NOT EXISTS (
   SELECT 1 FROM pg_index
   WHERE indexrelid=to_regclass('public.'||target.index_name)
     AND indrelid=to_regclass('public.'||target.table_name)
     AND indisvalid AND indisready
  ) THEN RAISE EXCEPTION 'Cursor index % is not valid/ready', target.index_name;
  END IF;
 END LOOP;
END $$;
