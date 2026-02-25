#!/usr/bin/env npx tsx
import { execSync, spawnSync } from "child_process";
import postgres from "postgres";

const SUPABASE_URL = process.env.DATAONE_DATABASE_URL!;
const SOURCE_URL = process.env.DATABASE_URL!;

if (!SUPABASE_URL) {
  console.error("DATAONE_DATABASE_URL is not set");
  process.exit(1);
}

const TABLES = [
  "dataone_def_maintenance_event",
  "dataone_def_maintenance_computer_code",
  "dataone_def_maintenance_schedule",
  "dataone_def_maintenance_interval",
  "dataone_def_maintenance_operating_parameter",
  "dataone_def_maintenance",
  "dataone_def_specification",
  "dataone_def_nhtsa_recall",
  "dataone_lkp_veh_model_number",
  "dataone_veh_trim_styles",
  "dataone_lkp_veh_nhtsa_recall",
  "dataone_lkp_ymm_maintenance",
  "dataone_lkp_ymm_maintenance_interval",
  "dataone_lkp_ymm_maintenance_event_computer_code",
  "dataone_vin_reference",
  "dataone_lkp_veh_standard_specification",
  "dataone_lkp_vin_maintenance",
  "dataone_lkp_vin_maintenance_interval",
  "dataone_lkp_vin_maintenance_event_computer_code",
  "dataone_sync_metadata",
];

async function getRowCount(url: string, table: string): Promise<number> {
  const sql = postgres(url, { max: 1 });
  try {
    const result = await sql.unsafe(`SELECT COUNT(*)::int as c FROM ${table}`);
    return result[0].c;
  } finally {
    await sql.end();
  }
}

async function migrateTable(table: string): Promise<void> {
  console.log(`\n  Migrating ${table}...`);

  const destCount = await getRowCount(SUPABASE_URL, table).catch(() => 0);
  if (destCount > 0) {
    const srcCount = await getRowCount(SOURCE_URL, table);
    if (destCount >= srcCount) {
      console.log(`  SKIP: ${table} already has ${destCount.toLocaleString()} rows`);
      return;
    }
    console.log(`  Truncating ${table} (has ${destCount} rows, source has ${srcCount} rows)...`);
    const destSql = postgres(SUPABASE_URL, { max: 1 });
    await destSql.unsafe(`TRUNCATE ${table} RESTART IDENTITY CASCADE`);
    await destSql.end();
  }

  const result = spawnSync(
    "bash",
    ["-c", `pg_dump "${SOURCE_URL}" --no-owner --no-acl --data-only -t ${table} | psql "${SUPABASE_URL}"`],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }
  );

  const stderr = result.stderr?.toString() || "";
  if (result.status !== 0 && !stderr.includes("NOTICE") && !stderr.includes("WARNING")) {
    throw new Error(`Failed: ${stderr}`);
  }

  const finalCount = await getRowCount(SUPABASE_URL, table);
  console.log(`  Done: ${finalCount.toLocaleString()} rows`);
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   DataOne → Supabase Migration                          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`Started: ${new Date().toISOString()}`);

  for (const table of TABLES) {
    try {
      await migrateTable(table);
    } catch (err: any) {
      console.error(`  ERROR on ${table}: ${err.message}`);
    }
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║   Migration Complete                                     ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`Finished: ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
