-- Opaque extension sessions. Tokens are SHA-256 hashes only; Basic rows have no user_id.
CREATE TABLE IF NOT EXISTS "extension_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
  "shop_id" integer NOT NULL REFERENCES "shops"("mos_shop_id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "assurance" text NOT NULL,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
  ,CONSTRAINT "extension_sessions_assurance_check"
    CHECK ("assurance" IN ('basic', 'verified'))
  ,CONSTRAINT "extension_sessions_provider_check"
    CHECK ("provider" IN ('tekmetric', 'protractor', 'shopware', 'shopmonkey', 'autoflow'))
  ,CONSTRAINT "extension_sessions_identity_check"
    CHECK (
      ("assurance" = 'basic' AND "user_id" IS NULL)
      OR ("assurance" = 'verified' AND "user_id" IS NOT NULL)
    )
  ,CONSTRAINT "extension_sessions_capabilities_array_check"
    CHECK (jsonb_typeof("capabilities") = 'array')
);
CREATE UNIQUE INDEX IF NOT EXISTS "extension_sessions_token_hash_uniq" ON "extension_sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "extension_sessions_active_shop_idx" ON "extension_sessions" ("shop_id", "expires_at");
CREATE INDEX IF NOT EXISTS "extension_sessions_user_idx" ON "extension_sessions" ("user_id");

-- One-time consumption ledger for direct-provider action grants. The grant is
-- hashed; the signed bearer itself is never stored.
CREATE TABLE IF NOT EXISTS "extension_action_grant_uses" (
  "grant_hash" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL REFERENCES "extension_sessions"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "extension_action_grant_uses_expires_idx"
  ON "extension_action_grant_uses" ("expires_at");