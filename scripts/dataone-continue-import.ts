import path from "path";
import fs from "fs";
import { parse as csvParse } from "csv-parse/sync";
import postgres from "postgres";

const { DATABASE_URL } = process.env;
const WORK_DIR = ".dataone/extracted";
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
  "LKP_VEH_NHTSA_RECALL": {
    table: "dataone_lkp_veh_nhtsa_recall",
    columns: ["veh_nhtsa_recall_id", "vehicle_id", "nhtsa_recall_id"]
  },
  "LKP_VEH_MODEL_NUMBER": {
    table: "dataone_lkp_veh_model_number",
    columns: ["veh_mfr_model_num_id", "vehicle_id", "mfr_model_num"]
  },
  "LKP_VEH_STANDARD_SPECIFICATION": {
    table: "dataone_lkp_veh_standard_specification",
    columns: ["veh_specification_id", "vehicle_id", "specification_id"]
  },
  "DEF_NHTSA_RECALL": {
    table: "dataone_def_nhtsa_recall",
    columns: ["nhtsa_recall_id", "nhtsa_campaign_number", "mfr_campaign_number", "component_description", 
      "report_manufacturer", "manufacturing_start_date", "manufacturing_end_date", "recall_type_code", 
      "potential_units_affected", "owner_notification_date", "recall_initiator", "product_manufacturer", 
      "report_received_date", "record_creation_date", "regulation_part_number", "fmvvs_number", 
      "defect_summary", "consequence_summary", "corrective_action_summary", "notes", "recalled_component_id"]
  },
};

function normalizeHeader(h: string): string {
  return h.replace(/\uFEFF/g, "").replace(/^"+|"+$/g, "").trim().toLowerCase();
}

function parseValue(value: string): any {
  if (value === "" || value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\uFEFF/g, "").replace(/^"+|"+$/g, "").trim();
  if (cleaned === "" || cleaned === "NULL") return null;
  if (/^-?\d+$/.test(cleaned)) {
    const num = parseInt(cleaned, 10);
    if (!isNaN(num) && Math.abs(num) <= Number.MAX_SAFE_INTEGER) return num;
  }
  if (/^-?\d+\.\d+$/.test(cleaned)) {
    const num = parseFloat(cleaned);
    if (!isNaN(num)) return num;
  }
  if (cleaned === "0000-00-00") return null;
  return cleaned;
}

function repairWeirdQuotes(txt: string): string {
  return txt.replace(/"([A-Za-z])(?=(,|\r?\n))/g, '"');
}

async function loadCsvFile(csvPath: string): Promise<Record<string, string>[]> {
  console.log(`  Reading ${path.basename(csvPath)}...`);
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
  } catch {
    console.log(`  Retrying with quote:false...`);
    return csvParse(repaired, { ...parseOpts, quote: false });
  }
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
  await sql.unsafe(query);
  return rows.length;
}

async function importTable(sql: postgres.Sql, tableName: string): Promise<number> {
  const mapping = TABLE_MAPPINGS[tableName];
  if (!mapping) {
    console.log(`  No mapping for ${tableName}`);
    return 0;
  }
  
  const csvPath = path.join(WORK_DIR, `${tableName}.csv`);
  if (!fs.existsSync(csvPath)) {
    console.log(`  ${tableName}.csv not found`);
    return 0;
  }
  
  const existingCount = await sql.unsafe(`SELECT COUNT(*) as count FROM ${mapping.table}`);
  if (existingCount[0].count > 0) {
    console.log(`  ${mapping.table} already has ${existingCount[0].count} rows, skipping`);
    return existingCount[0].count;
  }
  
  console.log(`  Loading ${tableName}...`);
  const rows = await loadCsvFile(csvPath);
  console.log(`  Parsed ${rows.length.toLocaleString()} rows`);
  
  let totalRows = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batchRows = rows.slice(i, i + BATCH_SIZE);
    const normalizedBatch = batchRows.map(row => {
      const normalizedRow: Record<string, any> = {};
      for (const col of mapping.columns) {
        const value = row[col] ?? row[col.toLowerCase()] ?? "";
        normalizedRow[col] = parseValue(value);
      }
      return normalizedRow;
    });
    
    const count = await insertBatch(sql, mapping.table, mapping.columns, normalizedBatch);
    totalRows += count;
    
    if (totalRows % 50000 === 0) {
      process.stdout.write(`  ${(totalRows / 1000).toFixed(0)}k rows...\r`);
    }
  }
  
  console.log(`  ✓ ${totalRows.toLocaleString()} rows imported to ${mapping.table}`);
  return totalRows;
}

async function main() {
  const targetTable = process.argv[2];
  
  if (!DATABASE_URL) throw new Error("DATABASE_URL not set");
  
  const sql = postgres(DATABASE_URL);
  
  console.log("╔════════════════════════════════════════════╗");
  console.log("║   DataOne Continue Import                  ║");
  console.log("╚════════════════════════════════════════════╝\n");
  
  if (targetTable) {
    await importTable(sql, targetTable.toUpperCase());
  } else {
    const tables = Object.keys(TABLE_MAPPINGS);
    for (const table of tables) {
      await importTable(sql, table);
    }
  }
  
  console.log("\n=== SUMMARY ===");
  const counts = await sql`
    SELECT 'dataone_vin_reference' as t, COUNT(*) as c FROM dataone_vin_reference
    UNION ALL SELECT 'dataone_lkp_vin_maintenance', COUNT(*) FROM dataone_lkp_vin_maintenance
    UNION ALL SELECT 'dataone_lkp_vin_maintenance_interval', COUNT(*) FROM dataone_lkp_vin_maintenance_interval
    UNION ALL SELECT 'dataone_def_maintenance', COUNT(*) FROM dataone_def_maintenance
    ORDER BY t
  `;
  
  for (const row of counts) {
    console.log(`  ${row.t}: ${Number(row.c).toLocaleString()}`);
  }
  
  await sql.end();
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
