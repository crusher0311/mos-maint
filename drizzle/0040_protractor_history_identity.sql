-- Operator-gated production prerequisite; never run automatically from this repl.
-- v1 is immutable in meaning: change the name and rebuild the index for any semantic change.
CREATE OR REPLACE FUNCTION public.protractor_identity_keys_v1(p jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $fn$
 SELECT coalesce(array_agg(lower(s->>'idValue'))
   FILTER (WHERE s->>'system'='protractor' AND s->>'idValue' IS NOT NULL), ARRAY[]::text[])
 FROM jsonb_array_elements(p->'sourceIds') s
$fn$;
--> statement-breakpoint
-- Inspect indisvalid/indisready: IF NOT EXISTS does not repair a failed concurrent build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS nwo_protractor_identity_keys_v1_idx
ON public.normalized_work_orders USING gin (public.protractor_identity_keys_v1(provenance));
