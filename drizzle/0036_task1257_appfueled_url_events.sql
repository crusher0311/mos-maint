-- Task #1257: durable AppFueled vehicle URL webhook ingress. Additive and rerunnable.
CREATE TABLE IF NOT EXISTS appfueled_url_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id text NOT NULL,
  mos_shop_id integer NOT NULL,
  incoming_shop_id bigint NOT NULL,
  shop_id_namespace text NOT NULL,
  namespace_confirmation text NOT NULL,
  allowed_hosts jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL, updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz, disabled_by text, rotated_at timestamptz, rotated_by text,
  last_success_at timestamptz, last_receipt_id uuid,
  CONSTRAINT appfueled_url_connections_id_lengths_check CHECK (
    char_length(connection_id) BETWEEN 1 AND 128 AND
    token_hash ~ '^[0-9a-f]{64}$' AND
    jsonb_typeof(allowed_hosts) = 'array' AND jsonb_array_length(allowed_hosts) BETWEEN 1 AND 10
  ),
  CONSTRAINT appfueled_url_connections_provisioning_check CHECK (
    mos_shop_id > 0 AND incoming_shop_id > 0 AND incoming_shop_id <= 9007199254740991 AND
    shop_id_namespace IN ('mos', 'provider') AND char_length(namespace_confirmation) BETWEEN 10 AND 500
  ),
  CONSTRAINT appfueled_url_connections_mos_namespace_check CHECK (
    shop_id_namespace <> 'mos' OR incoming_shop_id = mos_shop_id
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS appfueled_url_connections_connection_id_uq ON appfueled_url_connections (connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS appfueled_url_connections_token_hash_uq ON appfueled_url_connections (token_hash);
CREATE INDEX IF NOT EXISTS appfueled_url_connections_shop_idx ON appfueled_url_connections (mos_shop_id);

CREATE TABLE IF NOT EXISTS appfueled_url_receipts (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES appfueled_url_connections(id) ON DELETE CASCADE,
  mos_shop_id integer NOT NULL,
  correlation_id uuid NOT NULL,
  received_at timestamptz NOT NULL, vin text, payload jsonb NOT NULL,
  outcome text NOT NULL,
  reason text NOT NULL, vehicle_url text,
  started_at timestamptz NOT NULL, ip_hash text NOT NULL, duration_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appfueled_url_receipts_bounds_check CHECK (
    mos_shop_id > 0 AND duration_ms >= 0 AND outcome IN ('accepted', 'rejected') AND
    (vin IS NULL OR vin ~ '^[A-HJ-NPR-Z0-9]{17}$') AND
    ip_hash ~ '^[0-9a-f]{64}$' AND
    octet_length(payload::text) <= 16384 AND
    char_length(reason) BETWEEN 1 AND 100 AND
    ((outcome = 'accepted' AND vin IS NOT NULL AND char_length(vehicle_url) BETWEEN 1 AND 2048) OR
     (outcome = 'rejected' AND vehicle_url IS NULL))
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS appfueled_url_receipts_connection_correlation_uq ON appfueled_url_receipts (connection_id, correlation_id);
CREATE INDEX IF NOT EXISTS appfueled_url_receipts_received_idx ON appfueled_url_receipts (received_at);
CREATE INDEX IF NOT EXISTS appfueled_url_receipts_shop_received_idx ON appfueled_url_receipts (mos_shop_id, received_at);
CREATE INDEX IF NOT EXISTS appfueled_url_receipts_connection_received_idx ON appfueled_url_receipts (connection_id, received_at);
CREATE INDEX IF NOT EXISTS appfueled_url_receipts_vin_received_idx ON appfueled_url_receipts (vin, received_at);
CREATE INDEX IF NOT EXISTS appfueled_url_receipts_outcome_received_idx ON appfueled_url_receipts (outcome, received_at);

CREATE TABLE IF NOT EXISTS appfueled_vehicle_urls (
  connection_id uuid NOT NULL REFERENCES appfueled_url_connections(id) ON DELETE CASCADE,
  mos_shop_id integer NOT NULL, vin text NOT NULL, vehicle_url text NOT NULL,
  last_received_at timestamptz NOT NULL, source_receipt_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, mos_shop_id, vin),
  CONSTRAINT appfueled_vehicle_urls_bounds_check CHECK (
    mos_shop_id > 0 AND vin ~ '^[A-HJ-NPR-Z0-9]{17}$' AND char_length(vehicle_url) BETWEEN 1 AND 2048
  )
);
CREATE INDEX IF NOT EXISTS appfueled_vehicle_urls_shop_vin_idx ON appfueled_vehicle_urls (mos_shop_id, vin);
CREATE INDEX IF NOT EXISTS appfueled_vehicle_urls_received_idx ON appfueled_vehicle_urls (last_received_at);

-- Fixed-window per-connection admission gate; expired buckets are swept by the cron.
CREATE TABLE IF NOT EXISTS appfueled_url_rate_buckets (
  bucket_key text PRIMARY KEY, count integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS appfueled_url_rate_buckets_expires_idx ON appfueled_url_rate_buckets (expires_at);

-- Supabase grants schema/table access to API roles in some projects. RLS with
-- no policies is intentional deny-by-default for anon/authenticated and keeps
-- token hashes, payload receipts, URLs and counters outside PostgREST.
--
-- ROLLOUT REQUIREMENT: before enabling the webhook, verify the MOS server
-- connection role owns these tables or has BYPASSRLS. A non-owner server role
-- without BYPASSRLS will correctly see zero rows and cannot operate the hook.
ALTER TABLE appfueled_url_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE appfueled_url_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE appfueled_vehicle_urls ENABLE ROW LEVEL SECURITY;
ALTER TABLE appfueled_url_rate_buckets ENABLE ROW LEVEL SECURITY;