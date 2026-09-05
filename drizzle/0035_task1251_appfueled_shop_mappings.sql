CREATE TABLE IF NOT EXISTS appfueled_shop_mappings (
  namespace text NOT NULL DEFAULT 'live_api',
  external_shop_id text NOT NULL,
  mos_shop_id integer NOT NULL,
  provider text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  disabled_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT appfueled_shop_mappings_pk PRIMARY KEY (namespace, external_shop_id),
  CONSTRAINT appfueled_shop_mappings_namespace_check CHECK (namespace = 'live_api'),
  CONSTRAINT appfueled_shop_mappings_provider_check CHECK (
    provider IN ('tekmetric', 'shopware', 'protractor', 'autoflow', 'shopmonkey')
  )
);
CREATE INDEX IF NOT EXISTS appfueled_shop_mappings_shop_provider_idx
  ON appfueled_shop_mappings (mos_shop_id, provider);