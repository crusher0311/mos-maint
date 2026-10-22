-- REVIEW CANDIDATE ONLY. Never installed by startup, deployment or this task.
-- Separate schema from the disposable prototype. See README for role/rollout requirements.
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
 review_id uuid, hold_review_id uuid,
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
CREATE FUNCTION reporting_invoice.invalidate_statement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE reporting_invoice.scopes SET revision=revision+1,invalidated_at=clock_timestamp();
 RETURN NULL;
END $$;
-- Fleet-wide conservative invalidation avoids incorrect scope inference from deleted
-- rows or moved owners. No raw invoice data is persisted by this trigger.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['normalized_work_orders','normalized_service_jobs','normalized_line_items',
  'normalized_payments','protractor_work_orders','protractor_invoices','protractor_invoice_cache',
  'invoice_repair_hold_scopes','invoice_repair_holds','invoice_repair_hold_reviews']
 LOOP
  EXECUTE format('CREATE TRIGGER reporting_invoice_invalidate AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reporting_invoice.invalidate_statement()',t);
 END LOOP;
END $$;
CREATE TRIGGER reporting_invoice_review_invalidate AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE
 ON reporting_invoice.reviews FOR EACH STATEMENT EXECUTE FUNCTION reporting_invoice.invalidate_statement();
REVOKE ALL ON SCHEMA reporting_invoice FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA reporting_invoice FROM PUBLIC;
