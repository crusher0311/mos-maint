-- Task #382 — ACES IDs on normalized_vehicles + job_index.
--
-- Additive only. Existing readers ignore the new columns; the scorer in
-- lib/job-scoring.ts treats absent IDs as "fall back to legacy heuristic"
-- so this migration is safe to roll forward without coordination.
--
-- See lib/db/schema/normalized.ts (normalizedVehicles) and
-- lib/db/schema/wave3.ts (jobIndex) for the source-of-truth Drizzle defs.

ALTER TABLE "normalized_vehicles"
  ADD COLUMN IF NOT EXISTS "aces_vehicle_id" integer,
  ADD COLUMN IF NOT EXISTS "aces_engine_id" integer,
  ADD COLUMN IF NOT EXISTS "aces_decoded_at" timestamp;

ALTER TABLE "job_index"
  ADD COLUMN IF NOT EXISTS "aces_vehicle_id" integer,
  ADD COLUMN IF NOT EXISTS "aces_engine_id" integer;

CREATE INDEX IF NOT EXISTS "ji_aces_vehicle_idx" ON "job_index" ("aces_vehicle_id");
CREATE INDEX IF NOT EXISTS "ji_aces_engine_idx" ON "job_index" ("aces_engine_id");
CREATE INDEX IF NOT EXISTS "nv_aces_vehicle_idx" ON "normalized_vehicles" ("aces_vehicle_id");
CREATE INDEX IF NOT EXISTS "nv_aces_engine_idx" ON "normalized_vehicles" ("aces_engine_id");
