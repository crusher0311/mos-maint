-- Vehicle specs cache (task #901).
--
-- The Specs tab used to query the local DataOne Postgres on EVERY request
-- (wake-up retries could block 6+ seconds; ambiguous VINs ran the heavy spec
-- queries per candidate, then re-ran everything after a CARFAX decode hint).
-- Specs are static per vehicle, so cache the fully-resolved response payload
-- keyed by `<VIN>|<hintKey>` with a long TTL, following the dataone_cache
-- pattern (drizzle/0011). Rows keyed `hint|<VIN>` persist the resolved
-- disambiguation hint (including the CARFAX-derived one) so the double-decode
-- and CARFAX lookup happen at most once per vehicle.
--
-- IF NOT EXISTS keeps this idempotent and aligned with
-- scripts/apply-normalized-migration.ts.
CREATE TABLE IF NOT EXISTS "vehicle_specs_cache" (
  "cache_key" text PRIMARY KEY,
  "vin" text NOT NULL,
  "payload" jsonb NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "vehicle_specs_cache_vin_idx" ON "vehicle_specs_cache" ("vin");
CREATE INDEX IF NOT EXISTS "vehicle_specs_cache_expires_idx" ON "vehicle_specs_cache" ("expires_at");
