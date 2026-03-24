CREATE TYPE "public"."conversation_channel" AS ENUM('sms', 'voice', 'email', 'web_chat', 'internal');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('active', 'archived', 'closed');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('pending', 'sent', 'delivered', 'failed', 'read');--> statement-breakpoint
CREATE TYPE "public"."participant_role" AS ENUM('customer', 'agent', 'ai_assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."phone_number_status" AS ENUM('active', 'inactive', 'pending', 'released');--> statement-breakpoint
CREATE TYPE "public"."phone_number_type" AS ENUM('local', 'toll_free', 'mobile');--> statement-breakpoint
CREATE TYPE "public"."call_outcome" AS ENUM('answered', 'voicemail', 'missed', 'failed', 'transferred', 'callback_scheduled');--> statement-breakpoint
CREATE TYPE "public"."call_sentiment" AS ENUM('positive', 'neutral', 'negative', 'escalated');--> statement-breakpoint
CREATE TABLE "call_transcriptions" (
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
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
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
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" "participant_role" NOT NULL,
	"name" varchar(255),
	"phone" varchar(50),
	"email" varchar(255),
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
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
--> statement-breakpoint
CREATE TABLE "phone_numbers" (
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
--> statement-breakpoint
CREATE TABLE "sms_contacts" (
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
--> statement-breakpoint
CREATE TABLE "sms_messages" (
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
--> statement-breakpoint
CREATE TABLE "voicemails" (
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
--> statement-breakpoint
CREATE TABLE "api_usage_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"service" varchar(100) NOT NULL,
	"endpoint" varchar(255),
	"method" varchar(10),
	"tokens_input" integer,
	"tokens_output" integer,
	"total_tokens" integer,
	"cost_estimate" real,
	"latency_ms" integer,
	"status_code" integer,
	"error_message" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rescue_rover_call_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"call_sid" varchar(255),
	"caller_phone" varchar(50),
	"caller_name" varchar(255),
	"duration" integer,
	"outcome" "call_outcome",
	"sentiment" "call_sentiment",
	"transcription" text,
	"summary" text,
	"intent_detected" varchar(255),
	"appointment_scheduled" boolean DEFAULT false,
	"transferred_to" varchar(255),
	"ai_confidence_score" real,
	"tokens_used" integer,
	"cost_estimate" real,
	"recording_url" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rescue_rover_context_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer,
	"name" varchar(255) NOT NULL,
	"description" text,
	"context_type" varchar(50) NOT NULL,
	"match_pattern" jsonb NOT NULL,
	"response_guidance" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_global" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rescue_rover_prompt_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer,
	"name" varchar(255) NOT NULL,
	"description" text,
	"template_type" varchar(50) NOT NULL,
	"content" text NOT NULL,
	"variables" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rescue_rover_rcs_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"link_type" varchar(50) NOT NULL,
	"display_text" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rescue_rover_safety_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer,
	"name" varchar(255) NOT NULL,
	"description" text,
	"rule_type" varchar(50) NOT NULL,
	"condition" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_global" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rescue_rover_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"voice_id" varchar(100),
	"voice_provider" varchar(50) DEFAULT 'deepgram',
	"greeting" text,
	"after_hours_greeting" text,
	"max_call_duration" integer DEFAULT 300,
	"transfer_number" varchar(50),
	"enable_transcription" boolean DEFAULT true NOT NULL,
	"enable_sentiment_analysis" boolean DEFAULT false NOT NULL,
	"language" varchar(10) DEFAULT 'en',
	"timezone" varchar(50) DEFAULT 'America/New_York',
	"business_hours" jsonb,
	"custom_instructions" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rescue_rover_settings_shop_id_unique" UNIQUE("shop_id")
);
--> statement-breakpoint
CREATE TABLE "rescue_rover_voice_scripts" (
	"id" serial PRIMARY KEY NOT NULL,
	"shop_id" integer,
	"name" varchar(255) NOT NULL,
	"script_type" varchar(50) NOT NULL,
	"content" text NOT NULL,
	"trigger_condition" jsonb,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_contact_id_sms_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."sms_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_transcriptions_shop_id_idx" ON "call_transcriptions" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "call_transcriptions_created_at_idx" ON "call_transcriptions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "conv_messages_conversation_id_idx" ON "conversation_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conv_messages_created_at_idx" ON "conversation_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "conversations_shop_id_idx" ON "conversations" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "conversations_status_idx" ON "conversations" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "conversations_last_message_idx" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "sms_messages_shop_id_idx" ON "sms_messages" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "sms_messages_contact_id_idx" ON "sms_messages" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "sms_messages_conversation_id_idx" ON "sms_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "voicemails_shop_id_idx" ON "voicemails" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "voicemails_created_at_idx" ON "voicemails" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_usage_logs_shop_id_idx" ON "api_usage_logs" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "api_usage_logs_service_idx" ON "api_usage_logs" USING btree ("service");--> statement-breakpoint
CREATE INDEX "api_usage_logs_created_at_idx" ON "api_usage_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "rr_call_logs_shop_id_idx" ON "rescue_rover_call_logs" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "rr_call_logs_created_at_idx" ON "rescue_rover_call_logs" USING btree ("created_at");