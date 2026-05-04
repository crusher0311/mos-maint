-- Wave 4 (task #346) — identity, sessions, billing & settings.
-- See lib/db/schema/wave4.ts for the source-of-truth Drizzle definitions.

CREATE TABLE IF NOT EXISTS "enterprise_accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "shop_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "shared_mappings" jsonb,
  "shared_integrations" jsonb,
  "feature_settings" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "enterprise_accounts_name_idx" ON "enterprise_accounts" ("name");

CREATE TABLE IF NOT EXISTS "shops" (
  "mos_shop_id" integer PRIMARY KEY NOT NULL,
  "legacy_id" integer,
  "name" text,
  "location_identifier" text,
  "enterprise_id" text REFERENCES "enterprise_accounts"("id") ON DELETE SET NULL,
  "enabled_features" jsonb,
  "billing" jsonb,
  "billing_plan" text,
  "billing_status" text,
  "stripe_customer_id" text,
  "settings" jsonb,
  "sticker" jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shops_legacy_id_idx" ON "shops" ("legacy_id");
CREATE INDEX IF NOT EXISTS "shops_enterprise_idx" ON "shops" ("enterprise_id");
CREATE INDEX IF NOT EXISTS "shops_stripe_customer_idx" ON "shops" ("stripe_customer_id");
CREATE INDEX IF NOT EXISTS "shops_billing_status_idx" ON "shops" ("billing_status");

CREATE TABLE IF NOT EXISTS "users" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "email_lower" text NOT NULL,
  "password_hash" text,
  "role" text DEFAULT 'owner' NOT NULL,
  -- FK declared NOT VALID so the initial backfill can land users whose
  -- referenced shop hasn't been replayed yet (the dependency-ordered
  -- `--mirror=all-w4` backfill keeps shops first, but reruns and
  -- partial backfills must remain idempotent). After the W4 backfill
  -- completes, the runbook calls
  --   ALTER TABLE users VALIDATE CONSTRAINT users_shop_id_fkey;
  -- to promote it to a fully-validated FK.
  "shop_id" integer,
  "shop_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "is_platform_admin" boolean DEFAULT false NOT NULL,
  "must_change_password" boolean DEFAULT false NOT NULL,
  "extension_token" text,
  "extension_token_created_at" timestamp with time zone,
  "profile" jsonb,
  "audit_meta" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_uniq" ON "users" ("email_lower");
CREATE UNIQUE INDEX IF NOT EXISTS "users_extension_token_uniq" ON "users" ("extension_token");
CREATE INDEX IF NOT EXISTS "users_shop_idx" ON "users" ("shop_id");
CREATE INDEX IF NOT EXISTS "users_platform_admin_idx" ON "users" ("is_platform_admin");

-- Add the users.shop_id FK after the shops table exists. NOT VALID lets
-- the constraint apply to new writes immediately while leaving the
-- (potentially-orphaned) historical Mongo rows for the post-window
-- VALIDATE step in the runbook.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_shop_id_fkey'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_shop_id_fkey"
      FOREIGN KEY ("shop_id") REFERENCES "shops"("mos_shop_id")
      ON DELETE SET NULL NOT VALID;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "sessions" (
  "token" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "shop_id" integer,
  "is_impersonation" boolean DEFAULT false NOT NULL,
  "impersonated_by" text,
  "must_change_password" boolean DEFAULT false NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "sessions_expires_idx" ON "sessions" ("expires_at");

CREATE TABLE IF NOT EXISTS "shop_users" (
  "shop_id" integer NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("shop_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "shop_users_user_idx" ON "shop_users" ("user_id");

CREATE TABLE IF NOT EXISTS "shop_features" (
  "shop_id" integer NOT NULL REFERENCES "shops"("mos_shop_id") ON DELETE CASCADE,
  "feature_key" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "settings" jsonb,
  "subscription" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("shop_id", "feature_key")
);
CREATE INDEX IF NOT EXISTS "shop_features_feature_key_idx" ON "shop_features" ("feature_key");

CREATE TABLE IF NOT EXISTS "platform_admins" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "email_lower" text NOT NULL,
  "password_hash" text,
  "role" text DEFAULT 'platform_admin' NOT NULL,
  "name" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "platform_admins_email_lower_uniq" ON "platform_admins" ("email_lower");

CREATE TABLE IF NOT EXISTS "platform_settings" (
  "type" text PRIMARY KEY NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "platform_plans" (
  "slug" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "stripe_product_id" text,
  "stripe_price_id" text,
  "price_per_month" double precision,
  "included_vins" integer,
  "payload" jsonb,
  "active" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "platform_plans_active_idx" ON "platform_plans" ("active");

CREATE TABLE IF NOT EXISTS "pending_signups" (
  "token" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "email_lower" text NOT NULL,
  "payload" jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "pending_signups_email_idx" ON "pending_signups" ("email_lower");
CREATE INDEX IF NOT EXISTS "pending_signups_expires_idx" ON "pending_signups" ("expires_at");

CREATE TABLE IF NOT EXISTS "setup_tokens" (
  "token" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "email_lower" text NOT NULL,
  "shop_id" integer,
  "payload" jsonb,
  "consumed_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "setup_tokens_email_idx" ON "setup_tokens" ("email_lower");
CREATE INDEX IF NOT EXISTS "setup_tokens_expires_idx" ON "setup_tokens" ("expires_at");

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "token" text PRIMARY KEY NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
  "email" text,
  "email_lower" text,
  "consumed_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_idx" ON "password_reset_tokens" ("user_id");
CREATE INDEX IF NOT EXISTS "password_reset_tokens_expires_idx" ON "password_reset_tokens" ("expires_at");

CREATE TABLE IF NOT EXISTS "billing_settings" (
  "shop_id" integer PRIMARY KEY NOT NULL REFERENCES "shops"("mos_shop_id") ON DELETE CASCADE,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "billing_status_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "backfill_mongo_id" text,
  "shop_id" integer,
  "from_status" text,
  "to_status" text,
  "reason" text,
  "actor" text,
  "payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "billing_status_log_shop_created_idx" ON "billing_status_log" ("shop_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "billing_status_log_backfill_uniq" ON "billing_status_log" ("backfill_mongo_id");

CREATE TABLE IF NOT EXISTS "stripe_events" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text,
  "livemode" boolean,
  "api_version" text,
  "payload" jsonb,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "stripe_events_type_idx" ON "stripe_events" ("type");

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text,
  "payload" jsonb,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  "error" text
);
CREATE INDEX IF NOT EXISTS "stripe_webhook_events_type_idx" ON "stripe_webhook_events" ("type");
