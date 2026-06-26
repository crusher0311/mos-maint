-- Task #632 — Tekmetric appointments + employees sync.
--
-- Two new normalized tables so the client "Data Status" panel can show a real
-- count + freshness for Appointments and Employees instead of "Not synced to
-- MOS". These are Tekmetric-only, refreshed periodically by the backfill cron
-- (no webhooks): only the *upcoming* appointment window and the *current*
-- employee roster are kept — there is no historical backfill.
--
-- Sync is idempotent on the (shop_id, source_id) unique index — the provider's
-- own appointment / employee id — so a re-run UPDATEs in place. The
-- (shop_id, updated_at) and (shop_id, scheduled_date) indexes back the panel's
-- index-only count / max(updated_at) / min-max(scheduled_date) aggregates.
--
-- IF NOT EXISTS keeps this idempotent and aligned with
-- scripts/apply-normalized-migration.ts.
CREATE TABLE IF NOT EXISTS "normalized_appointments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" text,
	"shop_id" integer NOT NULL,
	"location_id" text,
	"provenance" jsonb NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted":false}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source_id" text NOT NULL,
	"appointment_number" text,
	"customer_id" text,
	"vehicle_id" text,
	"repair_order_id" text,
	"status" text,
	"appointment_type" text,
	"scheduled_date" timestamp,
	"end_date" timestamp,
	"title" text,
	"description" text,
	"color" text,
	"raw_data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "normalized_employees" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" text,
	"shop_id" integer NOT NULL,
	"location_id" text,
	"provenance" jsonb NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted":false}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source_id" text NOT NULL,
	"employee_number" text,
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"email" text,
	"phone" text,
	"role" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"raw_data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "nap_shop_id_source_id_idx" ON "normalized_appointments" ("shop_id","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nap_shop_id_idx" ON "normalized_appointments" ("shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nap_enterprise_id_idx" ON "normalized_appointments" ("enterprise_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nap_shop_scheduled_date_idx" ON "normalized_appointments" ("shop_id","scheduled_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nap_shop_updated_at_idx" ON "normalized_appointments" ("shop_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nap_created_at_idx" ON "normalized_appointments" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nap_updated_at_idx" ON "normalized_appointments" ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "nemp_shop_id_source_id_idx" ON "normalized_employees" ("shop_id","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nemp_shop_id_idx" ON "normalized_employees" ("shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nemp_enterprise_id_idx" ON "normalized_employees" ("enterprise_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nemp_shop_updated_at_idx" ON "normalized_employees" ("shop_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nemp_created_at_idx" ON "normalized_employees" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nemp_updated_at_idx" ON "normalized_employees" ("updated_at");
