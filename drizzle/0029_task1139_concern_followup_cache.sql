-- Concern follow-up question cache (task #1139).
--
-- Caches the AI-generated follow-up questions for the Customer Concern
-- Assistant, keyed by a hash of the normalized concern text and a
-- prompt-version constant. This makes repeat uses of common concerns
-- (e.g. "brake noise", "check engine light") near-instant with no OpenAI
-- call. Unusual/first-time concerns still call OpenAI live and are then
-- cached for subsequent shops.
--
-- Skip-learning (per-shop question avoidance) is applied as a post-filter
-- at read time — the cache stores generic questions independent of any
-- shop's hint state.
--
-- TTL is enforced by the application (30-day DEFAULT; caller checks
-- created_at + interval).
--
-- IF NOT EXISTS keeps this idempotent and aligned with
-- scripts/apply-normalized-migration.ts.
CREATE TABLE IF NOT EXISTS "concern_followup_cache" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "concern_hash" text NOT NULL,
  "questions" jsonb NOT NULL,
  "prompt_version" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "cfc_concern_hash_idx" ON "concern_followup_cache" ("concern_hash");
CREATE INDEX IF NOT EXISTS "cfc_created_at_idx" ON "concern_followup_cache" ("created_at");
