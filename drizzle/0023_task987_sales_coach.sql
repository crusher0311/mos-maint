-- Sales coaching trainer (task #987, feature/sales-coach branch).
--
-- Private platform-admin practice tool: a daily job snapshots 3-5 real work
-- orders (declined work / large estimates / routine) into
-- sales_coach_scenarios; admins record a sales pitch against a scenario and
-- the transcript + AI feedback are retained in sales_coach_sessions as a
-- growing training corpus. Audio is stored inline (bytea) to stay
-- self-contained — no new object-store dependency.
--
-- IF NOT EXISTS keeps this idempotent and aligned with
-- scripts/apply-normalized-migration.ts.
CREATE TABLE IF NOT EXISTS "sales_coach_scenarios" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "scenario_date" text NOT NULL,
  "scenario_type" text NOT NULL,
  "shop_id" integer NOT NULL,
  "work_order_id" varchar NOT NULL,
  "work_order_number" text,
  "context" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
-- One scenario per RO, ever — this is the "same RO isn't re-served" marker.
CREATE UNIQUE INDEX IF NOT EXISTS "scs_work_order_id_idx" ON "sales_coach_scenarios" ("work_order_id");
CREATE INDEX IF NOT EXISTS "scs_scenario_date_idx" ON "sales_coach_scenarios" ("scenario_date");

CREATE TABLE IF NOT EXISTS "sales_coach_sessions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "scenario_id" varchar NOT NULL REFERENCES "sales_coach_scenarios"("id"),
  "user_email" text NOT NULL,
  "audio" "bytea",
  "audio_mime" text,
  "audio_bytes" integer,
  "duration_sec" integer,
  "transcript" text,
  "transcription_provider" text,
  "feedback" jsonb,
  "score" integer,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "scsn_scenario_id_idx" ON "sales_coach_sessions" ("scenario_id");
CREATE INDEX IF NOT EXISTS "scsn_created_at_idx" ON "sales_coach_sessions" ("created_at");
