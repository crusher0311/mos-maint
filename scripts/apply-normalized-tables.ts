import { getClient } from "../lib/db/drizzle";

const alterSql = `
DO $$
BEGIN
  -- Add source_system column to all normalized tables if missing
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_vehicles' AND column_name = 'source_system') THEN
    ALTER TABLE normalized_vehicles ADD COLUMN source_system text NOT NULL DEFAULT 'unknown';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_vehicles' AND column_name = 'content_hash') THEN
    ALTER TABLE normalized_vehicles ADD COLUMN content_hash text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_vehicles' AND column_name = 'soft_delete') THEN
    ALTER TABLE normalized_vehicles ADD COLUMN soft_delete jsonb DEFAULT '{"isDeleted": false}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_vehicles' AND column_name = 'provenance') THEN
    ALTER TABLE normalized_vehicles ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_customers' AND column_name = 'source_system') THEN
    ALTER TABLE normalized_customers ADD COLUMN source_system text NOT NULL DEFAULT 'unknown';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_customers' AND column_name = 'content_hash') THEN
    ALTER TABLE normalized_customers ADD COLUMN content_hash text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_customers' AND column_name = 'soft_delete') THEN
    ALTER TABLE normalized_customers ADD COLUMN soft_delete jsonb DEFAULT '{"isDeleted": false}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_customers' AND column_name = 'provenance') THEN
    ALTER TABLE normalized_customers ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_work_orders' AND column_name = 'source_system') THEN
    ALTER TABLE normalized_work_orders ADD COLUMN source_system text NOT NULL DEFAULT 'unknown';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_work_orders' AND column_name = 'content_hash') THEN
    ALTER TABLE normalized_work_orders ADD COLUMN content_hash text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_work_orders' AND column_name = 'soft_delete') THEN
    ALTER TABLE normalized_work_orders ADD COLUMN soft_delete jsonb DEFAULT '{"isDeleted": false}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_work_orders' AND column_name = 'provenance') THEN
    ALTER TABLE normalized_work_orders ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_service_jobs' AND column_name = 'source_system') THEN
    ALTER TABLE normalized_service_jobs ADD COLUMN source_system text NOT NULL DEFAULT 'unknown';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_service_jobs' AND column_name = 'content_hash') THEN
    ALTER TABLE normalized_service_jobs ADD COLUMN content_hash text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_service_jobs' AND column_name = 'soft_delete') THEN
    ALTER TABLE normalized_service_jobs ADD COLUMN soft_delete jsonb DEFAULT '{"isDeleted": false}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_service_jobs' AND column_name = 'provenance') THEN
    ALTER TABLE normalized_service_jobs ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_line_items' AND column_name = 'source_system') THEN
    ALTER TABLE normalized_line_items ADD COLUMN source_system text NOT NULL DEFAULT 'unknown';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_line_items' AND column_name = 'content_hash') THEN
    ALTER TABLE normalized_line_items ADD COLUMN content_hash text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_line_items' AND column_name = 'soft_delete') THEN
    ALTER TABLE normalized_line_items ADD COLUMN soft_delete jsonb DEFAULT '{"isDeleted": false}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_line_items' AND column_name = 'provenance') THEN
    ALTER TABLE normalized_line_items ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_payments' AND column_name = 'source_system') THEN
    ALTER TABLE normalized_payments ADD COLUMN source_system text NOT NULL DEFAULT 'unknown';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_payments' AND column_name = 'content_hash') THEN
    ALTER TABLE normalized_payments ADD COLUMN content_hash text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_payments' AND column_name = 'soft_delete') THEN
    ALTER TABLE normalized_payments ADD COLUMN soft_delete jsonb DEFAULT '{"isDeleted": false}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_payments' AND column_name = 'provenance') THEN
    ALTER TABLE normalized_payments ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;

  -- Add raw_data JSONB column for full MongoDB document preservation
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_vehicles' AND column_name = 'raw_data') THEN
    ALTER TABLE normalized_vehicles ADD COLUMN raw_data jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_customers' AND column_name = 'raw_data') THEN
    ALTER TABLE normalized_customers ADD COLUMN raw_data jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_work_orders' AND column_name = 'raw_data') THEN
    ALTER TABLE normalized_work_orders ADD COLUMN raw_data jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_service_jobs' AND column_name = 'raw_data') THEN
    ALTER TABLE normalized_service_jobs ADD COLUMN raw_data jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_line_items' AND column_name = 'raw_data') THEN
    ALTER TABLE normalized_line_items ADD COLUMN raw_data jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'normalized_payments' AND column_name = 'raw_data') THEN
    ALTER TABLE normalized_payments ADD COLUMN raw_data jsonb;
  END IF;
END $$;

-- Create indexes that might be missing
CREATE INDEX IF NOT EXISTS "nv_shop_id_idx" ON "normalized_vehicles" USING btree ("shop_id");
CREATE INDEX IF NOT EXISTS "nv_vin_idx" ON "normalized_vehicles" USING btree ("vin");
CREATE UNIQUE INDEX IF NOT EXISTS "nv_shop_vin_idx" ON "normalized_vehicles" USING btree ("shop_id","vin");
CREATE INDEX IF NOT EXISTS "nv_source_system_idx" ON "normalized_vehicles" USING btree ("source_system");

CREATE INDEX IF NOT EXISTS "nc_shop_id_idx" ON "normalized_customers" USING btree ("shop_id");
CREATE INDEX IF NOT EXISTS "nc_source_system_idx" ON "normalized_customers" USING btree ("source_system");

CREATE INDEX IF NOT EXISTS "nwo_shop_id_idx" ON "normalized_work_orders" USING btree ("shop_id");
CREATE INDEX IF NOT EXISTS "nwo_vehicle_id_idx" ON "normalized_work_orders" USING btree ("vehicle_id");
CREATE INDEX IF NOT EXISTS "nwo_customer_id_idx" ON "normalized_work_orders" USING btree ("customer_id");
CREATE INDEX IF NOT EXISTS "nwo_status_idx" ON "normalized_work_orders" USING btree ("status");
CREATE INDEX IF NOT EXISTS "nwo_source_system_idx" ON "normalized_work_orders" USING btree ("source_system");
CREATE INDEX IF NOT EXISTS "nwo_closed_date_idx" ON "normalized_work_orders" USING btree ("closed_date");

CREATE INDEX IF NOT EXISTS "nsj_shop_id_idx" ON "normalized_service_jobs" USING btree ("shop_id");
CREATE INDEX IF NOT EXISTS "nsj_work_order_id_idx" ON "normalized_service_jobs" USING btree ("work_order_id");
CREATE INDEX IF NOT EXISTS "nsj_source_system_idx" ON "normalized_service_jobs" USING btree ("source_system");

CREATE INDEX IF NOT EXISTS "nli_shop_id_idx" ON "normalized_line_items" USING btree ("shop_id");
CREATE INDEX IF NOT EXISTS "nli_work_order_id_idx" ON "normalized_line_items" USING btree ("work_order_id");
CREATE INDEX IF NOT EXISTS "nli_service_job_id_idx" ON "normalized_line_items" USING btree ("service_job_id");
CREATE INDEX IF NOT EXISTS "nli_source_system_idx" ON "normalized_line_items" USING btree ("source_system");

CREATE INDEX IF NOT EXISTS "np_shop_id_idx" ON "normalized_payments" USING btree ("shop_id");
CREATE INDEX IF NOT EXISTS "np_work_order_id_idx" ON "normalized_payments" USING btree ("work_order_id");
CREATE INDEX IF NOT EXISTS "np_source_system_idx" ON "normalized_payments" USING btree ("source_system");
`;

async function main() {
  const client = getClient();
  console.log("Applying normalized tables migration (alter + indexes)...");
  await client.unsafe(alterSql);
  console.log("Migration applied successfully!");
  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
