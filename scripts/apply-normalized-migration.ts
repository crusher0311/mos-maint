import postgres from "postgres";

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
  ];

  const fkStatements = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'normalized_service_jobs_work_order_id_fk') THEN ALTER TABLE "normalized_service_jobs" ADD CONSTRAINT "normalized_service_jobs_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."normalized_work_orders"("id") ON DELETE no action ON UPDATE no action; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'normalized_line_items_work_order_id_fk') THEN ALTER TABLE "normalized_line_items" ADD CONSTRAINT "normalized_line_items_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."normalized_work_orders"("id") ON DELETE no action ON UPDATE no action; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'normalized_line_items_service_job_id_fk') THEN ALTER TABLE "normalized_line_items" ADD CONSTRAINT "normalized_line_items_service_job_id_fk" FOREIGN KEY ("service_job_id") REFERENCES "public"."normalized_service_jobs"("id") ON DELETE no action ON UPDATE no action; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'normalized_payments_work_order_id_fk') THEN ALTER TABLE "normalized_payments" ADD CONSTRAINT "normalized_payments_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."normalized_work_orders"("id") ON DELETE no action ON UPDATE no action; END IF; END $$`,
  ];

  const indexStatements = [
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
  ];

  console.log("Creating enums...");
  for (const stmt of enumStatements) {
    await sql.unsafe(stmt);
  }
  console.log("  ✓ 14 enums created/verified");

  console.log("Creating tables...");
  for (const stmt of tableStatements) {
    await sql.unsafe(stmt);
  }
  console.log("  ✓ 6 tables created/verified");

  console.log("Adding foreign keys...");
  for (const stmt of fkStatements) {
    await sql.unsafe(stmt);
  }
  console.log("  ✓ 4 foreign keys created/verified");

  console.log("Creating indexes...");
  for (const stmt of indexStatements) {
    await sql.unsafe(stmt);
  }
  console.log(`  ✓ ${indexStatements.length} indexes created/verified`);

  console.log("\nVerifying tables exist...");
  const tables = await sql`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_name IN (
      'normalized_vehicles', 'normalized_customers', 'normalized_work_orders',
      'normalized_service_jobs', 'normalized_line_items', 'normalized_payments'
    )
    ORDER BY table_name
  `;

  console.log(`Found ${tables.length}/6 normalized tables:`);
  for (const t of tables) {
    console.log(`  ✓ ${t.table_name}`);
  }

  if (tables.length !== 6) {
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
