-- Task #1020 — full-schema baseline for fresh environments.
--
-- scripts/apply-normalized-migration.ts is the canonical schema path
-- (drizzle-kit db:generate is dead — journal drift since 0012). The wave
-- files (0011-0026) cover the wave1-4 + later tables, but the tables that
-- predate the wave migrations (communications family, production_logs,
-- sniffer_sessions, enhance_corrections, platform_features,
-- tekmetric_migration_*, support_tickets) were only ever created by the
-- pre-drift generated migrations (0000-0007), which the apply script does
-- not run. A truly fresh Postgres would silently lack them.
--
-- Generated from lib/db/schema/* (the source of truth) via drizzle-kit/api
-- generateMigration, then made idempotent (IF NOT EXISTS / guarded DO
-- blocks) so it is safe to re-run against prod Supabase, where all of
-- these tables already exist. If a schema/*.ts table changes, regenerate
-- or hand-mirror the change here the same way as the other wave files.

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_channel') THEN CREATE TYPE "public"."conversation_channel" AS ENUM('sms', 'voice', 'email', 'web_chat', 'internal'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_status') THEN CREATE TYPE "public"."conversation_status" AS ENUM('active', 'archived', 'closed'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'group_status') THEN CREATE TYPE "public"."group_status" AS ENUM('active', 'inactive'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_direction') THEN CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'message_status') THEN CREATE TYPE "public"."message_status" AS ENUM('pending', 'sent', 'delivered', 'failed', 'read'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'participant_role') THEN CREATE TYPE "public"."participant_role" AS ENUM('customer', 'agent', 'ai_assistant', 'system'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'phone_number_status') THEN CREATE TYPE "public"."phone_number_status" AS ENUM('active', 'inactive', 'pending', 'released'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'phone_number_type') THEN CREATE TYPE "public"."phone_number_type" AS ENUM('local', 'toll_free', 'mobile'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'time_entry_status') THEN CREATE TYPE "public"."time_entry_status" AS ENUM('active', 'completed'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'time_entry_type') THEN CREATE TYPE "public"."time_entry_type" AS ENUM('shift', 'break'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_category') THEN CREATE TYPE "public"."ticket_category" AS ENUM('technical', 'billing', 'integration', 'feature_request', 'general'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_priority') THEN CREATE TYPE "public"."ticket_priority" AS ENUM('low', 'medium', 'high', 'urgent'); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_status') THEN CREATE TYPE "public"."ticket_status" AS ENUM('open', 'in_progress', 'pending', 'resolved', 'closed'); END IF; END $$;
CREATE TABLE IF NOT EXISTS "agent_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"agent_name" varchar(255) NOT NULL,
	"agent_email" varchar(255),
	"calls_target" integer DEFAULT 0 NOT NULL,
	"conversion_target" numeric(5, 2) DEFAULT '0',
	"revenue_target" numeric(12, 2) DEFAULT '0',
	"calls_actual" integer DEFAULT 0 NOT NULL,
	"conversion_actual" numeric(5, 2) DEFAULT '0',
	"revenue_actual" numeric(12, 2) DEFAULT '0',
	"period" varchar(50) DEFAULT 'monthly' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "call_transcriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"call_sid" varchar(255),
	"caller_phone" varchar(50),
	"agent_phone" varchar(50),
	"direction" "message_direction",
	"duration" integer,
	"transcription_text" text,
	"summary" text,
	"sentiment" varchar(50),
	"topics" jsonb,
	"recording_url" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "canned_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"category" varchar(100),
	"shortcut" varchar(50),
	"is_active" boolean DEFAULT true NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "conversation_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"direction" "message_direction" NOT NULL,
	"status" "message_status" DEFAULT 'pending' NOT NULL,
	"body" text,
	"sender_name" varchar(255),
	"sender_phone" varchar(50),
	"sender_type" "participant_role" DEFAULT 'customer',
	"media_urls" jsonb,
	"external_id" varchar(255),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "conversation_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" "participant_role" NOT NULL,
	"name" varchar(255),
	"phone" varchar(50),
	"email" varchar(255),
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"channel" "conversation_channel" DEFAULT 'sms' NOT NULL,
	"status" "conversation_status" DEFAULT 'active' NOT NULL,
	"subject" text,
	"customer_name" varchar(255),
	"customer_phone" varchar(50),
	"customer_email" varchar(255),
	"assigned_to" varchar(255),
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"status" "group_status" DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "phone_numbers" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"phone_number" varchar(50) NOT NULL,
	"friendly_name" varchar(255),
	"type" "phone_number_type" DEFAULT 'local',
	"status" "phone_number_status" DEFAULT 'active' NOT NULL,
	"capabilities" jsonb,
	"twilio_sid" varchar(255),
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_numbers_phone_number_unique" UNIQUE("phone_number")
);
CREATE TABLE IF NOT EXISTS "sms_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"phone_number" varchar(50) NOT NULL,
	"first_name" varchar(255),
	"last_name" varchar(255),
	"email" varchar(255),
	"opted_in" boolean DEFAULT true NOT NULL,
	"opted_in_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"last_contacted_at" timestamp with time zone,
	"tags" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "sms_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"contact_id" integer,
	"conversation_id" integer,
	"direction" "message_direction" NOT NULL,
	"status" "message_status" DEFAULT 'pending' NOT NULL,
	"from_number" varchar(50) NOT NULL,
	"to_number" varchar(50) NOT NULL,
	"body" text,
	"media_urls" jsonb,
	"twilio_sid" varchar(255),
	"error_code" varchar(50),
	"error_message" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "time_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_name" varchar(255) NOT NULL,
	"agent_email" varchar(255),
	"type" time_entry_type DEFAULT 'shift' NOT NULL,
	"status" time_entry_status DEFAULT 'active' NOT NULL,
	"clock_in" timestamp with time zone DEFAULT now() NOT NULL,
	"clock_out" timestamp with time zone,
	"break_start" timestamp with time zone,
	"break_end" timestamp with time zone,
	"total_break_minutes" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "voicemails" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"caller_phone" varchar(50),
	"caller_name" varchar(255),
	"recipient_phone" varchar(50),
	"duration" integer,
	"recording_url" text,
	"recording_sid" varchar(255),
	"transcription" text,
	"transcription_status" varchar(50),
	"is_read" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "production_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"dt" timestamp with time zone NOT NULL,
	"level" varchar(20) DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"message_json" jsonb,
	"appname" varchar(100),
	"host" varchar(100),
	"raw" text,
	"dt_hash" varchar(64) NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_logs_dt_hash_unique" UNIQUE("dt_hash")
);
CREATE TABLE IF NOT EXISTS "sniffer_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"uploaded_by" varchar(255) NOT NULL,
	"uploaded_by_email" varchar(255),
	"platform" varchar(50),
	"label" varchar(255),
	"capture_count" integer DEFAULT 0 NOT NULL,
	"captures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "enhance_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"mos_shop_id" integer NOT NULL,
	"task_name" varchar(500),
	"ai_suggested" text NOT NULL,
	"advisor_wrote" text NOT NULL,
	"advisor_email" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "platform_features" (
	"id" serial PRIMARY KEY NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" text,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"included_in_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_features_slug_unique" UNIQUE("slug")
);
CREATE TABLE IF NOT EXISTS "tekmetric_migration_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"phase" varchar(50) NOT NULL,
	"action" varchar(50) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "tekmetric_migration_dumps" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"ros_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "tekmetric_migration_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"mapping" jsonb NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"successes_count" integer DEFAULT 0 NOT NULL,
	"failures_count" integer DEFAULT 0 NOT NULL,
	"reused_count" integer DEFAULT 0 NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "tekmetric_migration_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_shop_id" bigint NOT NULL,
	"source_shop_name" varchar(255),
	"dest_shop_id" bigint NOT NULL,
	"dest_shop_name" varchar(255),
	"status" varchar(50) DEFAULT 'created' NOT NULL,
	"last_phase" varchar(50),
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_by" varchar(255) NOT NULL,
	"created_by_email" varchar(255),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "support_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"mongo_id" text,
	"ticket_number" varchar(50) NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"category" "ticket_category" DEFAULT 'general' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'medium' NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"source" varchar(50) DEFAULT 'web',
	"shop_id" integer,
	"shop_name" varchar(255),
	"location_identifier" varchar(255),
	"user_email" varchar(255),
	"user_name" varchar(255),
	"caller_phone" varchar(50),
	"call_sid" varchar(100),
	"assigned_to" varchar(255),
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"auto_closed_at" timestamp with time zone,
	"messages" jsonb DEFAULT '[]'::jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_ticket_number_unique" UNIQUE("ticket_number")
);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_targets_group_id_groups_id_fk') THEN ALTER TABLE "agent_targets" ADD CONSTRAINT "agent_targets_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_messages_conversation_id_conversations_id_fk') THEN ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_participants_conversation_id_conversations_id_fk') THEN ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sms_messages_contact_id_sms_contacts_id_fk') THEN ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_contact_id_sms_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."sms_contacts"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sms_messages_conversation_id_conversations_id_fk') THEN ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tekmetric_migration_audit_run_id_tekmetric_migration_runs_id_fk') THEN ALTER TABLE "tekmetric_migration_audit" ADD CONSTRAINT "tekmetric_migration_audit_run_id_tekmetric_migration_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tekmetric_migration_runs"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tekmetric_migration_dumps_run_id_tekmetric_migration_runs_id_fk') THEN ALTER TABLE "tekmetric_migration_dumps" ADD CONSTRAINT "tekmetric_migration_dumps_run_id_tekmetric_migration_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tekmetric_migration_runs"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tekmetric_migration_mappings_run_id_tekmetric_migration_runs_id_fk') THEN ALTER TABLE "tekmetric_migration_mappings" ADD CONSTRAINT "tekmetric_migration_mappings_run_id_tekmetric_migration_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tekmetric_migration_runs"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
CREATE INDEX IF NOT EXISTS "agent_targets_group_id_idx" ON "agent_targets" USING btree ("group_id");
CREATE INDEX IF NOT EXISTS "agent_targets_agent_email_idx" ON "agent_targets" USING btree ("agent_email");
CREATE INDEX IF NOT EXISTS "call_transcriptions_shop_id_idx" ON "call_transcriptions" USING btree ("shop_id");
CREATE INDEX IF NOT EXISTS "call_transcriptions_created_at_idx" ON "call_transcriptions" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "canned_messages_category_idx" ON "canned_messages" USING btree ("category");
CREATE INDEX IF NOT EXISTS "canned_messages_is_active_idx" ON "canned_messages" USING btree ("is_active");
CREATE INDEX IF NOT EXISTS "conv_messages_conversation_id_idx" ON "conversation_messages" USING btree ("conversation_id");
CREATE INDEX IF NOT EXISTS "conv_messages_created_at_idx" ON "conversation_messages" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "conversations_shop_id_idx" ON "conversations" USING btree ("shop_id");
CREATE INDEX IF NOT EXISTS "conversations_status_idx" ON "conversations" USING btree ("shop_id","status");
CREATE INDEX IF NOT EXISTS "conversations_last_message_idx" ON "conversations" USING btree ("last_message_at");
CREATE INDEX IF NOT EXISTS "groups_status_idx" ON "groups" USING btree ("status");
CREATE INDEX IF NOT EXISTS "sms_messages_shop_id_idx" ON "sms_messages" USING btree ("shop_id");
CREATE INDEX IF NOT EXISTS "sms_messages_contact_id_idx" ON "sms_messages" USING btree ("contact_id");
CREATE INDEX IF NOT EXISTS "sms_messages_conversation_id_idx" ON "sms_messages" USING btree ("conversation_id");
CREATE INDEX IF NOT EXISTS "time_entries_agent_email_idx" ON "time_entries" USING btree ("agent_email");
CREATE INDEX IF NOT EXISTS "time_entries_status_idx" ON "time_entries" USING btree ("status");
CREATE INDEX IF NOT EXISTS "time_entries_clock_in_idx" ON "time_entries" USING btree ("clock_in");
CREATE INDEX IF NOT EXISTS "voicemails_shop_id_idx" ON "voicemails" USING btree ("shop_id");
CREATE INDEX IF NOT EXISTS "voicemails_created_at_idx" ON "voicemails" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "production_logs_dt_idx" ON "production_logs" USING btree ("dt");
CREATE INDEX IF NOT EXISTS "production_logs_level_idx" ON "production_logs" USING btree ("level");
CREATE INDEX IF NOT EXISTS "production_logs_appname_idx" ON "production_logs" USING btree ("appname");
CREATE INDEX IF NOT EXISTS "production_logs_dt_hash_idx" ON "production_logs" USING btree ("dt_hash");
CREATE INDEX IF NOT EXISTS "sniffer_sessions_created_at_idx" ON "sniffer_sessions" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "sniffer_sessions_platform_idx" ON "sniffer_sessions" USING btree ("platform");
CREATE INDEX IF NOT EXISTS "sniffer_sessions_uploaded_by_idx" ON "sniffer_sessions" USING btree ("uploaded_by");
CREATE INDEX IF NOT EXISTS "enhance_corrections_mos_shop_id_idx" ON "enhance_corrections" USING btree ("mos_shop_id");
CREATE INDEX IF NOT EXISTS "enhance_corrections_created_at_idx" ON "enhance_corrections" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "platform_features_slug_idx" ON "platform_features" USING btree ("slug");
CREATE INDEX IF NOT EXISTS "platform_features_status_idx" ON "platform_features" USING btree ("status");
CREATE INDEX IF NOT EXISTS "tek_mig_audit_run_idx" ON "tekmetric_migration_audit" USING btree ("run_id");
CREATE INDEX IF NOT EXISTS "tek_mig_audit_phase_idx" ON "tekmetric_migration_audit" USING btree ("phase");
CREATE INDEX IF NOT EXISTS "tek_mig_audit_created_at_idx" ON "tekmetric_migration_audit" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "tek_mig_dumps_run_idx" ON "tekmetric_migration_dumps" USING btree ("run_id");
CREATE INDEX IF NOT EXISTS "tek_mig_dumps_expires_at_idx" ON "tekmetric_migration_dumps" USING btree ("expires_at");
CREATE INDEX IF NOT EXISTS "tek_mig_mappings_run_idx" ON "tekmetric_migration_mappings" USING btree ("run_id");
CREATE INDEX IF NOT EXISTS "tek_mig_mappings_expires_at_idx" ON "tekmetric_migration_mappings" USING btree ("expires_at");
CREATE INDEX IF NOT EXISTS "tek_mig_runs_source_shop_idx" ON "tekmetric_migration_runs" USING btree ("source_shop_id");
CREATE INDEX IF NOT EXISTS "tek_mig_runs_dest_shop_idx" ON "tekmetric_migration_runs" USING btree ("dest_shop_id");
CREATE INDEX IF NOT EXISTS "tek_mig_runs_status_idx" ON "tekmetric_migration_runs" USING btree ("status");
CREATE INDEX IF NOT EXISTS "tek_mig_runs_created_at_idx" ON "tekmetric_migration_runs" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "support_tickets_shop_id_idx" ON "support_tickets" USING btree ("shop_id");
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx" ON "support_tickets" USING btree ("status");
CREATE INDEX IF NOT EXISTS "support_tickets_user_email_idx" ON "support_tickets" USING btree ("user_email");
CREATE INDEX IF NOT EXISTS "support_tickets_created_at_idx" ON "support_tickets" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "support_tickets_mongo_id_idx" ON "support_tickets" USING btree ("mongo_id");
