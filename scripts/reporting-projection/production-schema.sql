-- REVIEW CANDIDATE ONLY. Never installed by startup, deployment or this task.
-- Separate schema from the disposable prototype. See README for role/rollout requirements.
BEGIN;
SET LOCAL lock_timeout='2s';
CREATE TABLE public.invoice_repair_hold_scopes (
 shop_id integer NOT NULL CHECK(shop_id>0), provider text NOT NULL CHECK(provider='protractor'),
 revision bigint NOT NULL DEFAULT 0, PRIMARY KEY(shop_id,provider)
);
CREATE TABLE public.invoice_repair_holds (
 id text PRIMARY KEY, shop_id integer NOT NULL, provider text NOT NULL, source_id text,
 kind text NOT NULL CHECK(kind IN ('financial','ownership')),
 reason_reference text NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 resolved_by text, resolution_reference text, resolved_at timestamptz,
 FOREIGN KEY(shop_id,provider) REFERENCES public.invoice_repair_hold_scopes,
 CHECK ((resolved_at IS NULL AND resolved_by IS NULL AND resolution_reference IS NULL)
 OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_reference IS NOT NULL))
);
CREATE TABLE public.invoice_repair_hold_reviews (
 id text PRIMARY KEY, shop_id integer NOT NULL, provider text NOT NULL,
 scope_revision bigint NOT NULL, inventory_digest text NOT NULL,
 review_reference text NOT NULL, actor text NOT NULL,
 reviewed_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 FOREIGN KEY(shop_id,provider) REFERENCES public.invoice_repair_hold_scopes,
 CHECK(expires_at>reviewed_at)
);
CREATE INDEX invoice_repair_active_holds ON public.invoice_repair_holds(shop_id,provider,source_id) WHERE resolved_at IS NULL;
CREATE INDEX invoice_repair_coverage_reviews ON public.invoice_repair_hold_reviews(shop_id,provider,inventory_digest,scope_revision);
CREATE FUNCTION public.invoice_repair_hold_revision() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Repair holds are append/resolution only'; END IF;
 IF TG_OP='UPDATE' AND
 (NEW.id,NEW.shop_id,NEW.provider,NEW.source_id,NEW.kind,NEW.reason_reference,NEW.created_by,NEW.created_at)
 IS DISTINCT FROM
 (OLD.id,OLD.shop_id,OLD.provider,OLD.source_id,OLD.kind,OLD.reason_reference,OLD.created_by,OLD.created_at)
 THEN RAISE EXCEPTION 'Repair hold identity/evidence is immutable'; END IF;
 IF TG_OP='UPDATE' AND OLD.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'Resolved holds are immutable'; END IF;
 UPDATE public.invoice_repair_hold_scopes SET revision=revision+1 WHERE shop_id=NEW.shop_id AND provider=NEW.provider;
 RETURN NEW;
END $$;
CREATE TRIGGER invoice_repair_hold_changed BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_repair_holds
 FOR EACH ROW EXECUTE FUNCTION public.invoice_repair_hold_revision();
REVOKE ALL ON public.invoice_repair_hold_scopes,public.invoice_repair_holds,public.invoice_repair_hold_reviews FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoice_repair_hold_revision() FROM PUBLIC;
-- Supabase may have default API-role grants on new public tables.
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('REVOKE ALL ON public.invoice_repair_hold_scopes,public.invoice_repair_holds,public.invoice_repair_hold_reviews FROM %I',r);
  END IF;
 END LOOP;
END $$;
ALTER TABLE public.invoice_repair_hold_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_repair_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_repair_hold_reviews ENABLE ROW LEVEL SECURITY;
-- Fail closed if this role/schema already exists; never reuse an unverified role.
CREATE ROLE reporting_invoice_invalidator NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- PG16+ CREATEROLE grants administrative membership, but not SET permission.
-- Temporarily allow the installer to assign the function owner; remove SET below.
GRANT reporting_invoice_invalidator TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
CREATE SCHEMA reporting_invoice;
CREATE TABLE reporting_invoice.scopes (
 shop_id integer PRIMARY KEY CHECK(shop_id>0), revision bigint NOT NULL DEFAULT 0,
 published uuid, invalidated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE reporting_invoice.builds (
 id uuid PRIMARY KEY, shop_id integer NOT NULL REFERENCES reporting_invoice.scopes,
 revision bigint NOT NULL, parser_version text NOT NULL, channels jsonb NOT NULL,
 phase text NOT NULL DEFAULT 'inventory' CHECK(phase IN ('inventory','verify','project','complete','failed','cancelled')),
 channel integer NOT NULL DEFAULT 0, cursor text, digest text NOT NULL, inventory_digest text,
 document_count integer NOT NULL DEFAULT 0 CHECK(document_count BETWEEN 0 AND 1000000),
 identity_count integer NOT NULL DEFAULT 0 CHECK(identity_count BETWEEN 0 AND 100000),
 checkpoint text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 verified_at timestamptz, published_at timestamptz, failure text
);
CREATE UNIQUE INDEX reporting_invoice_active ON reporting_invoice.builds(shop_id)
 WHERE phase IN ('inventory','verify','project');
CREATE TABLE reporting_invoice.sources (
 build_id uuid NOT NULL REFERENCES reporting_invoice.builds ON DELETE CASCADE,
 channel text NOT NULL, source_key text NOT NULL, digest text NOT NULL,
 PRIMARY KEY(build_id,channel,source_key)
);
CREATE TABLE reporting_invoice.items (
 build_id uuid NOT NULL REFERENCES reporting_invoice.builds ON DELETE CASCADE,
 identity text NOT NULL, input_digest text, classification text, reason text,
 invoice_date timestamptz, sold numeric CHECK(sold>=0), presented numeric CHECK(presented>=0),
 review_id uuid, hold_review_id text,
 PRIMARY KEY(build_id,identity),
 CHECK(classification IS NULL OR classification IN ('verified','unresolved','noninvoice'))
);
CREATE TABLE reporting_invoice.refs (
 build_id uuid NOT NULL, identity text NOT NULL, channel text NOT NULL, source_key text NOT NULL,
 digest text NOT NULL, owner text, ambiguous boolean NOT NULL,
 PRIMARY KEY(build_id,identity,channel,source_key),
 FOREIGN KEY(build_id,identity) REFERENCES reporting_invoice.items ON DELETE CASCADE
);
-- Externally reviewed accounting/ownership evidence, NOT populated by worker or request input.
-- Only a separately authorized review role may write here. No approval API is installed.
CREATE TABLE reporting_invoice.reviews (
 id uuid PRIMARY KEY, shop_id integer NOT NULL, identity text NOT NULL,
 input_digest text NOT NULL, inventory_digest text NOT NULL, parser_version text NOT NULL,
 disposition text NOT NULL CHECK(disposition IN ('invoice','noninvoice')),
 owner_reference text NOT NULL CHECK(length(owner_reference)>=8),
 accounting_reference text NOT NULL CHECK(length(accounting_reference)>=8),
 actor text NOT NULL CHECK(length(actor)>=8),
 reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz, CHECK(expires_at>reviewed_at)
);
CREATE INDEX reporting_invoice_reviews ON reporting_invoice.reviews(shop_id,identity,input_digest,inventory_digest);
CREATE TABLE reporting_invoice.change_cursors (
 name text PRIMARY KEY, resume_token jsonb, observed_at timestamptz NOT NULL DEFAULT 'epoch'
);
-- Install triggers only after separate schema/index/role review. Covers canonical
-- owner, financial-child, cache and registry changes (including deletes/TRUNCATE).
CREATE FUNCTION reporting_invoice.invalidate_statement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 UPDATE reporting_invoice.scopes SET revision=revision+1,invalidated_at=clock_timestamp();
 RETURN NULL;
END $$;
-- The function owner cannot write operational records, reviews, holds, facts or
-- cursors. Application writers receive no reporting privileges or membership.
GRANT USAGE, CREATE ON SCHEMA reporting_invoice TO reporting_invoice_invalidator;
GRANT SELECT(revision), UPDATE(revision,invalidated_at)
 ON reporting_invoice.scopes TO reporting_invoice_invalidator;
ALTER FUNCTION reporting_invoice.invalidate_statement() OWNER TO reporting_invoice_invalidator;
REVOKE CREATE ON SCHEMA reporting_invoice FROM reporting_invoice_invalidator;
REVOKE SET OPTION FOR reporting_invoice_invalidator FROM CURRENT_USER;
-- Fleet-wide conservative invalidation avoids incorrect scope inference from deleted
-- rows or moved owners. No raw invoice data is persisted by this trigger.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['normalized_work_orders','normalized_service_jobs','normalized_line_items',
  'normalized_payments','protractor_work_orders','protractor_invoices','protractor_invoice_cache',
  'invoice_repair_hold_scopes','invoice_repair_holds','invoice_repair_hold_reviews']
 LOOP
  EXECUTE format('CREATE TRIGGER reporting_invoice_invalidate AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION reporting_invoice.invalidate_statement()','public',t);
 END LOOP;
END $$;
CREATE TRIGGER reporting_invoice_review_invalidate AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE
 ON reporting_invoice.reviews FOR EACH STATEMENT EXECUTE FUNCTION reporting_invoice.invalidate_statement();
REVOKE ALL ON SCHEMA reporting_invoice FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA reporting_invoice FROM PUBLIC;
REVOKE ALL ON FUNCTION reporting_invoice.invalidate_statement() FROM PUBLIC;
CREATE ROLE reporting_invoice_builder NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT reporting_invoice_builder TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
GRANT USAGE ON SCHEMA reporting_invoice,public TO reporting_invoice_builder;
GRANT SELECT,INSERT,UPDATE,DELETE ON reporting_invoice.scopes,reporting_invoice.builds,
 reporting_invoice.sources,reporting_invoice.items,reporting_invoice.refs,reporting_invoice.change_cursors TO reporting_invoice_builder;
GRANT SELECT ON reporting_invoice.reviews,public.invoice_repair_hold_scopes,public.invoice_repair_holds,
 public.invoice_repair_hold_reviews TO reporting_invoice_builder;
CREATE POLICY reporting_builder_read ON public.invoice_repair_hold_scopes FOR SELECT TO reporting_invoice_builder USING(true);
CREATE POLICY reporting_builder_read ON public.invoice_repair_holds FOR SELECT TO reporting_invoice_builder USING(true);
CREATE POLICY reporting_builder_read ON public.invoice_repair_hold_reviews FOR SELECT TO reporting_invoice_builder USING(true);
COMMIT;
