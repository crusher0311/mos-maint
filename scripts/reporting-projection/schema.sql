-- LOCAL PROTOTYPE ONLY. Not a deploy/startup migration.
CREATE SCHEMA invoice_projection;
CREATE TABLE invoice_projection.builds (
 id uuid PRIMARY KEY,
 shop_id integer NOT NULL CHECK (shop_id > 0),
 manifest_digest text NOT NULL,
 parser_version text NOT NULL,
 expected_count integer NOT NULL CHECK (expected_count BETWEEN 0 AND 100000),
 checkpoint integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'building' CHECK (state IN ('building','complete','failed')),
 published boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 CHECK (checkpoint BETWEEN 0 AND expected_count),
 CHECK (NOT published OR (state = 'complete' AND checkpoint = expected_count))
);
CREATE UNIQUE INDEX one_published_shop ON invoice_projection.builds(shop_id) WHERE published;
CREATE TABLE invoice_projection.facts (
 build_id uuid NOT NULL REFERENCES invoice_projection.builds(id),
 ordinal integer NOT NULL,
 provider_id text NOT NULL,
 input_digest text NOT NULL,
 classification text NOT NULL CHECK (classification IN ('verified','unresolved')),
 reason text NOT NULL,
 invoice_date timestamptz,
 sold numeric,
 presented numeric,
 PRIMARY KEY (build_id, provider_id),
 UNIQUE(build_id, ordinal),
 CHECK (sold IS NULL OR sold >= 0),
 CHECK (presented IS NULL OR presented >= 0),
 CHECK (classification <> 'verified' OR invoice_date IS NOT NULL)
);
CREATE INDEX invoice_date_lookup ON invoice_projection.facts(build_id, invoice_date);
CREATE TABLE invoice_projection.evidence (
 build_id uuid NOT NULL,
 provider_id text NOT NULL,
 source_ref text NOT NULL,
 source_digest text NOT NULL,
 PRIMARY KEY(build_id,provider_id,source_ref),
 FOREIGN KEY(build_id,provider_id) REFERENCES invoice_projection.facts(build_id,provider_id)
);
