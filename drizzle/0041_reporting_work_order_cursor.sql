-- Operator-gated source-query prerequisite. Never execute through app startup.
-- Apply outside a transaction, one statement at a time, after capacity approval.
-- Only the work-order index is approved here; other source indexes remain separate.
-- Match lib/reporting-projection/source-query.ts cursor ordering exactly.
CREATE INDEX CONCURRENTLY IF NOT EXISTS reporting_src_nwo_cursor
ON public.normalized_work_orders (shop_id, (id::text COLLATE "C"));
--> statement-breakpoint
-- IF NOT EXISTS is not proof that a prior concurrent build finished.
DO $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_index
   WHERE indexrelid='public.reporting_src_nwo_cursor'::regclass
     AND indrelid='public.normalized_work_orders'::regclass
     AND indisvalid AND indisready
 ) THEN RAISE EXCEPTION 'Work-order reporting cursor index is not valid/ready';
 END IF;
END $$;
