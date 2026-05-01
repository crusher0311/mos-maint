CREATE TABLE "tekmetric_migration_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"phase" varchar(50) NOT NULL,
	"action" varchar(50) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tekmetric_migration_dumps" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"ros_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tekmetric_migration_mappings" (
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
--> statement-breakpoint
CREATE TABLE "tekmetric_migration_runs" (
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
--> statement-breakpoint
ALTER TABLE "tekmetric_migration_audit" ADD CONSTRAINT "tekmetric_migration_audit_run_id_tekmetric_migration_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tekmetric_migration_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tekmetric_migration_dumps" ADD CONSTRAINT "tekmetric_migration_dumps_run_id_tekmetric_migration_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tekmetric_migration_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tekmetric_migration_mappings" ADD CONSTRAINT "tekmetric_migration_mappings_run_id_tekmetric_migration_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tekmetric_migration_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tek_mig_audit_run_idx" ON "tekmetric_migration_audit" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "tek_mig_audit_phase_idx" ON "tekmetric_migration_audit" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "tek_mig_audit_created_at_idx" ON "tekmetric_migration_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tek_mig_dumps_run_idx" ON "tekmetric_migration_dumps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "tek_mig_dumps_expires_at_idx" ON "tekmetric_migration_dumps" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tek_mig_mappings_run_idx" ON "tekmetric_migration_mappings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "tek_mig_mappings_expires_at_idx" ON "tekmetric_migration_mappings" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tek_mig_runs_source_shop_idx" ON "tekmetric_migration_runs" USING btree ("source_shop_id");--> statement-breakpoint
CREATE INDEX "tek_mig_runs_dest_shop_idx" ON "tekmetric_migration_runs" USING btree ("dest_shop_id");--> statement-breakpoint
CREATE INDEX "tek_mig_runs_status_idx" ON "tekmetric_migration_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tek_mig_runs_created_at_idx" ON "tekmetric_migration_runs" USING btree ("created_at");
