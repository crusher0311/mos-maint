CREATE TABLE "banners" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"type" text DEFAULT 'info' NOT NULL,
	"link_url" text,
	"link_text" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "content_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_type" text NOT NULL,
	"content_id" varchar NOT NULL,
	"user_type_id" varchar,
	"assign_all" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_card_progress" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" varchar NOT NULL,
	"step_id" varchar,
	"checklist_id" varchar,
	"completed" boolean DEFAULT false NOT NULL,
	"completed_by" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_cards" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" varchar NOT NULL,
	"stage_id" varchar NOT NULL,
	"assignee_email" text,
	"assignee_name" text,
	"notes" text,
	"priority" text DEFAULT 'normal',
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_checklists" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "onboarding_guides_content" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "onboarding_stage_assignments" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage_id" varchar NOT NULL,
	"assignee_email" text,
	"assignee_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_stage_steps" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage_id" varchar NOT NULL,
	"step_id" varchar NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_stages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text DEFAULT '#3c81c3',
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "onboarding_step_checklists" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"step_id" varchar NOT NULL,
	"checklist_id" varchar NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_steps" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "tours" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"target_page" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "user_banner_progress" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"banner_id" varchar NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	"dismissed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_favorites" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"item_type" text NOT NULL,
	"item_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_onboarding_guide_progress" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"guide_id" varchar NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp,
	"current_step" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_tour_progress" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"tour_id" varchar NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp,
	"dismissed" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_workflow_sequence_progress" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"sequence_id" varchar NOT NULL,
	"current_step" integer DEFAULT 0,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_sequences" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_event" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "content_assignments" ADD CONSTRAINT "content_assignments_user_type_id_crm_user_types_id_fk" FOREIGN KEY ("user_type_id") REFERENCES "public"."crm_user_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_card_progress" ADD CONSTRAINT "onboarding_card_progress_card_id_onboarding_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."onboarding_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_card_progress" ADD CONSTRAINT "onboarding_card_progress_step_id_onboarding_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."onboarding_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_card_progress" ADD CONSTRAINT "onboarding_card_progress_checklist_id_onboarding_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."onboarding_checklists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_cards" ADD CONSTRAINT "onboarding_cards_location_id_crm_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."crm_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_cards" ADD CONSTRAINT "onboarding_cards_stage_id_onboarding_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."onboarding_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_stage_assignments" ADD CONSTRAINT "onboarding_stage_assignments_stage_id_onboarding_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."onboarding_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_stage_steps" ADD CONSTRAINT "onboarding_stage_steps_stage_id_onboarding_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."onboarding_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_stage_steps" ADD CONSTRAINT "onboarding_stage_steps_step_id_onboarding_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."onboarding_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_step_checklists" ADD CONSTRAINT "onboarding_step_checklists_step_id_onboarding_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."onboarding_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_step_checklists" ADD CONSTRAINT "onboarding_step_checklists_checklist_id_onboarding_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."onboarding_checklists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_banner_progress" ADD CONSTRAINT "user_banner_progress_banner_id_banners_id_fk" FOREIGN KEY ("banner_id") REFERENCES "public"."banners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_onboarding_guide_progress" ADD CONSTRAINT "user_onboarding_guide_progress_guide_id_onboarding_guides_content_id_fk" FOREIGN KEY ("guide_id") REFERENCES "public"."onboarding_guides_content"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tour_progress" ADD CONSTRAINT "user_tour_progress_tour_id_tours_id_fk" FOREIGN KEY ("tour_id") REFERENCES "public"."tours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_workflow_sequence_progress" ADD CONSTRAINT "user_workflow_sequence_progress_sequence_id_workflow_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."workflow_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_assignments_content_idx" ON "content_assignments" USING btree ("content_type","content_id");--> statement-breakpoint
CREATE INDEX "content_assignments_user_type_idx" ON "content_assignments" USING btree ("user_type_id");--> statement-breakpoint
CREATE INDEX "ob_card_progress_card_idx" ON "onboarding_card_progress" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "ob_card_progress_step_idx" ON "onboarding_card_progress" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "ob_cards_location_idx" ON "onboarding_cards" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "ob_cards_stage_idx" ON "onboarding_cards" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "ob_stage_assignments_stage_idx" ON "onboarding_stage_assignments" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "ob_stage_steps_stage_idx" ON "onboarding_stage_steps" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "ob_stage_steps_step_idx" ON "onboarding_stage_steps" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "ob_step_checklists_step_idx" ON "onboarding_step_checklists" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "ob_step_checklists_checklist_idx" ON "onboarding_step_checklists" USING btree ("checklist_id");--> statement-breakpoint
CREATE INDEX "user_banner_progress_user_idx" ON "user_banner_progress" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_banner_progress_banner_idx" ON "user_banner_progress" USING btree ("banner_id");--> statement-breakpoint
CREATE INDEX "user_favorites_user_idx" ON "user_favorites" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_favorites_item_idx" ON "user_favorites" USING btree ("item_type","item_id");--> statement-breakpoint
CREATE INDEX "user_guide_progress_user_idx" ON "user_onboarding_guide_progress" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_guide_progress_guide_idx" ON "user_onboarding_guide_progress" USING btree ("guide_id");--> statement-breakpoint
CREATE INDEX "user_tour_progress_user_idx" ON "user_tour_progress" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_tour_progress_tour_idx" ON "user_tour_progress" USING btree ("tour_id");--> statement-breakpoint
CREATE INDEX "user_workflow_progress_user_idx" ON "user_workflow_sequence_progress" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_workflow_progress_seq_idx" ON "user_workflow_sequence_progress" USING btree ("sequence_id");