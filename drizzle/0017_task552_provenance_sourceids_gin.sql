-- Task #552 (W3a cutover): PG-canonical change-detection.
--
-- The normalized-ingestion service now decides create/update/skip by reading
-- Postgres (natural-key lookup) instead of Mongo. For customers and work
-- orders the lookup is `shop_id = $1 AND provenance->'sourceIds' @> $2`, and
-- for service_jobs / line_items / payments it is the parent FK plus the same
-- containment predicate. Without a GIN index that containment seq-scans on the
-- hot ingest path, so add a `jsonb_path_ops` GIN index on
-- `(provenance -> 'sourceIds')` for each of the six normalized tables.
--
-- IF NOT EXISTS keeps this idempotent and aligned with
-- scripts/apply-normalized-migration.ts (the idempotent apply path used for
-- the normalized tables). jsonb_path_ops supports only the `@>` operator,
-- which is exactly what the change-detection lookups use, and is smaller than
-- the default jsonb_ops.
CREATE INDEX IF NOT EXISTS "nv_provenance_source_ids_idx" ON "normalized_vehicles" USING gin ((provenance -> 'sourceIds') jsonb_path_ops);
CREATE INDEX IF NOT EXISTS "nc_provenance_source_ids_idx" ON "normalized_customers" USING gin ((provenance -> 'sourceIds') jsonb_path_ops);
CREATE INDEX IF NOT EXISTS "nwo_provenance_source_ids_idx" ON "normalized_work_orders" USING gin ((provenance -> 'sourceIds') jsonb_path_ops);
CREATE INDEX IF NOT EXISTS "nsj_provenance_source_ids_idx" ON "normalized_service_jobs" USING gin ((provenance -> 'sourceIds') jsonb_path_ops);
CREATE INDEX IF NOT EXISTS "nli_provenance_source_ids_idx" ON "normalized_line_items" USING gin ((provenance -> 'sourceIds') jsonb_path_ops);
CREATE INDEX IF NOT EXISTS "np_provenance_source_ids_idx" ON "normalized_payments" USING gin ((provenance -> 'sourceIds') jsonb_path_ops);
