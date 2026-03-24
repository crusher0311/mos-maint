CREATE TYPE "public"."customer_type" AS ENUM('individual', 'business', 'fleet', 'government', 'dealer');--> statement-breakpoint
CREATE TYPE "public"."distance_unit" AS ENUM('miles', 'kilometers');--> statement-breakpoint
CREATE TYPE "public"."labor_type" AS ENUM('flat_rate', 'hourly', 'diagnostic', 'warranty', 'internal', 'sublet');--> statement-breakpoint
CREATE TYPE "public"."line_item_type" AS ENUM('part', 'labor', 'sublet', 'fee', 'shop_supply', 'hazmat', 'disposal', 'tax', 'discount', 'core_charge', 'tire', 'fluid', 'misc');--> statement-breakpoint
CREATE TYPE "public"."part_condition" AS ENUM('new_oem', 'new_aftermarket', 'remanufactured', 'rebuilt', 'used', 'customer_supplied', 'core_return');--> statement-breakpoint
CREATE TYPE "public"."part_order_status" AS ENUM('needed', 'ordered', 'backordered', 'shipped', 'received', 'installed', 'returned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'check', 'credit_card', 'debit_card', 'financing', 'fleet_account', 'warranty', 'insurance', 'ar_account', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'authorized', 'captured', 'partially_paid', 'paid', 'refunded', 'partially_refunded', 'voided', 'failed', 'chargeback');--> statement-breakpoint
CREATE TYPE "public"."service_job_status" AS ENUM('pending', 'authorized', 'declined', 'deferred', 'in_progress', 'completed', 'cancelled', 'warranty');--> statement-breakpoint
CREATE TYPE "public"."service_job_type" AS ENUM('canned', 'custom', 'diagnostic', 'inspection', 'sublet', 'internal', 'warranty', 'comeback');--> statement-breakpoint
CREATE TYPE "public"."source_system" AS ENUM('protractor', 'tekmetric', 'autoflow', 'autovitals', 'mitchell', 'shopware', 'rowriter', 'shopmonkey', 'shopboss', 'alldata', 'identifix', 'manual', 'import', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."vehicle_ownership_type" AS ENUM('owned', 'financed', 'leased', 'fleet', 'rental', 'dealer', 'wholesale');--> statement-breakpoint
CREATE TYPE "public"."work_order_status" AS ENUM('draft', 'estimate', 'pending_approval', 'approved', 'authorized', 'scheduled', 'checked_in', 'inspection_pending', 'inspection_in_progress', 'inspection_complete', 'waiting_parts', 'waiting_approval', 'work_in_progress', 'work_paused', 'work_complete', 'quality_check', 'ready_for_pickup', 'invoiced', 'paid', 'closed', 'voided', 'archived');--> statement-breakpoint
CREATE TYPE "public"."work_order_type" AS ENUM('repair', 'maintenance', 'inspection', 'estimate_only', 'warranty', 'internal', 'comeback', 'sublet', 'quick_service', 'fleet', 'insurance');--> statement-breakpoint
CREATE TABLE "crm_contact_account_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" varchar NOT NULL,
	"account_id" varchar NOT NULL,
	"role_type_id" varchar,
	"is_primary" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contact_agency_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" varchar NOT NULL,
	"agency_id" varchar NOT NULL,
	"role_type_id" varchar,
	"is_primary" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contact_location_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" varchar NOT NULL,
	"location_id" varchar NOT NULL,
	"role_type_id" varchar,
	"is_primary" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contact_parent_org_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" varchar NOT NULL,
	"parent_org_id" varchar NOT NULL,
	"role_type_id" varchar,
	"is_primary" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contact_role_types" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crm_contact_role_types_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "crm_contacts" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"mobile" text,
	"title" text,
	"department" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"avatar" text,
	"notes" text,
	"address" text,
	"city" text,
	"state" text,
	"zip" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "crm_entity_notes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" varchar NOT NULL,
	"content" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_entity_tasks" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" varchar NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'Open' NOT NULL,
	"priority" text DEFAULT 'Medium' NOT NULL,
	"due_date" timestamp,
	"assigned_to" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "normalized_customers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" text,
	"shop_id" integer NOT NULL,
	"location_id" text,
	"provenance" jsonb NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted":false}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"customer_type" "customer_type" DEFAULT 'individual' NOT NULL,
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"company_name" text,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_contact_id" text,
	"billing_address" jsonb,
	"mailing_address" jsonb,
	"tax_exempt" boolean DEFAULT false NOT NULL,
	"tax_exempt_number" text,
	"account_number" text,
	"ar_balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"credit_limit" numeric(12, 2),
	"payment_terms" text,
	"default_payment_method" "payment_method",
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"marketing_consent_date" timestamp,
	"sms_consent" boolean DEFAULT false NOT NULL,
	"sms_consent_date" timestamp,
	"email_consent" boolean DEFAULT false NOT NULL,
	"email_consent_date" timestamp,
	"referral_source" text,
	"acquisition_date" timestamp,
	"notes" text,
	"internal_notes" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"vehicle_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_visits" integer DEFAULT 0 NOT NULL,
	"total_spent" numeric(12, 2) DEFAULT '0' NOT NULL,
	"average_ticket" numeric(12, 2) DEFAULT '0' NOT NULL,
	"last_visit_date" timestamp,
	"loyalty_points" integer,
	"loyalty_tier" text,
	"dedupe_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalized_line_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" text,
	"shop_id" integer NOT NULL,
	"location_id" text,
	"provenance" jsonb NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted":false}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
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
	"quantity" numeric(10, 3) DEFAULT '1' NOT NULL,
	"quantity_unit" text DEFAULT 'each' NOT NULL,
	"unit_cost" numeric(12, 2) DEFAULT '0' NOT NULL,
	"unit_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"extended_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"discount_percent" numeric(5, 2),
	"discount_amount" numeric(12, 2),
	"taxable" boolean DEFAULT true NOT NULL,
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
	"core_returned" boolean DEFAULT false NOT NULL,
	"core_returned_date" timestamp,
	"warranty_eligible" boolean DEFAULT false NOT NULL,
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
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalized_payments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" text,
	"shop_id" integer NOT NULL,
	"location_id" text,
	"provenance" jsonb NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted":false}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"work_order_id" varchar NOT NULL,
	"invoice_id" text,
	"payment_number" text,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
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
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalized_service_jobs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" text,
	"shop_id" integer NOT NULL,
	"location_id" text,
	"provenance" jsonb NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted":false}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"work_order_id" varchar NOT NULL,
	"job_number" text,
	"sequence" integer DEFAULT 0 NOT NULL,
	"job_type" "service_job_type" DEFAULT 'custom' NOT NULL,
	"status" "service_job_status" DEFAULT 'pending' NOT NULL,
	"status_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"canned_job_id" text,
	"canned_job_code" text,
	"canned_job_name" text,
	"labor_operation_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"technician_id" text,
	"technician_name" text,
	"labor_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"parts_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"sublet_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"fees_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"discount_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"labor_hours_estimated" numeric(8, 2),
	"labor_hours_actual" numeric(8, 2),
	"labor_hours_billed" numeric(8, 2),
	"is_warranty" boolean DEFAULT false NOT NULL,
	"warranty_claim_id" text,
	"is_sublet" boolean DEFAULT false NOT NULL,
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
	"components_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalized_vehicles" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" text,
	"shop_id" integer NOT NULL,
	"location_id" text,
	"provenance" jsonb NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted":false}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"vin" text,
	"vin_decoded" boolean DEFAULT false NOT NULL,
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
	"is_fleet" boolean DEFAULT false NOT NULL,
	"fleet_id" text,
	"fleet_unit_number" text,
	"current_odometer" integer,
	"odometer_unit" "distance_unit" DEFAULT 'miles' NOT NULL,
	"odometer_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated_annual_mileage" integer,
	"purchase_date" timestamp,
	"in_service_date" timestamp,
	"warranty_expiration_date" timestamp,
	"warranty_expiration_mileage" integer,
	"telematics_provider" text,
	"telematics_device_id" text,
	"notes" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"customer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_customer_id" text,
	"last_service_date" timestamp,
	"last_service_mileage" integer,
	"total_services_count" integer DEFAULT 0 NOT NULL,
	"total_services_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalized_work_orders" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enterprise_id" text,
	"shop_id" integer NOT NULL,
	"location_id" text,
	"provenance" jsonb NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted":false}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"work_order_number" text NOT NULL,
	"work_order_type" "work_order_type" DEFAULT 'repair' NOT NULL,
	"status" "work_order_status" DEFAULT 'draft' NOT NULL,
	"status_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vehicle_id" text NOT NULL,
	"vehicle" jsonb NOT NULL,
	"customer_id" text,
	"customer" jsonb,
	"odometer_in" integer,
	"odometer_out" integer,
	"odometer_unit" "distance_unit" DEFAULT 'miles' NOT NULL,
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
	"technicians" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"customer_concern" text,
	"technician_notes" text,
	"internal_notes" text,
	"subtotal" numeric(12, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"discount_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"grand_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"labor_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"parts_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"sublet_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"fees_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"labor_hours_total" numeric(8, 2) DEFAULT '0' NOT NULL,
	"labor_hours_billed" numeric(8, 2) DEFAULT '0' NOT NULL,
	"payments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"balance_due" numeric(12, 2) DEFAULT '0' NOT NULL,
	"is_warranty" boolean DEFAULT false NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"is_comeback" boolean DEFAULT false NOT NULL,
	"comeback_from_work_order_id" text,
	"appointment_id" text,
	"authorized_by" text,
	"authorized_at" timestamp,
	"authorized_method" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_contact_account_assignments" ADD CONSTRAINT "crm_contact_account_assignments_contact_id_crm_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."crm_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_account_assignments" ADD CONSTRAINT "crm_contact_account_assignments_account_id_crm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."crm_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_account_assignments" ADD CONSTRAINT "crm_contact_account_assignments_role_type_id_crm_contact_role_types_id_fk" FOREIGN KEY ("role_type_id") REFERENCES "public"."crm_contact_role_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_agency_assignments" ADD CONSTRAINT "crm_contact_agency_assignments_contact_id_crm_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."crm_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_agency_assignments" ADD CONSTRAINT "crm_contact_agency_assignments_agency_id_crm_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."crm_agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_agency_assignments" ADD CONSTRAINT "crm_contact_agency_assignments_role_type_id_crm_contact_role_types_id_fk" FOREIGN KEY ("role_type_id") REFERENCES "public"."crm_contact_role_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_location_assignments" ADD CONSTRAINT "crm_contact_location_assignments_contact_id_crm_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."crm_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_location_assignments" ADD CONSTRAINT "crm_contact_location_assignments_location_id_crm_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."crm_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_location_assignments" ADD CONSTRAINT "crm_contact_location_assignments_role_type_id_crm_contact_role_types_id_fk" FOREIGN KEY ("role_type_id") REFERENCES "public"."crm_contact_role_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_parent_org_assignments" ADD CONSTRAINT "crm_contact_parent_org_assignments_contact_id_crm_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."crm_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_parent_org_assignments" ADD CONSTRAINT "crm_contact_parent_org_assignments_parent_org_id_crm_parent_organizations_id_fk" FOREIGN KEY ("parent_org_id") REFERENCES "public"."crm_parent_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_parent_org_assignments" ADD CONSTRAINT "crm_contact_parent_org_assignments_role_type_id_crm_contact_role_types_id_fk" FOREIGN KEY ("role_type_id") REFERENCES "public"."crm_contact_role_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalized_line_items" ADD CONSTRAINT "normalized_line_items_work_order_id_normalized_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."normalized_work_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalized_line_items" ADD CONSTRAINT "normalized_line_items_service_job_id_normalized_service_jobs_id_fk" FOREIGN KEY ("service_job_id") REFERENCES "public"."normalized_service_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalized_payments" ADD CONSTRAINT "normalized_payments_work_order_id_normalized_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."normalized_work_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalized_service_jobs" ADD CONSTRAINT "normalized_service_jobs_work_order_id_normalized_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."normalized_work_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_contact_account_assign_contact_idx" ON "crm_contact_account_assignments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "crm_contact_account_assign_account_idx" ON "crm_contact_account_assignments" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "crm_contact_agency_assign_contact_idx" ON "crm_contact_agency_assignments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "crm_contact_agency_assign_agency_idx" ON "crm_contact_agency_assignments" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "crm_contact_location_assign_contact_idx" ON "crm_contact_location_assignments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "crm_contact_location_assign_loc_idx" ON "crm_contact_location_assignments" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "crm_contact_parent_org_assign_contact_idx" ON "crm_contact_parent_org_assignments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "crm_contact_parent_org_assign_org_idx" ON "crm_contact_parent_org_assignments" USING btree ("parent_org_id");--> statement-breakpoint
CREATE INDEX "crm_contacts_status_idx" ON "crm_contacts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "crm_contacts_email_idx" ON "crm_contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX "crm_contacts_name_idx" ON "crm_contacts" USING btree ("last_name","first_name");--> statement-breakpoint
CREATE INDEX "crm_entity_notes_entity_idx" ON "crm_entity_notes" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "crm_entity_tasks_entity_idx" ON "crm_entity_tasks" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "crm_entity_tasks_status_idx" ON "crm_entity_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "nc_shop_id_idx" ON "normalized_customers" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "nc_enterprise_id_idx" ON "normalized_customers" USING btree ("enterprise_id");--> statement-breakpoint
CREATE INDEX "nc_full_name_idx" ON "normalized_customers" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "nc_company_name_idx" ON "normalized_customers" USING btree ("company_name");--> statement-breakpoint
CREATE INDEX "nc_dedupe_key_idx" ON "normalized_customers" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "nc_created_at_idx" ON "normalized_customers" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "nc_updated_at_idx" ON "normalized_customers" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "nli_work_order_id_idx" ON "normalized_line_items" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "nli_service_job_id_idx" ON "normalized_line_items" USING btree ("service_job_id");--> statement-breakpoint
CREATE INDEX "nli_shop_id_idx" ON "normalized_line_items" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "nli_enterprise_id_idx" ON "normalized_line_items" USING btree ("enterprise_id");--> statement-breakpoint
CREATE INDEX "nli_part_number_idx" ON "normalized_line_items" USING btree ("part_number");--> statement-breakpoint
CREATE INDEX "nli_line_type_idx" ON "normalized_line_items" USING btree ("line_type");--> statement-breakpoint
CREATE INDEX "nli_created_at_idx" ON "normalized_line_items" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "nli_updated_at_idx" ON "normalized_line_items" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "np_work_order_id_idx" ON "normalized_payments" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "np_shop_id_idx" ON "normalized_payments" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "np_enterprise_id_idx" ON "normalized_payments" USING btree ("enterprise_id");--> statement-breakpoint
CREATE INDEX "np_status_idx" ON "normalized_payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "np_transaction_id_idx" ON "normalized_payments" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "np_processed_at_idx" ON "normalized_payments" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "np_created_at_idx" ON "normalized_payments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "np_updated_at_idx" ON "normalized_payments" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "nsj_work_order_id_idx" ON "normalized_service_jobs" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "nsj_work_order_seq_idx" ON "normalized_service_jobs" USING btree ("work_order_id","sequence");--> statement-breakpoint
CREATE INDEX "nsj_shop_id_idx" ON "normalized_service_jobs" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "nsj_enterprise_id_idx" ON "normalized_service_jobs" USING btree ("enterprise_id");--> statement-breakpoint
CREATE INDEX "nsj_canned_job_code_idx" ON "normalized_service_jobs" USING btree ("canned_job_code");--> statement-breakpoint
CREATE INDEX "nsj_created_at_idx" ON "normalized_service_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "nsj_updated_at_idx" ON "normalized_service_jobs" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nv_shop_id_vin_idx" ON "normalized_vehicles" USING btree ("shop_id","vin");--> statement-breakpoint
CREATE INDEX "nv_enterprise_id_idx" ON "normalized_vehicles" USING btree ("enterprise_id");--> statement-breakpoint
CREATE INDEX "nv_vin_idx" ON "normalized_vehicles" USING btree ("vin");--> statement-breakpoint
CREATE INDEX "nv_make_model_year_idx" ON "normalized_vehicles" USING btree ("make","model","year");--> statement-breakpoint
CREATE INDEX "nv_created_at_idx" ON "normalized_vehicles" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "nv_updated_at_idx" ON "normalized_vehicles" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nwo_shop_id_wo_num_idx" ON "normalized_work_orders" USING btree ("shop_id","work_order_number");--> statement-breakpoint
CREATE INDEX "nwo_enterprise_id_idx" ON "normalized_work_orders" USING btree ("enterprise_id");--> statement-breakpoint
CREATE INDEX "nwo_vehicle_id_idx" ON "normalized_work_orders" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "nwo_customer_id_idx" ON "normalized_work_orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "nwo_status_idx" ON "normalized_work_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "nwo_closed_date_idx" ON "normalized_work_orders" USING btree ("closed_date");--> statement-breakpoint
CREATE INDEX "nwo_created_at_idx" ON "normalized_work_orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "nwo_updated_at_idx" ON "normalized_work_orders" USING btree ("updated_at");