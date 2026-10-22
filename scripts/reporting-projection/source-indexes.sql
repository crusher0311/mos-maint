-- REVIEW ONLY. Separate production approval and capacity plan required.
-- Run ONE statement at a time outside a transaction, with operator cancellation,
-- statement_timeout and independent health probes. Never run at app startup.
-- Existing equivalent/invalid indexes must be checked first, not masked by IF NOT EXISTS.
CREATE INDEX CONCURRENTLY reporting_src_nwo_cursor ON public.normalized_work_orders (shop_id, (id::text COLLATE "C"));
CREATE INDEX CONCURRENTLY reporting_src_jobs_cursor ON public.normalized_service_jobs (shop_id, (id::text COLLATE "C"));
CREATE INDEX CONCURRENTLY reporting_src_lines_cursor ON public.normalized_line_items (shop_id, (id::text COLLATE "C"));
CREATE INDEX CONCURRENTLY reporting_src_payments_cursor ON public.normalized_payments (shop_id, (id::text COLLATE "C"));
CREATE INDEX CONCURRENTLY reporting_src_wo_cursor ON public.protractor_work_orders (shop_id, (work_order_id::text COLLATE "C"));
CREATE INDEX CONCURRENTLY reporting_src_invoices_cursor ON public.protractor_invoices (shop_id, (invoice_id::text COLLATE "C"));
CREATE INDEX CONCURRENTLY reporting_src_cache_cursor ON public.protractor_invoice_cache (shop_id, (invoice_id::text COLLATE "C"));
