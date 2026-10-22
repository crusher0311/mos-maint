-- Operator-gated; run outside a transaction after capacity approval.
-- Not part of automatic startup or deployment.
CREATE INDEX CONCURRENTLY IF NOT EXISTS reporting_src_lines_cursor
ON public.normalized_line_items (shop_id, (id::text COLLATE "C"));
--> statement-breakpoint
DO $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_index WHERE indexrelid='public.reporting_src_lines_cursor'::regclass
   AND indrelid='public.normalized_line_items'::regclass AND indisvalid AND indisready
 ) THEN RAISE EXCEPTION 'Line-item cursor index is not valid/ready'; END IF;
END $$;
