-- Task #1161 — slow-query analyzer capture table (Mongo + PG slow ops).
-- Idempotent: safe to re-run against an existing environment.

CREATE TABLE IF NOT EXISTS slow_queries (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  db VARCHAR(8) NOT NULL,
  operation VARCHAR(40) NOT NULL,
  target VARCHAR(200),
  shape TEXT NOT NULL,
  shape_hash VARCHAR(40) NOT NULL,
  duration_ms INTEGER NOT NULL,
  rows_returned INTEGER,
  docs_examined INTEGER,
  source VARCHAR(120),
  caller VARCHAR(300)
);

CREATE INDEX IF NOT EXISTS slow_queries_ts_idx ON slow_queries (ts);
CREATE INDEX IF NOT EXISTS slow_queries_duration_idx ON slow_queries (duration_ms);
CREATE INDEX IF NOT EXISTS slow_queries_shape_hash_idx ON slow_queries (shape_hash);
CREATE INDEX IF NOT EXISTS slow_queries_target_idx ON slow_queries (target);

-- Shared spike-alert incident state: one row, claimed/cleared atomically so
-- alert dedup survives web autoscaling (module state does not).
CREATE TABLE IF NOT EXISTS slow_query_alert_state (
  id SMALLINT PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  last_alert_at TIMESTAMPTZ
);
INSERT INTO slow_query_alert_state (id, active, last_alert_at)
VALUES (1, FALSE, NULL)
ON CONFLICT (id) DO NOTHING;
