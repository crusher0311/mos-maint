-- Additive only. Operator-applied before enabling native webhooks.
-- No FK to shops: deployments may use Mongo-canonical shops.
CREATE TABLE IF NOT EXISTS appfueled_connections (
  shop_id integer PRIMARY KEY CHECK (shop_id > 0),
  connection_hash text NOT NULL,
  credentials_ciphertext text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  disabled_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS appfueled_connections_hash_unique
  ON appfueled_connections(connection_hash);
CREATE TABLE IF NOT EXISTS appfueled_webhook_limits (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL
);
