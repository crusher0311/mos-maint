import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

// Task #1020 — fresh environments must get the COMPLETE schema, not just the
// normalized_* tables. db:generate is dead (journal drift since 0012), so this
// script is the canonical schema path; it executes the hand-written wave
// migration files below in order. All of them are idempotent (CREATE ... IF
// NOT EXISTS / guarded DO blocks / ALTER TABLE IF EXISTS), so re-running
// against an existing environment (including prod Supabase) is a no-op.
// New drizzle/00NN.sql migrations must be idempotent and appended here.
//
// Note: 0019/0021 create their trigram GIN indexes with plain CREATE INDEX,
// which is fine for fresh/empty tables; on a populated prod table build them
// with CREATE INDEX CONCURRENTLY out-of-band instead (see file comments).
const drizzleMigrationFiles = [
  "0011_wave1_reference_and_leaf.sql",
  "0012_wave2_operational.sql",
  "0013_relax_normalized_work_order_vehicle.sql",
  "0014_wave3.sql",
  "0015_wave4.sql",
  "0016_task382_aces_ids.sql",
  "0017_task552_provenance_sourceids_gin.sql",
  "0018_task557_operational_primitives.sql",
  "0019_job_search_trgm.sql",
  "0020_task632_appointments_employees.sql",
  "0021_task758_kb_search_trgm.sql",
  "0022_task901_vehicle_specs_cache.sql",
  // 0027 runs before 0023–0026 on purpose: it creates the pre-wave base
  // tables (support_tickets, communications family, production_logs, ...)
  // that 0024–0026 ALTER, so those ALTERs actually apply on a fresh
  // environment instead of being skipped by their IF EXISTS guards.
  "0027_task1020_full_schema_baseline.sql",
  "0023_task999_integration_ops.sql",
  "0024_task1000_dvi_payload.sql",
  "0024_task1006_protractor_callback_event_runtime.sql",
  "0025_task1000_package3.sql",
  "0026_task1000_support_tickets.sql",
  "0028_task1023_raw_data.sql",
  "0030_extension_sessions.sql",
  "0031_task1161_slow_queries.sql",
];

async function main() {
  const connStr = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL;
  if (!connStr) {
    console.error("Missing DATAONE_DATABASE_URL or DATABASE_URL");
    process.exit(1);
  }

  const sql = postgres(connStr, { max: 1, connect_timeout: 30 });

  const enumStatements = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'source_system') THEN CREATE TYPE "public"."source_system" AS ENUM('protractor', 'tekmetric', 'autoflow', 'autovitals', 'mitchell', 'shopware', 'rowriter', 'shopmonkey', 'shopboss', 'alldata', 'identifix', 'manual', 'import', 'unknown'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'work_order_status') THEN CREATE TYPE "public"."work_order_status" AS ENUM('draft', 'estimate', 'pending_approval', 'approved', 'authorized', 'scheduled', 'checked_in', 'inspection_pending', 'inspection_in_progress', 'inspection_complete', 'waiting_parts', 'waiting_approval', 'work_in_progress', 'work_paused', 'work_complete', 'quality_check', 'ready_for_pickup', 'invoiced', 'paid', 'closed', 'voided', 'archived'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'work_order_type') THEN CREATE TYPE "public"."work_order_type" AS ENUM('repair', 'maintenance', 'inspection', 'estimate_only', 'warranty', 'internal', 'comeback', 'sublet', 'quick_service', 'fleet', 'insurance'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'service_job_status') THEN CREATE TYPE "public"."service_job_status" AS ENUM('pending', 'authorized', 'declined', 'deferred', 'in_progress', 'completed', 'cancelled', 'warranty'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'service_job_type') THEN CREATE TYPE "public"."service_job_type" AS ENUM('canned', 'custom', 'diagnostic', 'inspection', 'sublet', 'internal', 'warranty', 'comeback'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'line_item_type') THEN CREATE TYPE "public"."line_item_type" AS ENUM('part', 'labor', 'sublet', 'fee', 'shop_supply', 'hazmat', 'disposal', 'tax', 'discount', 'core_charge', 'tire', 'fluid', 'misc'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'part_condition') THEN CREATE TYPE "public"."part_condition" AS ENUM('new_oem', 'new_aftermarket', 'remanufactured', 'rebuilt', 'used', 'customer_supplied', 'core_return'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'labor_type') THEN CREATE TYPE "public"."labor_type" AS ENUM('flat_rate', 'hourly', 'diagnostic', 'warranty', 'internal', 'sublet'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_method') THEN CREATE TYPE "public"."payment_method" AS ENUM('cash', 'check', 'credit_card', 'debit_card', 'financing', 'fleet_account', 'warranty', 'insurance', 'ar_account', 'other'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN CREATE TYPE "public"."payment_status" AS ENUM('pending', 'authorized', 'captured', 'partially_paid', 'paid', 'refunded', 'partially_refunded', 'voided', 'failed', 'chargeback'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'distance_unit') THEN CREATE TYPE "public"."distance_unit" AS ENUM('miles', 'kilometers'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vehicle_ownership_type') THEN CREATE TYPE "public"."vehicle_ownership_type" AS ENUM('owned', 'financed', 'leased', 'fleet', 'rental', 'dealer', 'wholesale'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'customer_type') THEN CREATE TYPE "public"."customer_type" AS ENUM('individual', 'business', 'fleet', 'government', 'dealer'); END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'part_order_status') THEN CREATE TYPE "public"."part_order_status" AS ENUM('needed', 'ordered', 'backordered', 'shipped', 'received', 'installed', 'returned', 'cancelled'); END IF; END $$`,
  ];

  const tableStatements = [
    `CREATE TABLE IF NOT EXISTS "normalized_vehicles" (
      "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "enterprise_id" text,
      "shop_id" integer NOT NULL,
      "location_id" text,
      "provenance" jsonb NOT NULL,
      "soft_delete" jsonb NOT NULL DEFAULT '{"isDeleted":false}'::jsonb,
      "version" integer NOT NULL DEFAULT 1,
      "vin" text,
      "vin_decoded" boolean NOT NULL DEFAULT false,
      "vin_decode_data" jsonb,
      "year" integer,
      "make" text,
      "model" text,
      "submodel" text,
      "trim" text,
      "body_style" text,
      "engine_code" text,
      "engine_description" text,
      "engine_displacement" numeric(6, 2),
      "engine_displacement_unit" text,
      "engine_cylinders" integer,
      "engine_configuration" text,
      "fuel_type" text,
      "transmission" text,
      "transmission_speeds" integer,
      "drivetrain" text,
      "exterior_color" text,
      "interior_color" text,
      "license_plate" text,
      "license_plate_state" text,
      "ownership_type" "vehicle_ownership_type",
      "is_fleet" boolean NOT NULL DEFAULT false,
      "fleet_id" text,
      "fleet_unit_number" text,
      "current_odometer" integer,
      "odometer_unit" "distance_unit" NOT NULL DEFAULT 'miles',
      "odometer_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "estimated_annual_mileage" integer,
      "purchase_date" timestamp,
      "in_service_date" timestamp,
      "warranty_expiration_date" timestamp,
      "warranty_expiration_mileage" integer,
      "telematics_provider" text,
      "telematics_device_id" text,
      "notes" text,
      "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "custom_fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "customer_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "primary_customer_id" text,
      "last_service_date" timestamp,
      "last_service_mileage" integer,
      "total_services_count" integer NOT NULL DEFAULT 0,
      "total_services_amount" numeric(12, 2) NOT NULL DEFAULT '0',
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )`,

    `CREATE TABLE IF NOT EXISTS "normalized_customers" (
      "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "enterprise_id" text,
      "shop_id" integer NOT NULL,
      "location_id" text,
      "provenance" jsonb NOT NULL,
      "soft_delete" jsonb NOT NULL DEFAULT '{"isDeleted":false}'::jsonb,
      "version" integer NOT NULL DEFAULT 1,
      "customer_type" "customer_type" NOT NULL DEFAULT 'individual',
      "first_name" text,
      "last_name" text,
      "full_name" text,
      "company_name" text,
      "contacts" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "primary_contact_id" text,
      "billing_address" jsonb,
      "mailing_address" jsonb,
      "tax_exempt" boolean NOT NULL DEFAULT false,
      "tax_exempt_number" text,
      "account_number" text,
      "ar_balance" numeric(12, 2) NOT NULL DEFAULT '0',
      "credit_limit" numeric(12, 2),
      "payment_terms" text,
      "default_payment_method" "payment_method",
      "marketing_consent" boolean NOT NULL DEFAULT false,
      "marketing_consent_date" timestamp,
      "sms_consent" boolean NOT NULL DEFAULT false,
      "sms_consent_date" timestamp,
      "email_consent" boolean NOT NULL DEFAULT false,
      "email_consent_date" timestamp,
      "referral_source" text,
      "acquisition_date" timestamp,
      "notes" text,
      "internal_notes" text,
      "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "custom_fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "vehicle_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "total_visits" integer NOT NULL DEFAULT 0,
      "total_spent" numeric(12, 2) NOT NULL DEFAULT '0',
      "average_ticket" numeric(12, 2) NOT NULL DEFAULT '0',
      "last_visit_date" timestamp,
      "loyalty_points" integer,
      "loyalty_tier" text,
      "dedupe_key" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )`,

    `CREATE TABLE IF NOT EXISTS "normalized_work_orders" (
      "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "enterprise_id" text,
      "shop_id" integer NOT NULL,
      "location_id" text,
      "provenance" jsonb NOT NULL,
      "soft_delete" jsonb NOT NULL DEFAULT '{"isDeleted":false}'::jsonb,
      "version" integer NOT NULL DEFAULT 1,
      "work_order_number" text NOT NULL,
      "work_order_type" "work_order_type" NOT NULL DEFAULT 'repair',
      "status" "work_order_status" NOT NULL DEFAULT 'draft',
      "status_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "vehicle_id" text NOT NULL,
      "vehicle" jsonb NOT NULL,
      "customer_id" text,
      "customer" jsonb,
      "odometer_in" integer,
      "odometer_out" integer,
      "odometer_unit" "distance_unit" NOT NULL DEFAULT 'miles',
      "promised_date" timestamp,
      "promised_time" text,
      "due_date" timestamp,
      "check_in_date" timestamp,
      "check_in_time" text,
      "check_in_by" text,
      "started_date" timestamp,
      "completed_date" timestamp,
      "closed_date" timestamp,
      "service_advisor_id" text,
      "service_advisor_name" text,
      "technicians" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "customer_concern" text,
      "technician_notes" text,
      "internal_notes" text,
      "subtotal" numeric(12, 2) NOT NULL DEFAULT '0',
      "tax_total" numeric(12, 2) NOT NULL DEFAULT '0',
      "discount_total" numeric(12, 2) NOT NULL DEFAULT '0',
      "grand_total" numeric(12, 2) NOT NULL DEFAULT '0',
      "labor_total" numeric(12, 2) NOT NULL DEFAULT '0',
      "parts_total" numeric(12, 2) NOT NULL DEFAULT '0',
      "sublet_total" numeric(12, 2) NOT NULL DEFAULT '0',
      "fees_total" numeric(12, 2) NOT NULL DEFAULT '0',
      "labor_hours_total" numeric(8, 2) NOT NULL DEFAULT '0',
      "labor_hours_billed" numeric(8, 2) NOT NULL DEFAULT '0',
      "payments" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "balance_due" numeric(12, 2) NOT NULL DEFAULT '0',
      "is_warranty" boolean NOT NULL DEFAULT false,
      "is_internal" boolean NOT NULL DEFAULT false,
      "is_comeback" boolean NOT NULL DEFAULT false,
      "comeback_from_work_order_id" text,
      "appointment_id" text,
      "authorized_by" text,
      "authorized_at" timestamp,
      "authorized_method" text,
      "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "custom_fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )`,

    `CREATE TABLE IF NOT EXISTS "normalized_service_jobs" (
      "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "enterprise_id" text,
      "shop_id" integer NOT NULL,
      "location_id" text,
      "provenance" jsonb NOT NULL,
      "soft_delete" jsonb NOT NULL DEFAULT '{"isDeleted":false}'::jsonb,
      "version" integer NOT NULL DEFAULT 1,
      "work_order_id" varchar NOT NULL,
      "job_number" text,
      "sequence" integer NOT NULL DEFAULT 0,
      "job_type" "service_job_type" NOT NULL DEFAULT 'custom',
      "status" "service_job_status" NOT NULL DEFAULT 'pending',
      "status_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "title" text NOT NULL,
      "description" text,
      "canned_job_id" text,
      "canned_job_code" text,
      "canned_job_name" text,
      "labor_operation_codes" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "technician_id" text,
      "technician_name" text,
      "labor_total" numeric(12, 2) NOT NULL DEFAULT '0',
      "parts_total" numeric(12, 2) NOT NULL DEFAULT '0',
      "sublet_total" numeric(12, 2) NOT NULL DEFAULT '0',
      "fees_total" numeric(12, 2) NOT NULL DEFAULT '0',
      "discount_total" numeric(12, 2) NOT NULL DEFAULT '0',
      "total" numeric(12, 2) NOT NULL DEFAULT '0',
      "labor_hours_estimated" numeric(8, 2),
      "labor_hours_actual" numeric(8, 2),
      "labor_hours_billed" numeric(8, 2),
      "is_warranty" boolean NOT NULL DEFAULT false,
      "warranty_claim_id" text,
      "is_sublet" boolean NOT NULL DEFAULT false,
      "sublet_vendor" text,
      "sublet_cost" numeric(12, 2),
      "technician_notes" text,
      "advisor_notes" text,
      "authorized_at" timestamp,
      "authorized_by" text,
      "declined_at" timestamp,
      "declined_by" text,
      "decline_reason" text,
      "started_at" timestamp,
      "completed_at" timestamp,
      "inspection_id" text,
      "recommendation_id" text,
      "components_codes" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "custom_fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )`,

    `CREATE TABLE IF NOT EXISTS "normalized_line_items" (
      "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "enterprise_id" text,
      "shop_id" integer NOT NULL,
      "location_id" text,
      "provenance" jsonb NOT NULL,
      "soft_delete" jsonb NOT NULL DEFAULT '{"isDeleted":false}'::jsonb,
      "version" integer NOT NULL DEFAULT 1,
      "work_order_id" varchar NOT NULL,
      "service_job_id" varchar NOT NULL,
      "line_number" integer NOT NULL,
      "line_type" "line_item_type" NOT NULL,
      "part_id" text,
      "part_number" text,
      "part_description" text NOT NULL,
      "part_brand" text,
      "part_manufacturer" text,
      "part_condition" "part_condition",
      "quantity" numeric(10, 3) NOT NULL DEFAULT '1',
      "quantity_unit" text NOT NULL DEFAULT 'each',
      "unit_cost" numeric(12, 2) NOT NULL DEFAULT '0',
      "unit_price" numeric(12, 2) NOT NULL DEFAULT '0',
      "extended_price" numeric(12, 2) NOT NULL DEFAULT '0',
      "discount_percent" numeric(5, 2),
      "discount_amount" numeric(12, 2),
      "taxable" boolean NOT NULL DEFAULT true,
      "tax_rate" numeric(6, 4),
      "tax_amount" numeric(12, 2),
      "labor_type" "labor_type",
      "labor_hours" numeric(8, 2),
      "labor_rate" numeric(12, 2),
      "technician_id" text,
      "technician_name" text,
      "vendor_id" text,
      "vendor_name" text,
      "vendor_part_number" text,
      "vendor_cost" numeric(12, 2),
      "core_charge" numeric(12, 2),
      "core_returned" boolean NOT NULL DEFAULT false,
      "core_returned_date" timestamp,
      "warranty_eligible" boolean NOT NULL DEFAULT false,
      "warranty_claim_id" text,
      "serial_number" text,
      "lot_number" text,
      "expiration_date" timestamp,
      "installed_component_id" text,
      "removed_component_id" text,
      "notes" text,
      "internal_notes" text,
      "order_status" "part_order_status",
      "ordered_at" timestamp,
      "received_at" timestamp,
      "custom_fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )`,

    `CREATE TABLE IF NOT EXISTS "normalized_payments" (
      "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "enterprise_id" text,
      "shop_id" integer NOT NULL,
      "location_id" text,
      "provenance" jsonb NOT NULL,
      "soft_delete" jsonb NOT NULL DEFAULT '{"isDeleted":false}'::jsonb,
      "version" integer NOT NULL DEFAULT 1,
      "work_order_id" varchar NOT NULL,
      "invoice_id" text,
      "payment_number" text,
      "status" "payment_status" NOT NULL DEFAULT 'pending',
      "method" "payment_method" NOT NULL,
      "amount" numeric(12, 2) NOT NULL,
      "tip_amount" numeric(12, 2),
      "processed_at" timestamp,
      "card_brand" text,
      "card_last4" text,
      "card_expiry" text,
      "check_number" text,
      "authorization_code" text,
      "transaction_id" text,
      "reference_number" text,
      "processor_name" text,
      "processor_response" text,
      "refunded_amount" numeric(12, 2),
      "refunded_at" timestamp,
      "refund_reason" text,
      "notes" text,
      "custom_fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )`,

    // Task #632 — Tekmetric upcoming appointments + current employee roster.
    `CREATE TABLE IF NOT EXISTS "normalized_appointments" (
      "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "enterprise_id" text,
      "shop_id" integer NOT NULL,
      "location_id" text,
      "provenance" jsonb NOT NULL,
      "soft_delete" jsonb NOT NULL DEFAULT '{"isDeleted":false}'::jsonb,
      "version" integer NOT NULL DEFAULT 1,
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
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )`,

    `CREATE TABLE IF NOT EXISTS "normalized_employees" (
      "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "enterprise_id" text,
      "shop_id" integer NOT NULL,
      "location_id" text,
      "provenance" jsonb NOT NULL,
      "soft_delete" jsonb NOT NULL DEFAULT '{"isDeleted":false}'::jsonb,
      "version" integer NOT NULL DEFAULT 1,
      "source_id" text NOT NULL,
      "employee_number" text,
      "first_name" text,
      "last_name" text,
      "full_name" text,
      "email" text,
      "phone" text,
      "role" text,
      "is_active" boolean NOT NULL DEFAULT true,
      "raw_data" jsonb,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )`,
    // Task #901 — vehicle specs cache (mirrors drizzle/0022_task901_vehicle_specs_cache.sql)
    `CREATE TABLE IF NOT EXISTS "vehicle_specs_cache" (
      "cache_key" text PRIMARY KEY,
      "vin" text NOT NULL,
      "payload" jsonb NOT NULL,
      "fetched_at" timestamptz NOT NULL DEFAULT now(),
      "expires_at" timestamptz NOT NULL
    )`,
    // Task #987 — sales coaching trainer (mirrors drizzle/0023_task987_sales_coach.sql)
    `CREATE TABLE IF NOT EXISTS "sales_coach_scenarios" (
      "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      "scenario_date" text NOT NULL,
      "scenario_type" text NOT NULL,
      "shop_id" integer NOT NULL,
      "work_order_id" varchar NOT NULL,
      "work_order_number" text,
      "context" jsonb NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS "sales_coach_sessions" (
      "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      "scenario_id" varchar NOT NULL,
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
    )`,
    // Task #987 — sales script cache (mirrors drizzle/0024_task987_sales_script_cache.sql)
    `CREATE TABLE IF NOT EXISTS "sales_script_cache" (
      "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      "shop_id" integer NOT NULL,
      "work_order_id" varchar NOT NULL,
      "context_hash" text NOT NULL,
      "script" jsonb NOT NULL,
      "model" text,
      "created_at" timestamp NOT NULL DEFAULT now()
    )`,
    // Task #1139 — concern follow-up question cache (mirrors drizzle/0029_task1139_concern_followup_cache.sql)
    `CREATE TABLE IF NOT EXISTS "concern_followup_cache" (
      "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      "concern_hash" text NOT NULL,
      "questions" jsonb NOT NULL,
      "prompt_version" text NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT now()
    )`,
  ];

  const fkStatements = [
    // Task #987 — sales coaching trainer
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'sales_coach_sessions_scenario_id_fk') THEN ALTER TABLE "sales_coach_sessions" ADD CONSTRAINT "sales_coach_sessions_scenario_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."sales_coach_scenarios"("id") ON DELETE no action ON UPDATE no action; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'normalized_service_jobs_work_order_id_fk') THEN ALTER TABLE "normalized_service_jobs" ADD CONSTRAINT "normalized_service_jobs_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."normalized_work_orders"("id") ON DELETE no action ON UPDATE no action; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'normalized_line_items_work_order_id_fk') THEN ALTER TABLE "normalized_line_items" ADD CONSTRAINT "normalized_line_items_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."normalized_work_orders"("id") ON DELETE no action ON UPDATE no action; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'normalized_line_items_service_job_id_fk') THEN ALTER TABLE "normalized_line_items" ADD CONSTRAINT "normalized_line_items_service_job_id_fk" FOREIGN KEY ("service_job_id") REFERENCES "public"."normalized_service_jobs"("id") ON DELETE no action ON UPDATE no action; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'normalized_payments_work_order_id_fk') THEN ALTER TABLE "normalized_payments" ADD CONSTRAINT "normalized_payments_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."normalized_work_orders"("id") ON DELETE no action ON UPDATE no action; END IF; END $$`,
  ];

  const indexStatements = [
    // Task #987 — sales coaching trainer (mirrors drizzle/0023_task987_sales_coach.sql)
    `CREATE UNIQUE INDEX IF NOT EXISTS "scs_work_order_id_idx" ON "sales_coach_scenarios" ("work_order_id")`,
    `CREATE INDEX IF NOT EXISTS "scs_scenario_date_idx" ON "sales_coach_scenarios" ("scenario_date")`,
    `CREATE INDEX IF NOT EXISTS "scsn_scenario_id_idx" ON "sales_coach_sessions" ("scenario_id")`,
    `CREATE INDEX IF NOT EXISTS "scsn_created_at_idx" ON "sales_coach_sessions" ("created_at")`,
    // Task #987 — sales script cache (mirrors drizzle/0024_task987_sales_script_cache.sql)
    `CREATE UNIQUE INDEX IF NOT EXISTS "ssc_wo_hash_idx" ON "sales_script_cache" ("work_order_id", "context_hash")`,
    `CREATE INDEX IF NOT EXISTS "ssc_shop_id_idx" ON "sales_script_cache" ("shop_id")`,
    // Task #1139 — concern follow-up cache (mirrors drizzle/0029_task1139_concern_followup_cache.sql)
    `CREATE UNIQUE INDEX IF NOT EXISTS "cfc_concern_hash_idx" ON "concern_followup_cache" ("concern_hash")`,
    `CREATE INDEX IF NOT EXISTS "cfc_created_at_idx" ON "concern_followup_cache" ("created_at")`,
    // Task #901 — vehicle specs cache
    `CREATE INDEX IF NOT EXISTS "vehicle_specs_cache_vin_idx" ON "vehicle_specs_cache" ("vin")`,
    `CREATE INDEX IF NOT EXISTS "vehicle_specs_cache_expires_idx" ON "vehicle_specs_cache" ("expires_at")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "nv_shop_id_vin_idx" ON "normalized_vehicles" ("shop_id", "vin")`,
    `CREATE INDEX IF NOT EXISTS "nv_enterprise_id_idx" ON "normalized_vehicles" ("enterprise_id")`,
    `CREATE INDEX IF NOT EXISTS "nv_vin_idx" ON "normalized_vehicles" ("vin")`,
    `CREATE INDEX IF NOT EXISTS "nv_make_model_year_idx" ON "normalized_vehicles" ("make", "model", "year")`,
    `CREATE INDEX IF NOT EXISTS "nv_content_hash_idx" ON "normalized_vehicles" ((provenance->>'contentHash'))`,
    `CREATE INDEX IF NOT EXISTS "nv_source_system_idx" ON "normalized_vehicles" ((provenance->>'sourceSystem'))`,
    `CREATE INDEX IF NOT EXISTS "nv_created_at_idx" ON "normalized_vehicles" ("created_at")`,
    `CREATE INDEX IF NOT EXISTS "nv_updated_at_idx" ON "normalized_vehicles" ("updated_at")`,

    `CREATE INDEX IF NOT EXISTS "nc_shop_id_idx" ON "normalized_customers" ("shop_id")`,
    `CREATE INDEX IF NOT EXISTS "nc_enterprise_id_idx" ON "normalized_customers" ("enterprise_id")`,
    `CREATE INDEX IF NOT EXISTS "nc_full_name_idx" ON "normalized_customers" ("full_name")`,
    `CREATE INDEX IF NOT EXISTS "nc_company_name_idx" ON "normalized_customers" ("company_name")`,
    `CREATE INDEX IF NOT EXISTS "nc_dedupe_key_idx" ON "normalized_customers" ("dedupe_key")`,
    `CREATE INDEX IF NOT EXISTS "nc_content_hash_idx" ON "normalized_customers" ((provenance->>'contentHash'))`,
    `CREATE INDEX IF NOT EXISTS "nc_source_system_idx" ON "normalized_customers" ((provenance->>'sourceSystem'))`,
    `CREATE INDEX IF NOT EXISTS "nc_created_at_idx" ON "normalized_customers" ("created_at")`,
    `CREATE INDEX IF NOT EXISTS "nc_updated_at_idx" ON "normalized_customers" ("updated_at")`,

    `CREATE UNIQUE INDEX IF NOT EXISTS "nwo_shop_id_wo_num_idx" ON "normalized_work_orders" ("shop_id", "work_order_number")`,
    `CREATE INDEX IF NOT EXISTS "nwo_enterprise_id_idx" ON "normalized_work_orders" ("enterprise_id")`,
    `CREATE INDEX IF NOT EXISTS "nwo_vehicle_id_idx" ON "normalized_work_orders" ("vehicle_id")`,
    `CREATE INDEX IF NOT EXISTS "nwo_customer_id_idx" ON "normalized_work_orders" ("customer_id")`,
    `CREATE INDEX IF NOT EXISTS "nwo_status_idx" ON "normalized_work_orders" ("status")`,
    `CREATE INDEX IF NOT EXISTS "nwo_closed_date_idx" ON "normalized_work_orders" ("closed_date")`,
    `CREATE INDEX IF NOT EXISTS "nwo_content_hash_idx" ON "normalized_work_orders" ((provenance->>'contentHash'))`,
    `CREATE INDEX IF NOT EXISTS "nwo_source_system_idx" ON "normalized_work_orders" ((provenance->>'sourceSystem'))`,
    `CREATE INDEX IF NOT EXISTS "nwo_created_at_idx" ON "normalized_work_orders" ("created_at")`,
    `CREATE INDEX IF NOT EXISTS "nwo_updated_at_idx" ON "normalized_work_orders" ("updated_at")`,

    `CREATE INDEX IF NOT EXISTS "nsj_work_order_id_idx" ON "normalized_service_jobs" ("work_order_id")`,
    `CREATE INDEX IF NOT EXISTS "nsj_work_order_seq_idx" ON "normalized_service_jobs" ("work_order_id", "sequence")`,
    `CREATE INDEX IF NOT EXISTS "nsj_shop_id_idx" ON "normalized_service_jobs" ("shop_id")`,
    `CREATE INDEX IF NOT EXISTS "nsj_enterprise_id_idx" ON "normalized_service_jobs" ("enterprise_id")`,
    `CREATE INDEX IF NOT EXISTS "nsj_canned_job_code_idx" ON "normalized_service_jobs" ("canned_job_code")`,
    `CREATE INDEX IF NOT EXISTS "nsj_content_hash_idx" ON "normalized_service_jobs" ((provenance->>'contentHash'))`,
    `CREATE INDEX IF NOT EXISTS "nsj_source_system_idx" ON "normalized_service_jobs" ((provenance->>'sourceSystem'))`,
    `CREATE INDEX IF NOT EXISTS "nsj_created_at_idx" ON "normalized_service_jobs" ("created_at")`,
    `CREATE INDEX IF NOT EXISTS "nsj_updated_at_idx" ON "normalized_service_jobs" ("updated_at")`,

    `CREATE INDEX IF NOT EXISTS "nli_work_order_id_idx" ON "normalized_line_items" ("work_order_id")`,
    `CREATE INDEX IF NOT EXISTS "nli_service_job_id_idx" ON "normalized_line_items" ("service_job_id")`,
    `CREATE INDEX IF NOT EXISTS "nli_shop_id_idx" ON "normalized_line_items" ("shop_id")`,
    `CREATE INDEX IF NOT EXISTS "nli_enterprise_id_idx" ON "normalized_line_items" ("enterprise_id")`,
    `CREATE INDEX IF NOT EXISTS "nli_part_number_idx" ON "normalized_line_items" ("part_number")`,
    `CREATE INDEX IF NOT EXISTS "nli_line_type_idx" ON "normalized_line_items" ("line_type")`,
    `CREATE INDEX IF NOT EXISTS "nli_content_hash_idx" ON "normalized_line_items" ((provenance->>'contentHash'))`,
    `CREATE INDEX IF NOT EXISTS "nli_source_system_idx" ON "normalized_line_items" ((provenance->>'sourceSystem'))`,
    `CREATE INDEX IF NOT EXISTS "nli_created_at_idx" ON "normalized_line_items" ("created_at")`,
    `CREATE INDEX IF NOT EXISTS "nli_updated_at_idx" ON "normalized_line_items" ("updated_at")`,

    `CREATE INDEX IF NOT EXISTS "np_work_order_id_idx" ON "normalized_payments" ("work_order_id")`,
    `CREATE INDEX IF NOT EXISTS "np_shop_id_idx" ON "normalized_payments" ("shop_id")`,
    `CREATE INDEX IF NOT EXISTS "np_enterprise_id_idx" ON "normalized_payments" ("enterprise_id")`,
    `CREATE INDEX IF NOT EXISTS "np_status_idx" ON "normalized_payments" ("status")`,
    `CREATE INDEX IF NOT EXISTS "np_transaction_id_idx" ON "normalized_payments" ("transaction_id")`,
    `CREATE INDEX IF NOT EXISTS "np_processed_at_idx" ON "normalized_payments" ("processed_at")`,
    `CREATE INDEX IF NOT EXISTS "np_content_hash_idx" ON "normalized_payments" ((provenance->>'contentHash'))`,
    `CREATE INDEX IF NOT EXISTS "np_source_system_idx" ON "normalized_payments" ((provenance->>'sourceSystem'))`,
    `CREATE INDEX IF NOT EXISTS "np_created_at_idx" ON "normalized_payments" ("created_at")`,
    `CREATE INDEX IF NOT EXISTS "np_updated_at_idx" ON "normalized_payments" ("updated_at")`,

    // Task #552 (W3a cutover) — GIN indexes supporting PG-canonical
    // change-detection. The ingestion service now dedupes against
    // `provenance->'sourceIds' @> [...]` instead of a Mongo findOne, so each
    // table needs a containment index or the shopId/FK-scoped lookups would
    // seq-scan on the hot ingest path.
    `CREATE INDEX IF NOT EXISTS "nv_provenance_source_ids_idx" ON "normalized_vehicles" USING gin ((provenance -> 'sourceIds') jsonb_path_ops)`,
    `CREATE INDEX IF NOT EXISTS "nc_provenance_source_ids_idx" ON "normalized_customers" USING gin ((provenance -> 'sourceIds') jsonb_path_ops)`,
    `CREATE INDEX IF NOT EXISTS "nwo_provenance_source_ids_idx" ON "normalized_work_orders" USING gin ((provenance -> 'sourceIds') jsonb_path_ops)`,
    `CREATE INDEX IF NOT EXISTS "nsj_provenance_source_ids_idx" ON "normalized_service_jobs" USING gin ((provenance -> 'sourceIds') jsonb_path_ops)`,
    `CREATE INDEX IF NOT EXISTS "nli_provenance_source_ids_idx" ON "normalized_line_items" USING gin ((provenance -> 'sourceIds') jsonb_path_ops)`,
    `CREATE INDEX IF NOT EXISTS "np_provenance_source_ids_idx" ON "normalized_payments" USING gin ((provenance -> 'sourceIds') jsonb_path_ops)`,

    // Job-history search trigram GIN indexes. The search filters with
    // leading-wildcard `ILIKE '%token%'` across title/description/
    // canned_job_name; these `gin_trgm_ops` indexes let those predicates use
    // a Bitmap Index Scan instead of walking the created_at index and
    // filtering every row (which timed out for rare/multi-token terms on
    // large enterprise shops). Requires the pg_trgm extension created above.
    // On prod these were built with CREATE INDEX CONCURRENTLY to avoid a
    // write lock; here they are plain idempotent CREATEs for fresh
    // environments. See drizzle/0019_job_search_trgm.sql.
    `CREATE INDEX IF NOT EXISTS "nsj_title_trgm_idx" ON "normalized_service_jobs" USING gin ("title" gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS "nsj_description_trgm_idx" ON "normalized_service_jobs" USING gin ("description" gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS "nsj_canned_job_name_trgm_idx" ON "normalized_service_jobs" USING gin ("canned_job_name" gin_trgm_ops)`,

    // Task #632 — appointments + employees. The (shop_id, source_id) unique
    // index is the natural-key upsert target; (shop_id, updated_at) and
    // (shop_id, scheduled_date) back the Data Status panel's cheap
    // count / max(updated_at) / min-max(scheduled_date) aggregates.
    `CREATE UNIQUE INDEX IF NOT EXISTS "nap_shop_id_source_id_idx" ON "normalized_appointments" ("shop_id", "source_id")`,
    `CREATE INDEX IF NOT EXISTS "nap_shop_id_idx" ON "normalized_appointments" ("shop_id")`,
    `CREATE INDEX IF NOT EXISTS "nap_enterprise_id_idx" ON "normalized_appointments" ("enterprise_id")`,
    `CREATE INDEX IF NOT EXISTS "nap_shop_scheduled_date_idx" ON "normalized_appointments" ("shop_id", "scheduled_date")`,
    `CREATE INDEX IF NOT EXISTS "nap_shop_updated_at_idx" ON "normalized_appointments" ("shop_id", "updated_at")`,
    `CREATE INDEX IF NOT EXISTS "nap_created_at_idx" ON "normalized_appointments" ("created_at")`,
    `CREATE INDEX IF NOT EXISTS "nap_updated_at_idx" ON "normalized_appointments" ("updated_at")`,

    `CREATE UNIQUE INDEX IF NOT EXISTS "nemp_shop_id_source_id_idx" ON "normalized_employees" ("shop_id", "source_id")`,
    `CREATE INDEX IF NOT EXISTS "nemp_shop_id_idx" ON "normalized_employees" ("shop_id")`,
    `CREATE INDEX IF NOT EXISTS "nemp_enterprise_id_idx" ON "normalized_employees" ("enterprise_id")`,
    `CREATE INDEX IF NOT EXISTS "nemp_shop_updated_at_idx" ON "normalized_employees" ("shop_id", "updated_at")`,
    `CREATE INDEX IF NOT EXISTS "nemp_created_at_idx" ON "normalized_employees" ("created_at")`,
    `CREATE INDEX IF NOT EXISTS "nemp_updated_at_idx" ON "normalized_employees" ("updated_at")`,

    // Task #758 — knowledge-base search trigram GIN indexes. KB search filters
    // with leading-wildcard `ILIKE '%term%'` across knowledge_articles
    // title/problem/solution/category (lib/db/repositories/wave1.ts). A plain
    // b-tree can't serve a leading-wildcard ILIKE, so those predicates
    // seq-scan the table; these `gin_trgm_ops` indexes let them use a Bitmap
    // Index Scan instead. Requires the pg_trgm extension created above. On prod
    // build with CREATE INDEX CONCURRENTLY to avoid a write lock; these are
    // plain idempotent CREATEs for fresh environments. See
    // drizzle/0021_task758_kb_search_trgm.sql.
    `CREATE INDEX IF NOT EXISTS "knowledge_articles_title_trgm_idx" ON "knowledge_articles" USING gin ("title" gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS "knowledge_articles_problem_trgm_idx" ON "knowledge_articles" USING gin ("problem" gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS "knowledge_articles_solution_trgm_idx" ON "knowledge_articles" USING gin ("solution" gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS "knowledge_articles_category_trgm_idx" ON "knowledge_articles" USING gin ("category" gin_trgm_ops)`,
  ];

  // Task #1018 — mirror drizzle/0023–0026 so fresh environments get the same
  // schema (db:generate is dead; this script is the canonical path).
  // ALTERs target wave2/wave3 tables that may not exist in a truly fresh
  // environment, so they use ALTER TABLE IF EXISTS, and dependent index
  // creates are guarded on to_regclass. All statements are idempotent.
  const legacyCutoverStatements = [
    // ---- 0023_task999_integration_ops.sql ----
    `CREATE TABLE IF NOT EXISTS "protractor_backfill_progress" (
      "shop_id" integer PRIMARY KEY NOT NULL,
      "started_at" timestamp with time zone,
      "completed" boolean DEFAULT false NOT NULL,
      "completed_at" timestamp with time zone,
      "complete" boolean,
      "last_run_at" timestamp with time zone,
      "last_error" text,
      "last_error_at" timestamp with time zone,
      "current_chunk_end" timestamp with time zone,
      "lock_owner" text,
      "lock_expires_at" timestamp with time zone,
      "extra" jsonb,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS "protractor_backfill_progress_completed_idx"
      ON "protractor_backfill_progress" ("completed", "last_run_at")`,
    `CREATE TABLE IF NOT EXISTS "protractor_webhook_subscriptions" (
      "shop_id" integer PRIMARY KEY NOT NULL,
      "token" text,
      "url" text,
      "active" boolean DEFAULT true NOT NULL,
      "verified_at" timestamp with time zone,
      "last_checked_at" timestamp with time zone,
      "payload" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS "api_usage" (
      "id" text PRIMARY KEY NOT NULL,
      "provider" text NOT NULL,
      "shop_id" integer,
      "shop_name" text,
      "endpoint" text,
      "method" text,
      "status_code" integer,
      "is_error" boolean DEFAULT false NOT NULL,
      "is_rate_limited" boolean DEFAULT false NOT NULL,
      "error_message" text,
      "error_code" text,
      "latency_ms" integer,
      "request_id" text,
      "source_worker" text,
      "timestamp" timestamp with time zone NOT NULL,
      "extra" jsonb
    )`,
    `CREATE INDEX IF NOT EXISTS "api_usage_provider_ts_idx" ON "api_usage" ("provider", "timestamp")`,
    `CREATE INDEX IF NOT EXISTS "api_usage_shop_ts_idx" ON "api_usage" ("shop_id", "timestamp")`,
    `CREATE TABLE IF NOT EXISTS "api_rate_limits" (
      "slot_key" text PRIMARY KEY NOT NULL,
      "count" integer DEFAULT 0 NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "expires_at" timestamp with time zone
    )`,
    `CREATE INDEX IF NOT EXISTS "api_rate_limits_expires_idx" ON "api_rate_limits" ("expires_at")`,
    `CREATE TABLE IF NOT EXISTS "integration_drain_locks" (
      "provider" text PRIMARY KEY NOT NULL,
      "owner" text NOT NULL,
      "acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
      "expires_at" timestamp with time zone NOT NULL,
      "last_refresh_at" timestamp with time zone,
      "meta" jsonb
    )`,
    `CREATE INDEX IF NOT EXISTS "integration_drain_locks_expires_idx"
      ON "integration_drain_locks" ("expires_at")`,

    // ---- 0024_task1000_dvi_payload.sql ----
    `ALTER TABLE IF EXISTS "dvi" ADD COLUMN IF NOT EXISTS "payload" jsonb`,

    // ---- 0024_task1006_protractor_callback_event_runtime.sql ----
    `ALTER TABLE IF EXISTS "protractor_callback_events"
      ADD COLUMN IF NOT EXISTS "event_key" text,
      ADD COLUMN IF NOT EXISTS "method" text,
      ADD COLUMN IF NOT EXISTS "connection_id" text,
      ADD COLUMN IF NOT EXISTS "object_type" text,
      ADD COLUMN IF NOT EXISTS "object_id" text,
      ADD COLUMN IF NOT EXISTS "operation" text,
      ADD COLUMN IF NOT EXISTS "work_order_id" text,
      ADD COLUMN IF NOT EXISTS "status" text,
      ADD COLUMN IF NOT EXISTS "processed_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "attempts" integer,
      ADD COLUMN IF NOT EXISTS "priority" integer,
      ADD COLUMN IF NOT EXISTS "processing_started_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "last_error" text,
      ADD COLUMN IF NOT EXISTS "last_error_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "vin" text,
      ADD COLUMN IF NOT EXISTS "work_order_number" text,
      ADD COLUMN IF NOT EXISTS "no_action" boolean,
      ADD COLUMN IF NOT EXISTS "deleted_from_dashboard" boolean`,
    `DO $$ BEGIN IF to_regclass('public.protractor_callback_events') IS NOT NULL THEN
      CREATE UNIQUE INDEX IF NOT EXISTS "pro_cb_event_key_uniq" ON "protractor_callback_events" ("event_key");
      CREATE INDEX IF NOT EXISTS "pro_cb_conn_received_idx" ON "protractor_callback_events" ("connection_id", "received_at");
      CREATE INDEX IF NOT EXISTS "pro_cb_method_received_idx" ON "protractor_callback_events" ("method", "received_at");
      CREATE INDEX IF NOT EXISTS "pro_cb_method_processed_idx" ON "protractor_callback_events" ("method", "processed_at");
      CREATE INDEX IF NOT EXISTS "pro_cb_pending_queue_idx" ON "protractor_callback_events" ("method", "processed", "priority", "received_at");
      CREATE INDEX IF NOT EXISTS "pro_cb_wo_status_idx" ON "protractor_callback_events" ("work_order_id", "status", "processed");
      CREATE INDEX IF NOT EXISTS "pro_cb_obj_dedup_idx" ON "protractor_callback_events" ("shop_id", "object_type", "object_id", "operation");
    END IF; END $$`,

    // ---- 0025_task1000_package3.sql ----
    `ALTER TABLE IF EXISTS "concern_conversations" ADD COLUMN IF NOT EXISTS "user_id" text`,
    `ALTER TABLE IF EXISTS "concern_conversations" ADD COLUMN IF NOT EXISTS "status" text`,
    `ALTER TABLE IF EXISTS "concern_conversations" ADD COLUMN IF NOT EXISTS "payload" jsonb`,
    `DO $$ BEGIN IF to_regclass('public.concern_conversations') IS NOT NULL THEN
      CREATE INDEX IF NOT EXISTS "concern_conversations_user_updated_idx"
        ON "concern_conversations" ("user_id", "updated_at");
    END IF; END $$`,
    `DO $$ BEGIN IF to_regclass('public.shop_repair_patterns') IS NOT NULL THEN
      ALTER TABLE "shop_repair_patterns" ALTER COLUMN "pattern" DROP NOT NULL;
    END IF; END $$`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "enterprise_id" text`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "year" integer`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "make" text`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "model" text`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "mileage_bucket" integer`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "job_title" text`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "job_title_normalized" text`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "occurrences" integer NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "total_labor" double precision NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "total_parts" double precision NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "total_amount" double precision NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "avg_labor" double precision NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "avg_parts" double precision NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "avg_total" double precision NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "avg_hours" double precision NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "last_performed" timestamptz`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "first_performed" timestamptz`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "vins_seen" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now()`,
    `ALTER TABLE IF EXISTS "shop_repair_patterns" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now()`,
    `DO $$ BEGIN IF to_regclass('public.shop_repair_patterns') IS NOT NULL THEN
      CREATE UNIQUE INDEX IF NOT EXISTS "shop_repair_patterns_shop_vehicle_job_uniq"
        ON "shop_repair_patterns" ("shop_id", "year", "make", "model", "mileage_bucket", "job_title_normalized");
      CREATE INDEX IF NOT EXISTS "shop_repair_patterns_enterprise_vehicle_idx"
        ON "shop_repair_patterns" ("enterprise_id", "year", "make", "model", "mileage_bucket");
      CREATE INDEX IF NOT EXISTS "shop_repair_patterns_shop_top_idx"
        ON "shop_repair_patterns" ("shop_id", "occurrences");
    END IF; END $$`,

    // ---- 0026_task1000_support_tickets.sql ----
    `ALTER TABLE IF EXISTS "support_tickets" ADD COLUMN IF NOT EXISTS "mongo_id" text`,
    `ALTER TABLE IF EXISTS "support_tickets" ADD COLUMN IF NOT EXISTS "closed_at" timestamptz`,
    `ALTER TABLE IF EXISTS "support_tickets" ADD COLUMN IF NOT EXISTS "auto_closed_at" timestamptz`,
    `DO $$ BEGIN IF to_regclass('public.support_tickets') IS NOT NULL THEN
      CREATE UNIQUE INDEX IF NOT EXISTS "support_tickets_mongo_id_key"
        ON "support_tickets" ("mongo_id");
    END IF; END $$`,
  ];

  console.log("Creating extensions...");
  // pg_trgm backs the trigram GIN indexes used by job-history search
  // (leading-wildcard ILIKE on title/description/canned_job_name). Without
  // it, those ILIKE searches cannot be index-assisted and degrade to a full
  // created_at scan that times out for rare/multi-token terms on large
  // enterprise shops. See drizzle/0019_job_search_trgm.sql.
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  console.log("  ✓ pg_trgm");

  console.log("Creating enums...");
  for (const stmt of enumStatements) {
    await sql.unsafe(stmt);
  }
  console.log("  ✓ 14 enums created/verified");

  console.log("Creating tables...");
  for (const stmt of tableStatements) {
    await sql.unsafe(stmt);
  }
  console.log(`  ✓ ${tableStatements.length} tables created/verified`);

  console.log("Adding foreign keys...");
  for (const stmt of fkStatements) {
    await sql.unsafe(stmt);
  }
  console.log("  ✓ 4 foreign keys created/verified");

  // Run the full drizzle wave-migration series before the index block: some
  // of the index statements below (e.g. knowledge_articles trgm indexes)
  // target tables that only these files create on a fresh environment.
  console.log("Applying drizzle wave migrations (0011–0027)...");
  for (const file of drizzleMigrationFiles) {
    const filePath = path.join(process.cwd(), "drizzle", file);
    const content = readFileSync(filePath, "utf8");
    // .simple() uses the simple query protocol so a whole multi-statement
    // migration file (including DO $$ blocks) runs in one round trip.
    await sql.unsafe(content).simple();
    console.log(`  ✓ ${file}`);
  }

  console.log("Creating indexes...");
  for (const stmt of indexStatements) {
    await sql.unsafe(stmt);
  }
  console.log(`  ✓ ${indexStatements.length} indexes created/verified`);

  console.log("Applying legacy-cutover DDL (drizzle 0023–0026)...");
  for (const stmt of legacyCutoverStatements) {
    await sql.unsafe(stmt);
  }
  console.log(
    `  ✓ ${legacyCutoverStatements.length} legacy-cutover statements applied/verified`,
  );

  console.log("\nVerifying tables exist...");
  const expectedTables = [
    'normalized_vehicles', 'normalized_customers', 'normalized_work_orders',
    'normalized_service_jobs', 'normalized_line_items', 'normalized_payments',
    'normalized_appointments', 'normalized_employees',
    // Task #1020 — spot-check one table per migration wave so a fresh
    // environment failure is caught here, not at first runtime read.
    'knowledge_articles',          // 0011 wave1
    'concern_conversations',       // 0012 wave2
    'shop_repair_patterns',        // 0012 wave2
    'dvi',                         // 0014 wave3
    'protractor_callback_events',  // 0014 wave3
    'job_index',                   // 0014 wave3
    'shops',                       // 0015 wave4
    'users',                       // 0015 wave4
    'sessions',                    // 0015 wave4
    'cron_locks',                  // 0018 operational primitives
    'protractor_backfill_progress',// 0023 integration ops
    'support_tickets',             // 0027 baseline
    'sms_messages',                // 0027 baseline (communications)
    'production_logs',             // 0027 baseline
    'platform_features',           // 0027 baseline
  ];
  const tables = await sql`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_name IN ${sql(expectedTables)}
    ORDER BY table_name
  `;

  console.log(`Found ${tables.length}/${expectedTables.length} normalized tables:`);
  for (const t of tables) {
    console.log(`  ✓ ${t.table_name}`);
  }

  if (tables.length !== expectedTables.length) {
    console.error("ERROR: Not all tables were created!");
    process.exit(1);
  }

  console.log("\nVerifying indexes...");
  const indexes = await sql`
    SELECT indexname FROM pg_indexes 
    WHERE schemaname = 'public' 
    AND tablename LIKE 'normalized_%'
    ORDER BY indexname
  `;
  console.log(`Found ${indexes.length} indexes on normalized tables:`);
  for (const idx of indexes) {
    console.log(`  ✓ ${idx.indexname}`);
  }

  await sql.end();
  console.log("\nNormalized schema migration complete!");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
