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
	"id" text PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"enterprise_id" text,
	"customer_type" text DEFAULT 'individual',
	"first_name" text,
	"last_name" text,
	"full_name" text,
	"company_name" text,
	"contacts" jsonb DEFAULT '[]'::jsonb,
	"billing_address" jsonb,
	"mailing_address" jsonb,
	"tax_exempt" boolean DEFAULT false,
	"account_number" text,
	"ar_balance" numeric(12, 2) DEFAULT '0',
	"marketing_consent" boolean DEFAULT false,
	"sms_consent" boolean DEFAULT false,
	"email_consent" boolean DEFAULT false,
	"vehicle_ids" jsonb DEFAULT '[]'::jsonb,
	"total_visits" integer DEFAULT 0,
	"total_spent" numeric(12, 2) DEFAULT '0',
	"average_ticket" numeric(12, 2) DEFAULT '0',
	"last_visit_date" timestamp,
	"notes" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"custom_fields" jsonb DEFAULT '{}'::jsonb,
	"provenance" jsonb NOT NULL,
	"content_hash" text,
	"source_system" text NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted": false}'::jsonb,
	"version" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalized_line_items" (
	"id" text PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"enterprise_id" text,
	"work_order_id" text NOT NULL,
	"service_job_id" text NOT NULL,
	"line_number" integer DEFAULT 0,
	"line_type" text DEFAULT 'part',
	"part_number" text,
	"part_description" text,
	"part_brand" text,
	"part_condition" text,
	"quantity" numeric(10, 2) DEFAULT '0',
	"quantity_unit" text DEFAULT 'each',
	"unit_cost" numeric(12, 2) DEFAULT '0',
	"unit_price" numeric(12, 2) DEFAULT '0',
	"extended_price" numeric(12, 2) DEFAULT '0',
	"discount_amount" numeric(12, 2),
	"taxable" boolean DEFAULT true,
	"tax_amount" numeric(12, 2),
	"labor_type" text,
	"labor_hours" numeric(8, 2),
	"labor_rate" numeric(10, 2),
	"technician_name" text,
	"vendor_name" text,
	"notes" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb,
	"provenance" jsonb NOT NULL,
	"content_hash" text,
	"source_system" text NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted": false}'::jsonb,
	"version" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalized_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"enterprise_id" text,
	"work_order_id" text NOT NULL,
	"invoice_id" text,
	"payment_number" text,
	"status" text DEFAULT 'paid',
	"method" text DEFAULT 'other',
	"amount" numeric(12, 2) DEFAULT '0',
	"tip_amount" numeric(12, 2),
	"processed_at" timestamp,
	"card_brand" text,
	"card_last4" text,
	"check_number" text,
	"transaction_id" text,
	"reference_number" text,
	"refunded_amount" numeric(12, 2),
	"refunded_at" timestamp,
	"notes" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb,
	"provenance" jsonb NOT NULL,
	"content_hash" text,
	"source_system" text NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted": false}'::jsonb,
	"version" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalized_service_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"enterprise_id" text,
	"work_order_id" text NOT NULL,
	"job_number" text,
	"sequence" integer DEFAULT 0,
	"job_type" text DEFAULT 'custom',
	"status" text DEFAULT 'completed',
	"title" text NOT NULL,
	"description" text,
	"canned_job_id" text,
	"canned_job_code" text,
	"technician_id" text,
	"technician_name" text,
	"labor_total" numeric(12, 2) DEFAULT '0',
	"parts_total" numeric(12, 2) DEFAULT '0',
	"sublet_total" numeric(12, 2) DEFAULT '0',
	"fees_total" numeric(12, 2) DEFAULT '0',
	"discount_total" numeric(12, 2) DEFAULT '0',
	"total" numeric(12, 2) DEFAULT '0',
	"labor_hours_estimated" numeric(8, 2),
	"labor_hours_actual" numeric(8, 2),
	"labor_hours_billed" numeric(8, 2),
	"is_warranty" boolean DEFAULT false,
	"is_sublet" boolean DEFAULT false,
	"sublet_vendor" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"custom_fields" jsonb DEFAULT '{}'::jsonb,
	"provenance" jsonb NOT NULL,
	"content_hash" text,
	"source_system" text NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted": false}'::jsonb,
	"version" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalized_vehicles" (
	"id" text PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"enterprise_id" text,
	"vin" text,
	"year" integer,
	"make" text,
	"model" text,
	"submodel" text,
	"trim" text,
	"body_style" text,
	"engine_description" text,
	"engine_cylinders" integer,
	"fuel_type" text,
	"transmission" text,
	"drivetrain" text,
	"exterior_color" text,
	"license_plate" text,
	"license_plate_state" text,
	"current_odometer" integer,
	"odometer_unit" text DEFAULT 'miles',
	"is_fleet" boolean DEFAULT false,
	"fleet_id" text,
	"customer_ids" jsonb DEFAULT '[]'::jsonb,
	"primary_customer_id" text,
	"total_services_count" integer DEFAULT 0,
	"total_services_amount" numeric(12, 2) DEFAULT '0',
	"last_service_date" timestamp,
	"notes" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"custom_fields" jsonb DEFAULT '{}'::jsonb,
	"provenance" jsonb NOT NULL,
	"content_hash" text,
	"source_system" text NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted": false}'::jsonb,
	"version" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalized_work_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"enterprise_id" text,
	"work_order_number" text,
	"work_order_type" text DEFAULT 'repair',
	"status" text DEFAULT 'closed',
	"vehicle_id" text,
	"customer_id" text,
	"vehicle" jsonb,
	"customer" jsonb,
	"odometer_in" integer,
	"odometer_out" integer,
	"odometer_unit" text DEFAULT 'miles',
	"check_in_date" timestamp,
	"started_date" timestamp,
	"completed_date" timestamp,
	"closed_date" timestamp,
	"service_advisor_name" text,
	"subtotal" numeric(12, 2) DEFAULT '0',
	"tax_total" numeric(12, 2) DEFAULT '0',
	"discount_total" numeric(12, 2) DEFAULT '0',
	"grand_total" numeric(12, 2) DEFAULT '0',
	"labor_total" numeric(12, 2) DEFAULT '0',
	"parts_total" numeric(12, 2) DEFAULT '0',
	"sublet_total" numeric(12, 2) DEFAULT '0',
	"fees_total" numeric(12, 2) DEFAULT '0',
	"labor_hours_total" numeric(8, 2) DEFAULT '0',
	"labor_hours_billed" numeric(8, 2) DEFAULT '0',
	"balance_due" numeric(12, 2) DEFAULT '0',
	"is_warranty" boolean DEFAULT false,
	"is_internal" boolean DEFAULT false,
	"is_comeback" boolean DEFAULT false,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"custom_fields" jsonb DEFAULT '{}'::jsonb,
	"provenance" jsonb NOT NULL,
	"content_hash" text,
	"source_system" text NOT NULL,
	"soft_delete" jsonb DEFAULT '{"isDeleted": false}'::jsonb,
	"version" integer DEFAULT 1,
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
CREATE INDEX "nc_source_system_idx" ON "normalized_customers" USING btree ("source_system");--> statement-breakpoint
CREATE INDEX "nli_shop_id_idx" ON "normalized_line_items" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "nli_work_order_id_idx" ON "normalized_line_items" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "nli_service_job_id_idx" ON "normalized_line_items" USING btree ("service_job_id");--> statement-breakpoint
CREATE INDEX "nli_source_system_idx" ON "normalized_line_items" USING btree ("source_system");--> statement-breakpoint
CREATE INDEX "np_shop_id_idx" ON "normalized_payments" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "np_work_order_id_idx" ON "normalized_payments" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "np_source_system_idx" ON "normalized_payments" USING btree ("source_system");--> statement-breakpoint
CREATE INDEX "nsj_shop_id_idx" ON "normalized_service_jobs" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "nsj_work_order_id_idx" ON "normalized_service_jobs" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "nsj_source_system_idx" ON "normalized_service_jobs" USING btree ("source_system");--> statement-breakpoint
CREATE INDEX "nv_shop_id_idx" ON "normalized_vehicles" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "nv_vin_idx" ON "normalized_vehicles" USING btree ("vin");--> statement-breakpoint
CREATE UNIQUE INDEX "nv_shop_vin_idx" ON "normalized_vehicles" USING btree ("shop_id","vin");--> statement-breakpoint
CREATE INDEX "nv_source_system_idx" ON "normalized_vehicles" USING btree ("source_system");--> statement-breakpoint
CREATE INDEX "nwo_shop_id_idx" ON "normalized_work_orders" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "nwo_vehicle_id_idx" ON "normalized_work_orders" USING btree ("vehicle_id");--> statement-breakpoint
CREATE INDEX "nwo_customer_id_idx" ON "normalized_work_orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "nwo_status_idx" ON "normalized_work_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "nwo_source_system_idx" ON "normalized_work_orders" USING btree ("source_system");--> statement-breakpoint
CREATE INDEX "nwo_closed_date_idx" ON "normalized_work_orders" USING btree ("closed_date");