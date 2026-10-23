-- REVIEW ONLY. Not installed by migrations, startup, or deployment.
CREATE TABLE protractor_normalization_retries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id integer NOT NULL CHECK (shop_id > 0),
  provider_id uuid NOT NULL,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'completed', 'terminal')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz,
  claim_token uuid,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (shop_id, provider_id, payload_hash),
  CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'ID'
    AND jsonb_typeof(payload->'ID') = 'string' AND lower(payload->>'ID') = provider_id::text),
  CHECK (octet_length(payload::text) <= 8388608)
);
CREATE INDEX protractor_normalization_retries_ready
  ON protractor_normalization_retries (available_at, id)
  WHERE state IN ('pending', 'running');
-- Payload-free operational visibility; terminal rows never auto-reset.
CREATE VIEW protractor_normalization_retry_health AS
  SELECT shop_id, state, failure_code, count(*) AS items,
    min(created_at) AS oldest_intent, max(updated_at) AS latest_update
  FROM protractor_normalization_retries
  GROUP BY shop_id, state, failure_code;
