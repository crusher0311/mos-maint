CREATE TYPE "public"."account_status" AS ENUM('active', 'trial', 'suspended', 'archived', 'churned');--> statement-breakpoint
CREATE TYPE "public"."agency_status" AS ENUM('active', 'suspended', 'archived');--> statement-breakpoint
CREATE TYPE "public"."location_status" AS ENUM('active', 'inactive', 'archived');--> statement-breakpoint
CREATE TYPE "public"."org_status" AS ENUM('active', 'suspended', 'archived');--> statement-breakpoint
CREATE TYPE "public"."pricing_interval" AS ENUM('monthly', 'quarterly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."user_type_bucket" AS ENUM('internal', 'external');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"parent_org_id" integer,
	"agency_id" integer,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"contact_email" varchar(255),
	"contact_phone" varchar(50),
	"website" varchar(500),
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"plan" varchar(50),
	"branding_id" integer,
	"legacy_shop_id" integer,
	"metadata" jsonb,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "agencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"contact_email" varchar(255),
	"contact_phone" varchar(50),
	"website" varchar(500),
	"status" "agency_status" DEFAULT 'active' NOT NULL,
	"stripe_connect_account_id" varchar(255),
	"branding_id" integer,
	"metadata" jsonb,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agencies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "agency_pricing_packages" (
	"id" serial PRIMARY KEY NOT NULL,
	"agency_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"base_price" real DEFAULT 0 NOT NULL,
	"interval" "pricing_interval" DEFAULT 'monthly' NOT NULL,
	"features" jsonb,
	"limits" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"stripe_price_id" varchar(255),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branding_themes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"primary_color" varchar(20),
	"secondary_color" varchar(20),
	"accent_color" varchar(20),
	"header_bg_color" varchar(20),
	"header_text_color" varchar(20),
	"font_family" varchar(255),
	"border_radius" varchar(20),
	"preview_config" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corporate_branding" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" integer NOT NULL,
	"logo_url" text,
	"favicon_url" text,
	"primary_color" varchar(20),
	"secondary_color" varchar(20),
	"accent_color" varchar(20),
	"header_bg_color" varchar(20),
	"header_text_color" varchar(20),
	"custom_css" text,
	"theme_id" integer,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"address_line_1" varchar(500),
	"address_line_2" varchar(500),
	"city" varchar(255),
	"state" varchar(100),
	"zip_code" varchar(20),
	"country" varchar(100) DEFAULT 'US',
	"phone" varchar(50),
	"email" varchar(255),
	"timezone" varchar(100),
	"latitude" real,
	"longitude" real,
	"status" "location_status" DEFAULT 'active' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"branding_id" integer,
	"metadata" jsonb,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parent_organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"agency_id" integer,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"contact_email" varchar(255),
	"contact_phone" varchar(50),
	"website" varchar(500),
	"status" "org_status" DEFAULT 'active' NOT NULL,
	"branding_id" integer,
	"metadata" jsonb,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parent_organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "user_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" text,
	"bucket" "user_type_bucket" DEFAULT 'external' NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_types_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_org_id_parent_organizations_id_fk" FOREIGN KEY ("parent_org_id") REFERENCES "public"."parent_organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_pricing_packages" ADD CONSTRAINT "agency_pricing_packages_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_organizations" ADD CONSTRAINT "parent_organizations_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_parent_org_id_idx" ON "accounts" USING btree ("parent_org_id");--> statement-breakpoint
CREATE INDEX "accounts_agency_id_idx" ON "accounts" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "accounts_status_idx" ON "accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "accounts_legacy_shop_id_idx" ON "accounts" USING btree ("legacy_shop_id");--> statement-breakpoint
CREATE INDEX "agencies_status_idx" ON "agencies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agencies_slug_idx" ON "agencies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "agency_pricing_agency_id_idx" ON "agency_pricing_packages" USING btree ("agency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "corporate_branding_entity_idx" ON "corporate_branding" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "locations_account_id_idx" ON "locations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "locations_status_idx" ON "locations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "locations_city_state_idx" ON "locations" USING btree ("city","state");--> statement-breakpoint
CREATE INDEX "parent_orgs_agency_id_idx" ON "parent_organizations" USING btree ("agency_id");--> statement-breakpoint
CREATE INDEX "parent_orgs_status_idx" ON "parent_organizations" USING btree ("status");