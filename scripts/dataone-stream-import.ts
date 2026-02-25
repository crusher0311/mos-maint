import path from "path";
import fs from "fs";
import readline from "readline";
import postgres from "postgres";

const DATABASE_URL = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL;
const WORK_DIR = ".dataone/extracted";
const BATCH_SIZE = 2000;

const TABLE_MAPPINGS: Record<string, { table: string; columns: string[] }> = {
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

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  
  return result;
}

async function insertBatch(
  sql: postgres.Sql,
  table: string,
  columns: string[],
  rows: any[][]
): Promise<number> {
  if (rows.length === 0) return 0;
  
  const values = rows.map(row => 
    `(${row.map(val => {
      if (val === null || val === undefined) return "NULL";
      if (typeof val === "number") return val;
      return `'${String(val).replace(/'/g, "''")}'`;
    }).join(", ")})`
  ).join(",\n");
  
  const query = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values} ON CONFLICT DO NOTHING`;
  await sql.unsafe(query);
  return rows.length;
}

async function streamImportTable(sql: postgres.Sql, tableName: string): Promise<number> {
  const mapping = TABLE_MAPPINGS[tableName];
  if (!mapping) {
    console.log(`No mapping for ${tableName}`);
    return 0;
  }
  
  const csvPath = path.join(WORK_DIR, `${tableName}.csv`);
  if (!fs.existsSync(csvPath)) {
    console.log(`${tableName}.csv not found`);
    return 0;
  }
  
  const forceReimport = process.argv.includes("--force");
  const existingCount = await sql.unsafe(`SELECT COUNT(*) as count FROM ${mapping.table}`);
  if (existingCount[0].count > 0 && !forceReimport) {
    console.log(`${mapping.table} already has ${existingCount[0].count} rows, skipping (use --force to reimport)`);
    return existingCount[0].count;
  }
  if (existingCount[0].count > 0 && forceReimport) {
    console.log(`${mapping.table} has ${existingCount[0].count} rows, truncating for reimport...`);
    await sql.unsafe(`TRUNCATE ${mapping.table} RESTART IDENTITY`);
  }
  
  console.log(`Streaming ${tableName} to ${mapping.table}...`);
  
  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath),
    crlfDelay: Infinity
  });
  
  let headers: string[] = [];
  let batch: any[][] = [];
  let totalRows = 0;
  let lineNum = 0;
  
  for await (const line of rl) {
    lineNum++;
    
    if (lineNum === 1) {
      headers = parseCSVLine(line).map(h => 
        h.replace(/\uFEFF/g, "").replace(/^"+|"+$/g, "").trim().toLowerCase()
      );
      continue;
    }
    
    const values = parseCSVLine(line);
    const row: any[] = [];
    
    for (const col of mapping.columns) {
      const idx = headers.indexOf(col.toLowerCase());
      const value = idx >= 0 ? values[idx] : "";
      row.push(parseValue(value));
    }
    
    batch.push(row);
    
    if (batch.length >= BATCH_SIZE) {
      try {
        const count = await insertBatch(sql, mapping.table, mapping.columns, batch);
        totalRows += count;
      } catch (err: any) {
        console.error(`Error at line ${lineNum}:`, err.message);
      }
      batch = [];
      
      if (totalRows % 100000 === 0) {
        process.stdout.write(`  ${(totalRows / 1000).toFixed(0)}k rows...\r`);
      }
    }
  }
  
  if (batch.length > 0) {
    const count = await insertBatch(sql, mapping.table, mapping.columns, batch);
    totalRows += count;
  }
  
  console.log(`✓ ${totalRows.toLocaleString()} rows imported to ${mapping.table}`);
  return totalRows;
}

async function main() {
  const targetTable = process.argv[2];
  
  if (!DATABASE_URL) throw new Error("DATABASE_URL not set");
  if (!targetTable) {
    console.log("Usage: npx tsx scripts/dataone-stream-import.ts TABLE_NAME");
    console.log("Available tables:", Object.keys(TABLE_MAPPINGS).join(", "));
    process.exit(1);
  }
  
  const sql = postgres(DATABASE_URL);
  
  console.log("╔════════════════════════════════════════════╗");
  console.log("║   DataOne Stream Import                    ║");
  console.log("╚════════════════════════════════════════════╝\n");
  
  await streamImportTable(sql, targetTable.toUpperCase());
  
  await sql.end();
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
