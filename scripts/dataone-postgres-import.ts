import path from "path";
import fs from "fs";
import { pipeline } from "stream/promises";
import SFTPClient from "ssh2-sftp-client";
import unzipper from "unzipper";
import { parse as csvParse } from "csv-parse/sync";
import postgres from "postgres";

const {
  DATAONE_SFTP_HOST,
  DATAONE_SFTP_PORT = "2222",
  DATAONE_SFTP_USER,
  DATAONE_SFTP_PASS,
  DATABASE_URL,
} = process.env;

const WORK_DIR = ".dataone";
const ZIP_FILE = "DataOne_US_LDV_Data.zip";
const BATCH_SIZE = 5000;

const TABLE_MAPPINGS: Record<string, { table: string; columns: string[] }> = {
  "VIN_REFERENCE": {
    table: "dataone_vin_reference",
    columns: ["vin_id", "vehicle_id", "vin_pattern", "year", "make", "model", "trim", "style", 
      "mfr_model_num", "mfr_package_code", "doors", "drive_type", "vehicle_type", "rear_axle", 
      "body_type", "body_subtype", "bed_length", "engine_id", "engine_name", "engine_size", 
      "engine_block", "engine_cylinders", "engine_valves", "engine_induction", "engine_aspiration", 
      "engine_cam_type", "fuel_type", "trans_id", "trans_name", "trans_type", "trans_speeds", 
      "wheelbase", "gross_vehicle_weight_range", "restraint_type", "brake_system", "country_of_mfr", "plant"]
  },
  "VEH_TRIM_STYLES": {
    table: "dataone_veh_trim_styles",
    columns: ["vehicle_id", "style_complete", "fleet", "year", "make", "model", "trim", 
      "drive_type", "style", "vehicle_type", "body_type", "body_subtype", "oem_body_style", 
      "doors", "oem_doors", "mfr_model_num", "mfr_package_code"]
  },
  "DEF_MAINTENANCE": {
    table: "dataone_def_maintenance",
    columns: ["maintenance_id", "maintenance_category", "maintenance_name", "maintenance_notes"]
  },
  "DEF_MAINTENANCE_SCHEDULE": {
    table: "dataone_def_maintenance_schedule",
    columns: ["maintenance_schedule_id", "schedule_name", "schedule_description"]
  },
  "DEF_MAINTENANCE_INTERVAL": {
    table: "dataone_def_maintenance_interval",
    columns: ["maintenance_interval_id", "interval_type", "value", "units", "initial_value"]
  },
  "DEF_MAINTENANCE_OPERATING_PARAMETER": {
    table: "dataone_def_maintenance_operating_parameter",
    columns: ["maintenance_operating_parameter_id", "operating_parameter", "operating_parameter_notes"]
  },
  "DEF_MAINTENANCE_COMPUTER_CODE": {
    table: "dataone_def_maintenance_computer_code",
    columns: ["maintenance_computer_code_id", "computer_code"]
  },
  "DEF_MAINTENANCE_EVENT": {
    table: "dataone_def_maintenance_event",
    columns: ["maintenance_event_id", "event"]
  },
  "LKP_VIN_MAINTENANCE": {
    table: "dataone_lkp_vin_maintenance",
    columns: ["vin_maintenance_id", "squish", "trans_notes", "trim_notes", "maintenance_schedule_id", "maintenance_id"]
  },
  "LKP_VIN_MAINTENANCE_INTERVAL": {
    table: "dataone_lkp_vin_maintenance_interval",
    columns: ["vin_maintenance_interval_id", "vin_maintenance_id", "maintenance_interval_id", "maintenance_operating_parameter_id"]
  },
  "LKP_VIN_MAINTENANCE_EVENT_COMPUTER_CODE": {
    table: "dataone_lkp_vin_maintenance_event_computer_code",
    columns: ["vin_maintenance_event_computer_code_id", "maintenance_computer_code_id", "maintenance_event_id", "vin_maintenance_id"]
  },
  "LKP_YMM_MAINTENANCE": {
    table: "dataone_lkp_ymm_maintenance",
    columns: ["ymm_maintenance_id", "year", "make", "model", "eng_notes", "trans_notes", "trim_notes", "maintenance_schedule_id", "maintenance_id"]
  },
  "LKP_YMM_MAINTENANCE_INTERVAL": {
    table: "dataone_lkp_ymm_maintenance_interval",
    columns: ["ymm_maintenance_interval_id", "ymm_maintenance_id", "maintenance_interval_id", "maintenance_operating_parameter_id"]
  },
  "LKP_YMM_MAINTENANCE_EVENT_COMPUTER_CODE": {
    table: "dataone_lkp_ymm_maintenance_event_computer_code",
    columns: ["ymm_maintenance_event_computer_code_id", "maintenance_computer_code_id", "maintenance_event_id", "ymm_maintenance_id"]
  },
  "DEF_NHTSA_RECALL": {
    table: "dataone_def_nhtsa_recall",
    columns: ["nhtsa_recall_id", "nhtsa_campaign_number", "mfr_campaign_number", "component_description", 
      "report_manufacturer", "manufacturing_start_date", "manufacturing_end_date", "recall_type_code", 
      "potential_units_affected", "owner_notification_date", "recall_initiator", "product_manufacturer", 
      "report_received_date", "record_creation_date", "regulation_part_number", "fmvvs_number", 
      "defect_summary", "consequence_summary", "corrective_action_summary", "notes", "recalled_component_id"]
  },
  "LKP_VEH_NHTSA_RECALL": {
    table: "dataone_lkp_veh_nhtsa_recall",
    columns: ["veh_nhtsa_recall_id", "vehicle_id", "nhtsa_recall_id"]
  },
  "LKP_VEH_MODEL_NUMBER": {
    table: "dataone_lkp_veh_model_number",
    columns: ["veh_mfr_model_num_id", "vehicle_id", "mfr_model_num"]
  },
  "DEF_SPECIFICATION": {
    table: "dataone_def_specification",
    columns: ["specification_id", "specification_category", "specification_name", "specification_value", "is_ancillary"]
  },
  "LKP_VEH_STANDARD_SPECIFICATION": {
    table: "dataone_lkp_veh_standard_specification",
    columns: ["veh_specification_id", "vehicle_id", "specification_id"]
  }
};

async function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function downloadDataOneFiles(): Promise<{ zipPath: string; fileSize: number }> {
  console.log("=== DOWNLOADING DATAONE FILES ===\n");
  
  const sftp = new SFTPClient();
  await sftp.connect({
    host: DATAONE_SFTP_HOST!,
    port: Number(DATAONE_SFTP_PORT),
    username: DATAONE_SFTP_USER!,
    password: DATAONE_SFTP_PASS!,
  });
  
  console.log("✓ Connected to SFTP");
  
  await ensureDir(WORK_DIR);
  const zipPath = path.join(WORK_DIR, ZIP_FILE);
  
  const files = await sftp.list("/");
  const zipInfo = files.find(f => f.name === ZIP_FILE);
  
  if (!zipInfo) {
    throw new Error(`${ZIP_FILE} not found on SFTP server`);
  }
  
  const sizeMB = (zipInfo.size / 1024 / 1024).toFixed(1);
  console.log(`Downloading ${ZIP_FILE} (${sizeMB} MB)...`);
  
  await sftp.fastGet(`/${ZIP_FILE}`, zipPath);
  console.log("✓ Download complete");
  
  await sftp.end();
  
  return { zipPath, fileSize: zipInfo.size };
}

async function extractZip(zipPath: string): Promise<string> {
  console.log("\n=== EXTRACTING ZIP ===\n");
  
  const extractDir = path.join(WORK_DIR, "extracted");
  
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true });
  }
  fs.mkdirSync(extractDir, { recursive: true });
  
  await pipeline(
    fs.createReadStream(zipPath),
    unzipper.Extract({ path: extractDir })
  );
  
  console.log("✓ Extraction complete");
  
  return extractDir;
}

function findCsvFiles(dir: string): string[] {
  const files: string[] = [];
  
  function walk(d: string) {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.toLowerCase().endsWith(".csv")) {
        files.push(fullPath);
      }
    }
  }
  
  walk(dir);
  return files;
}

function normalizeHeader(h: string): string {
  return h.replace(/\uFEFF/g, "").replace(/^"+|"+$/g, "").trim().toLowerCase();
}

function parseValue(value: string, _column: string): any {
  if (value === "" || value === null || value === undefined) {
    return null;
  }
  
  const cleaned = String(value).replace(/\uFEFF/g, "").replace(/^"+|"+$/g, "").trim();
  
  if (cleaned === "" || cleaned === "NULL") {
    return null;
  }
  
  if (/^-?\d+$/.test(cleaned)) {
    const num = parseInt(cleaned, 10);
    if (!isNaN(num) && Math.abs(num) <= Number.MAX_SAFE_INTEGER) {
      return num;
    }
  }
  
  if (/^-?\d+\.\d+$/.test(cleaned)) {
    const num = parseFloat(cleaned);
    if (!isNaN(num)) {
      return num;
    }
  }
  
  if (cleaned === "0000-00-00") {
    return null;
  }
  
  return cleaned;
}

function repairWeirdQuotes(txt: string): string {
  return txt.replace(/"([A-Za-z])(?=(,|\r?\n))/g, '"');
}

async function loadCsvFile(csvPath: string): Promise<Record<string, string>[]> {
  const content = fs.readFileSync(csvPath, "utf-8");
  const repaired = repairWeirdQuotes(content);
  
  const parseOpts = {
    columns: (header: string[]) => header.map(normalizeHeader),
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    bom: true,
    skip_records_with_error: true,
  };
  
  try {
    return csvParse(repaired, parseOpts);
  } catch (e: any) {
    console.warn(`    CSV parse error, trying with quote:false...`);
    return csvParse(repaired, { ...parseOpts, quote: false });
  }
}

async function importCsvToPostgres(
  csvPath: string,
  sql: postgres.Sql,
  useStagingTables: boolean = false
): Promise<{ table: string; rows: number } | null> {
  const fileName = path.basename(csvPath, ".csv").toUpperCase();
  const mapping = TABLE_MAPPINGS[fileName];
  
  if (!mapping) {
    console.log(`  ⚠ Skipping ${fileName} (no mapping defined)`);
    return null;
  }
  
  const targetTable = useStagingTables ? `${mapping.table}_staging` : mapping.table;
  
  console.log(`  Importing ${fileName} → ${targetTable}...`);
  
  await sql.unsafe(`TRUNCATE TABLE ${targetTable} RESTART IDENTITY CASCADE`);
  
  const rows = await loadCsvFile(csvPath);
  console.log(`    Parsed ${rows.length.toLocaleString()} rows from CSV`);
  
  let totalRows = 0;
  
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batchRows = rows.slice(i, i + BATCH_SIZE);
    
    const normalizedBatch = batchRows.map(row => {
      const normalizedRow: Record<string, any> = {};
      for (const col of mapping.columns) {
        const value = row[col] ?? row[col.toLowerCase()] ?? "";
        normalizedRow[col] = parseValue(value, col);
      }
      return normalizedRow;
    });
    
    const count = await insertBatch(sql, targetTable, mapping.columns, normalizedBatch);
    totalRows += count;
    
    if (totalRows % 100000 === 0 || i + BATCH_SIZE >= rows.length) {
      process.stdout.write(`    ${(totalRows / 1000).toFixed(0)}k rows...\r`);
    }
  }
  
  console.log(`    ✓ ${totalRows.toLocaleString()} rows imported`);
  return { table: mapping.table, rows: totalRows };
}

async function insertBatch(
  sql: postgres.Sql,
  table: string,
  columns: string[],
  rows: Record<string, any>[]
): Promise<number> {
  if (rows.length === 0) return 0;
  
  const values = rows.map(row => 
    `(${columns.map(col => {
      const val = row[col];
      if (val === null || val === undefined) return "NULL";
      if (typeof val === "number") return val;
      return `'${String(val).replace(/'/g, "''")}'`;
    }).join(", ")})`
  ).join(",\n");
  
  const query = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values} ON CONFLICT DO NOTHING`;
  
  try {
    await sql.unsafe(query);
    return rows.length;
  } catch (err: any) {
    console.error(`Error inserting into ${table}:`, err.message);
    console.error("First row:", rows[0]);
    throw err;
  }
}

async function createStagingTables(sql: postgres.Sql): Promise<void> {
  console.log("\n=== CREATING STAGING TABLES ===\n");
  
  for (const [_, mapping] of Object.entries(TABLE_MAPPINGS)) {
    const stagingTable = `${mapping.table}_staging`;
    await sql.unsafe(`DROP TABLE IF EXISTS ${stagingTable}`);
    await sql.unsafe(`CREATE TABLE ${stagingTable} (LIKE ${mapping.table} INCLUDING ALL)`);
    console.log(`  Created ${stagingTable}`);
  }
}

async function swapStagingToLive(sql: postgres.Sql): Promise<void> {
  console.log("\n=== ATOMIC TABLE SWAP ===\n");
  
  for (const [_, mapping] of Object.entries(TABLE_MAPPINGS)) {
    const liveTable = mapping.table;
    const stagingTable = `${mapping.table}_staging`;
    const oldTable = `${mapping.table}_old`;
    
    await sql.begin(async (tx) => {
      await tx.unsafe(`DROP TABLE IF EXISTS ${oldTable}`);
      await tx.unsafe(`ALTER TABLE ${liveTable} RENAME TO ${oldTable.split('.').pop()}`);
      await tx.unsafe(`ALTER TABLE ${stagingTable} RENAME TO ${liveTable.split('.').pop()}`);
      await tx.unsafe(`DROP TABLE ${oldTable}`);
    });
    
    console.log(`  ✓ Swapped ${stagingTable} → ${liveTable}`);
  }
}

async function recordSyncMetadata(
  sql: postgres.Sql,
  status: string,
  fileSize: number,
  rowsImported: Record<string, number>,
  durationSeconds: number,
  errorMessage?: string
): Promise<void> {
  await sql`
    INSERT INTO dataone_sync_metadata (
      last_sync_at, sync_status, file_name, file_size_bytes, 
      rows_imported, duration_seconds, error_message
    ) VALUES (
      NOW(), ${status}, ${ZIP_FILE}, ${fileSize},
      ${sql.json(rowsImported)}, ${durationSeconds}, ${errorMessage || null}
    )
  `;
}

async function main() {
  const startTime = Date.now();
  let fileSize = 0;
  const rowsImported: Record<string, number> = {};
  
  console.log("╔════════════════════════════════════════════╗");
  console.log("║   DataOne PostgreSQL Import                ║");
  console.log("╚════════════════════════════════════════════╝\n");
  
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL not set");
  }
  
  if (!DATAONE_SFTP_HOST || !DATAONE_SFTP_USER || !DATAONE_SFTP_PASS) {
    throw new Error("DataOne SFTP credentials not set");
  }
  
  const sql = postgres(DATABASE_URL);
  
  try {
    const { zipPath, fileSize: size } = await downloadDataOneFiles();
    fileSize = size;
    
    const extractDir = await extractZip(zipPath);
    
    const csvFiles = findCsvFiles(extractDir);
    console.log(`\nFound ${csvFiles.length} CSV files\n`);
    
    console.log("=== IMPORTING TO POSTGRESQL ===\n");
    
    const importOrder = [
      "DEF_MAINTENANCE",
      "DEF_MAINTENANCE_SCHEDULE",
      "DEF_MAINTENANCE_INTERVAL",
      "DEF_MAINTENANCE_OPERATING_PARAMETER",
      "DEF_MAINTENANCE_COMPUTER_CODE",
      "DEF_MAINTENANCE_EVENT",
      "DEF_SPECIFICATION",
      "DEF_NHTSA_RECALL",
      "VEH_TRIM_STYLES",
      "VIN_REFERENCE",
      "LKP_VEH_MODEL_NUMBER",
      "LKP_VIN_MAINTENANCE",
      "LKP_VIN_MAINTENANCE_INTERVAL",
      "LKP_VIN_MAINTENANCE_EVENT_COMPUTER_CODE",
      "LKP_YMM_MAINTENANCE",
      "LKP_YMM_MAINTENANCE_INTERVAL",
      "LKP_YMM_MAINTENANCE_EVENT_COMPUTER_CODE",
      "LKP_VEH_NHTSA_RECALL",
      "LKP_VEH_STANDARD_SPECIFICATION"
    ];
    
    for (const tableName of importOrder) {
      const csvFile = csvFiles.find((f: string) => 
        path.basename(f, ".csv").toUpperCase() === tableName
      );
      
      if (csvFile) {
        const result = await importCsvToPostgres(csvFile, sql, false);
        if (result) {
          rowsImported[result.table] = result.rows;
        }
      } else {
        console.log(`  ⚠ ${tableName}.csv not found in ZIP`);
      }
    }
    
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    await recordSyncMetadata(sql, "success", fileSize, rowsImported, durationSeconds);
    
    console.log("\n╔════════════════════════════════════════════╗");
    console.log("║   IMPORT COMPLETE                          ║");
    console.log("╚════════════════════════════════════════════╝");
    console.log(`\nDuration: ${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s`);
    console.log(`Total rows: ${Object.values(rowsImported).reduce((a, b) => a + b, 0).toLocaleString()}`);
    
  } catch (err: any) {
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    await recordSyncMetadata(sql, "error", fileSize, rowsImported, durationSeconds, err.message);
    throw err;
  } finally {
    await sql.end();
  }
}

main().catch(err => {
  console.error("\n❌ Import failed:", err.message);
  process.exit(1);
});
