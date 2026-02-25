#!/usr/bin/env npx tsx
import { execSync, spawn } from "child_process";
import path from "path";
import fs from "fs";
import postgres from "postgres";
import {
  captureTableCounts,
  calculateTableStats,
  saveSyncReport,
  sendSyncReportToAdmins,
  SyncReport,
} from "../lib/integrations/dataone-sync-report";

const WORK_DIR = ".dataone";
const EXTRACT_DIR = path.join(WORK_DIR, "extracted");

const CORE_TABLES_PSQL = [
  { csv: "VIN_REFERENCE.csv", table: "dataone_vin_reference", columns: "vin_id,vehicle_id,vin_pattern,year,make,model,trim,style,mfr_model_num,mfr_package_code,doors,drive_type,vehicle_type,rear_axle,body_type,body_subtype,bed_length,engine_id,engine_name,engine_size,engine_block,engine_cylinders,engine_valves,engine_induction,engine_aspiration,engine_cam_type,fuel_type,trans_id,trans_name,trans_type,trans_speeds,wheelbase,gross_vehicle_weight_range,restraint_type,brake_system,country_of_mfr,plant" },
  { csv: "DEF_MAINTENANCE.csv", table: "dataone_def_maintenance", columns: "maintenance_id,maintenance_category,maintenance_name,maintenance_notes" },
  { csv: "DEF_MAINTENANCE_INTERVAL.csv", table: "dataone_def_maintenance_interval", columns: "maintenance_interval_id,interval_type,value,units,initial_value" },
  { csv: "DEF_MAINTENANCE_SCHEDULE.csv", table: "dataone_def_maintenance_schedule", columns: "maintenance_schedule_id,schedule_name,schedule_description" },
  { csv: "DEF_MAINTENANCE_OPERATING_PARAMETER.csv", table: "dataone_def_maintenance_operating_parameter", columns: "maintenance_operating_parameter_id,operating_parameter,operating_parameter_notes" },
  { csv: "DEF_MAINTENANCE_COMPUTER_CODE.csv", table: "dataone_def_maintenance_computer_code", columns: "maintenance_computer_code_id,computer_code" },
  { csv: "DEF_MAINTENANCE_EVENT.csv", table: "dataone_def_maintenance_event", columns: "maintenance_event_id,event" },
  { csv: "VEH_TRIM_STYLES.csv", table: "dataone_veh_trim_styles", columns: "vehicle_id,style_complete,fleet,year,make,model,trim,drive_type,style,vehicle_type,body_type,body_subtype,oem_body_style,doors,oem_doors,mfr_model_num,mfr_package_code" },
  { csv: "DEF_SPECIFICATION.csv", table: "dataone_def_specification", columns: "specification_id,specification_category,specification_name,specification_value,is_ancillary" },
  { csv: "DEF_NHTSA_RECALL.csv", table: "dataone_def_nhtsa_recall", columns: "nhtsa_recall_id,nhtsa_campaign_number,mfr_campaign_number,component_description,report_manufacturer,manufacturing_start_date,manufacturing_end_date,recall_type_code,potential_units_affected,owner_notification_date,recall_initiator,product_manufacturer,report_received_date,record_creation_date,regulation_part_number,fmvvs_number,defect_summary,consequence_summary,corrective_action_summary,notes,recalled_component_id" },
];

const LARGE_TABLES_STREAM = [
  "LKP_VIN_MAINTENANCE",
  "LKP_VIN_MAINTENANCE_INTERVAL",
  "LKP_VEH_NHTSA_RECALL",
  "LKP_VEH_MODEL_NUMBER",
  "LKP_VEH_STANDARD_SPECIFICATION",
];

async function downloadSftp(): Promise<{ fileName: string; fileSizeMb: number }> {
  console.log("\n[1/5] Downloading from SFTP...");
  
  const { DATAONE_SFTP_HOST, DATAONE_SFTP_USER, DATAONE_SFTP_PASS, DATAONE_SFTP_PORT } = process.env;
  if (!DATAONE_SFTP_HOST || !DATAONE_SFTP_USER || !DATAONE_SFTP_PASS) {
    throw new Error("Missing SFTP credentials (DATAONE_SFTP_HOST, DATAONE_SFTP_USER, DATAONE_SFTP_PASS)");
  }
  
  fs.mkdirSync(WORK_DIR, { recursive: true });
  
  const port = DATAONE_SFTP_PORT || "22";
  const zipPath = path.join(WORK_DIR, "dataone_latest.zip");
  
  const sftpCommands = `
cd /
ls -la
get *.zip ${zipPath}
bye
`;
  
  const sftpProcess = spawn("sshpass", [
    "-p", DATAONE_SFTP_PASS,
    "sftp", "-o", "StrictHostKeyChecking=no",
    "-P", port,
    `${DATAONE_SFTP_USER}@${DATAONE_SFTP_HOST}`
  ], { stdio: ["pipe", "pipe", "pipe"] });
  
  return new Promise((resolve, reject) => {
    let output = "";
    sftpProcess.stdout.on("data", (data) => { output += data.toString(); });
    sftpProcess.stderr.on("data", (data) => { output += data.toString(); });
    
    sftpProcess.on("close", (code) => {
      if (code !== 0 && !fs.existsSync(zipPath)) {
        reject(new Error(`SFTP failed: ${output}`));
        return;
      }
      
      const stats = fs.statSync(zipPath);
      const fileSizeMb = stats.size / (1024 * 1024);
      console.log(`  Downloaded: ${fileSizeMb.toFixed(1)} MB`);
      
      resolve({ fileName: "dataone_latest.zip", fileSizeMb });
    });
    
    sftpProcess.stdin.write(sftpCommands);
    sftpProcess.stdin.end();
  });
}

async function extractZip(): Promise<void> {
  console.log("\n[2/5] Extracting ZIP...");
  
  const zipPath = path.join(WORK_DIR, "dataone_latest.zip");
  fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  
  execSync(`unzip -o "${zipPath}" -d "${EXTRACT_DIR}"`, { stdio: "inherit" });
  
  const files = fs.readdirSync(EXTRACT_DIR);
  console.log(`  Extracted ${files.length} files`);
}

async function importCoreTables(sql: postgres.Sql): Promise<void> {
  console.log("\n[3/5] Importing core tables (PSQL COPY)...");
  
  for (const { csv, table, columns } of CORE_TABLES_PSQL) {
    const csvPath = path.join(EXTRACT_DIR, csv);
    if (!fs.existsSync(csvPath)) {
      console.log(`  Skipping ${csv} (not found)`);
      continue;
    }
    
    try {
      await sql.unsafe(`TRUNCATE ${table} RESTART IDENTITY`);
      
      const copyCmd = `\\COPY ${table}(${columns}) FROM '${csvPath}' WITH (FORMAT csv, HEADER true, QUOTE '"', NULL '')`;
      const tmpSqlFile = path.join(WORK_DIR, `_copy_${table}.sql`);
      fs.writeFileSync(tmpSqlFile, copyCmd);
      const dbUrl = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL!;
      execSync(
        `psql "${dbUrl}" -f "${tmpSqlFile}"`,
        { stdio: "pipe" }
      );
      
      const result = await sql.unsafe(`SELECT COUNT(*)::int as c FROM ${table}`);
      console.log(`  ${table}: ${result[0].c.toLocaleString()} rows`);
    } catch (err: any) {
      console.error(`  Error importing ${table}: ${err.message}`);
      
      if (err.message.includes("not-null constraint") || err.message.includes("violates not-null")) {
        console.log(`  Retrying ${table} via stream import to handle NULLs...`);
        try {
          execSync(`npx tsx scripts/dataone-stream-import.ts ${csv.replace('.csv', '')}`, {
            stdio: "inherit",
            timeout: 300000
          });
        } catch (retryErr: any) {
          console.error(`  Stream retry also failed for ${table}: ${retryErr.message}`);
        }
      }
    }
  }
}

async function importLargeTables(): Promise<void> {
  console.log("\n[4/5] Importing large tables (streaming)...");
  
  for (const table of LARGE_TABLES_STREAM) {
    const csvPath = path.join(EXTRACT_DIR, `${table}.csv`);
    if (!fs.existsSync(csvPath)) {
      console.log(`  Skipping ${table} (not found)`);
      continue;
    }
    
    try {
      execSync(`npx tsx scripts/dataone-stream-import.ts ${table} --force`, { 
        stdio: "inherit",
        timeout: 600000
      });
    } catch (err: any) {
      console.error(`  Error streaming ${table}: ${err.message}`);
    }
  }
}

async function createSyncMetadataRecord(sql: postgres.Sql, fileName: string, fileSizeMb: number): Promise<number> {
  const result = await sql`
    INSERT INTO dataone_sync_metadata (last_sync_at, sync_status, file_name, file_size_bytes)
    VALUES (NOW(), 'in_progress', ${fileName}, ${Math.round(fileSizeMb * 1024 * 1024)})
    RETURNING id
  `;
  return result[0].id;
}

async function main() {
  const startTime = Date.now();
  const connStr = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL!;
  const sql = postgres(connStr);
  
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║   DataOne Weekly Sync                                      ║");
  console.log("║   Downloads SFTP → Imports to PostgreSQL → Emails Report   ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nStarted: ${new Date().toISOString()}`);
  
  let syncId = 0;
  let beforeCounts: Record<string, number> = {};
  let afterCounts: Record<string, number> = {};
  let fileName = "";
  let fileSizeMb = 0;
  let error: string | undefined;
  
  try {
    beforeCounts = await captureTableCounts();
    console.log(`\nCaptured before counts (${Object.values(beforeCounts).reduce((a, b) => a + b, 0).toLocaleString()} total rows)`);
    
    const download = await downloadSftp();
    fileName = download.fileName;
    fileSizeMb = download.fileSizeMb;
    
    syncId = await createSyncMetadataRecord(sql, fileName, fileSizeMb);
    
    await extractZip();
    await importCoreTables(sql);
    await importLargeTables();
    
    afterCounts = await captureTableCounts();
    console.log(`\nCaptured after counts (${Object.values(afterCounts).reduce((a, b) => a + b, 0).toLocaleString()} total rows)`);
    
  } catch (err: any) {
    error = err.message;
    console.error("\n[ERROR]", error);
    afterCounts = await captureTableCounts();
  }
  
  const endTime = Date.now();
  const durationSeconds = Math.round((endTime - startTime) / 1000);
  const tableStats = calculateTableStats(beforeCounts, afterCounts);
  
  const report: SyncReport = {
    sync_id: syncId,
    started_at: new Date(startTime),
    completed_at: new Date(endTime),
    duration_seconds: durationSeconds,
    file_name: fileName,
    file_size_mb: fileSizeMb,
    table_stats: tableStats,
    total_rows_before: Object.values(beforeCounts).reduce((a, b) => a + b, 0),
    total_rows_after: Object.values(afterCounts).reduce((a, b) => a + b, 0),
    has_changes: tableStats.some(t => t.net_change !== 0),
    error,
  };
  
  if (syncId > 0) {
    await saveSyncReport(report);
  }
  
  console.log("\n[5/5] Sending report to platform admins...");
  const { sent, emails } = await sendSyncReportToAdmins(report);
  console.log(`  Sent to ${sent} admin(s): ${emails.join(", ")}`);
  
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║   Sync Complete                                            ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`Duration: ${Math.round(durationSeconds / 60)} minutes`);
  console.log(`Total rows: ${report.total_rows_after.toLocaleString()}`);
  
  const changedTables = tableStats.filter(t => t.net_change !== 0);
  if (changedTables.length > 0) {
    console.log(`\nChanges detected in ${changedTables.length} tables:`);
    changedTables.forEach(t => {
      const sign = t.net_change > 0 ? "+" : "";
      console.log(`  ${t.table_name}: ${sign}${t.net_change.toLocaleString()}`);
    });
  } else {
    console.log("\nNo changes detected - data is up to date.");
  }
  
  await sql.end();
  process.exit(error ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
