CREATE TABLE "campaigns" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'email' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"subject" text,
	"body" text,
	"template_id" varchar,
	"scheduled_at" timestamp,
	"sent_at" timestamp,
	"audience_filter" jsonb DEFAULT '{}'::jsonb,
	"total_recipients" integer DEFAULT 0,
	"delivered" integer DEFAULT 0,
	"opened" integer DEFAULT 0,
	"clicked" integer DEFAULT 0,
	"bounced" integer DEFAULT 0,
	"unsubscribed" integer DEFAULT 0,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"discount_type" text DEFAULT 'percentage' NOT NULL,
	"discount_value" numeric(10, 2) NOT NULL,
	"min_purchase" numeric(10, 2),
	"max_uses" integer,
	"used_count" integer DEFAULT 0,
	"valid_from" timestamp,
	"valid_until" timestamp,
	"is_active" boolean DEFAULT true,
	"applicable_plans" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp,
	CONSTRAINT "coupons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "deal_funnel_stages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text DEFAULT '#3c81c3',
	"sort_order" integer DEFAULT 0 NOT NULL,
	"probability" integer DEFAULT 0,
	"is_default" boolean DEFAULT false,
	"is_won" boolean DEFAULT false,
	"is_lost" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"account_id" varchar,
	"stage_id" varchar NOT NULL,
	"value" numeric(12, 2) DEFAULT '0.00',
	"probability" integer DEFAULT 0,
	"expected_close_date" timestamp,
	"actual_close_date" timestamp,
	"contact_name" text,
	"contact_email" text,
	"contact_phone" text,
	"source" text,
	"notes" text,
	"assigned_to" text,
	"priority" text DEFAULT 'medium',
	"tags" jsonb DEFAULT '[]'::jsonb,
	"activities" jsonb DEFAULT '[]'::jsonb,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "getting_started_packages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"plan_id" varchar,
	"included_products" jsonb DEFAULT '[]'::jsonb,
	"price" numeric(10, 2),
	"setup_fee" numeric(10, 2) DEFAULT '0.00',
	"is_active" boolean DEFAULT true,
	"sort_order" integer DEFAULT 0,
	"features" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"category" text,
	"variables" jsonb DEFAULT '[]'::jsonb,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "pricing_plans" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"monthly_price" numeric(10, 2) NOT NULL,
	"annual_price" numeric(10, 2),
	"setup_fee" numeric(10, 2) DEFAULT '0.00',
	"trial_days" integer DEFAULT 0,
	"is_active" boolean DEFAULT true,
	"is_popular" boolean DEFAULT false,
	"sort_order" integer DEFAULT 0,
	"stripe_price_id_monthly" text,
	"stripe_price_id_annual" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp,
	CONSTRAINT "pricing_plans_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "product_features" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" varchar,
	"plan_id" varchar,
	"name" text NOT NULL,
	"description" text,
	"is_included" boolean DEFAULT true,
	"limit_value" text,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"category" text,
	"price" numeric(10, 2),
	"is_active" boolean DEFAULT true,
	"image_url" text,
	"stripe_product_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp,
	CONSTRAINT "products_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"discount_type" text DEFAULT 'percentage' NOT NULL,
	"discount_value" numeric(10, 2) NOT NULL,
	"applicable_plan_ids" jsonb DEFAULT '[]'::jsonb,
	"max_redemptions" integer,
	"redemption_count" integer DEFAULT 0,
	"valid_from" timestamp,
	"valid_until" timestamp,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp,
	CONSTRAINT "promo_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "specials" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'promotion' NOT NULL,
	"discount_type" text DEFAULT 'percentage',
	"discount_value" numeric(10, 2),
	"image_url" text,
	"start_date" timestamp,
	"end_date" timestamp,
	"is_active" boolean DEFAULT true,
	"target_audience" text,
	"terms" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_account_id_crm_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."crm_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_deal_funnel_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."deal_funnel_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "getting_started_packages" ADD CONSTRAINT "getting_started_packages_plan_id_pricing_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."pricing_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_features" ADD CONSTRAINT "product_features_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_features" ADD CONSTRAINT "product_features_plan_id_pricing_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."pricing_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaigns_type_idx" ON "campaigns" USING btree ("type");--> statement-breakpoint
CREATE INDEX "coupons_code_idx" ON "coupons" USING btree ("code");--> statement-breakpoint
CREATE INDEX "coupons_active_idx" ON "coupons" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "deals_stage_idx" ON "deals" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "deals_account_idx" ON "deals" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "deals_priority_idx" ON "deals" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "gsp_plan_idx" ON "getting_started_packages" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "gsp_active_idx" ON "getting_started_packages" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "msg_templates_channel_idx" ON "message_templates" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "msg_templates_category_idx" ON "message_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX "pricing_plans_slug_idx" ON "pricing_plans" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "pricing_plans_active_idx" ON "pricing_plans" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "product_features_product_idx" ON "product_features" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_features_plan_idx" ON "product_features" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "products_slug_idx" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category");--> statement-breakpoint
CREATE INDEX "promo_codes_code_idx" ON "promo_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "promo_codes_active_idx" ON "promo_codes" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "specials_active_idx" ON "specials" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "specials_type_idx" ON "specials" USING btree ("type");