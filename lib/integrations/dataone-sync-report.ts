import postgres from "postgres";
import { sendEmail } from "@/lib/email";
import { getPlatformAdminEmails } from "@/lib/super-admins";

const sql = postgres(process.env.DATABASE_URL!);

export interface TableStats {
  table_name: string;
  before_count: number;
  after_count: number;
  added: number;
  removed: number;
  net_change: number;
}

export interface SyncReport {
  sync_id: number;
  started_at: Date;
  completed_at: Date;
  duration_seconds: number;
  file_name: string;
  file_size_mb: number;
  table_stats: TableStats[];
  total_rows_before: number;
  total_rows_after: number;
  has_changes: boolean;
  error?: string;
}

const DATAONE_TABLES = [
  "dataone_vin_reference",
  "dataone_def_maintenance",
  "dataone_def_maintenance_interval",
  "dataone_def_maintenance_schedule",
  "dataone_def_maintenance_operating_parameter",
  "dataone_def_maintenance_computer_code",
  "dataone_def_maintenance_event",
  "dataone_lkp_vin_maintenance",
  "dataone_lkp_vin_maintenance_interval",
  "dataone_lkp_vin_maintenance_event_computer_code",
  "dataone_lkp_ymm_maintenance",
  "dataone_lkp_ymm_maintenance_interval",
  "dataone_lkp_ymm_maintenance_event_computer_code",
  "dataone_def_nhtsa_recall",
  "dataone_lkp_veh_nhtsa_recall",
  "dataone_veh_trim_styles",
  "dataone_lkp_veh_model_number",
  "dataone_def_specification",
  "dataone_lkp_veh_standard_specification",
];

export async function captureTableCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  
  for (const table of DATAONE_TABLES) {
    try {
      const result = await sql.unsafe(`SELECT COUNT(*)::int as count FROM ${table}`);
      counts[table] = result[0]?.count ?? 0;
    } catch (err) {
      counts[table] = 0;
    }
  }
  
  return counts;
}

export function calculateTableStats(
  beforeCounts: Record<string, number>,
  afterCounts: Record<string, number>
): TableStats[] {
  return DATAONE_TABLES.map((table) => {
    const before = beforeCounts[table] ?? 0;
    const after = afterCounts[table] ?? 0;
    const netChange = after - before;
    
    return {
      table_name: table.replace("dataone_", ""),
      before_count: before,
      after_count: after,
      added: netChange > 0 ? netChange : 0,
      removed: netChange < 0 ? Math.abs(netChange) : 0,
      net_change: netChange,
    };
  });
}

export async function saveSyncReport(report: SyncReport): Promise<void> {
  const status = report.error ? "failed" : "completed";
  const rowsImported = JSON.stringify({
    table_stats: report.table_stats,
    total_before: report.total_rows_before,
    total_after: report.total_rows_after,
  });
  
  await sql`
    UPDATE dataone_sync_metadata 
    SET sync_status = ${status}, 
        rows_imported = ${rowsImported}::jsonb, 
        duration_seconds = ${report.duration_seconds},
        error_message = ${report.error || null}
    WHERE id = ${report.sync_id}
  `;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatTableName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace("Lkp ", "")
    .replace("Def ", "")
    .replace("Veh ", "Vehicle ")
    .replace("Ymm ", "YMM ")
    .replace("Vin ", "VIN ");
}

export function generateSyncReportHtml(report: SyncReport): { subject: string; html: string; text: string } {
  const hasChanges = report.table_stats.some((t) => t.net_change !== 0);
  const totalAdded = report.table_stats.reduce((sum, t) => sum + t.added, 0);
  const totalRemoved = report.table_stats.reduce((sum, t) => sum + t.removed, 0);
  
  const changedTables = report.table_stats.filter((t) => t.net_change !== 0);
  const unchangedCount = report.table_stats.length - changedTables.length;
  
  const subject = hasChanges
    ? `DataOne Sync Complete: +${formatNumber(totalAdded)} / -${formatNumber(totalRemoved)} rows`
    : `DataOne Sync Complete: No changes detected`;

  const statusColor = report.error ? "#dc2626" : hasChanges ? "#2563eb" : "#059669";
  const statusLabel = report.error ? "Failed" : hasChanges ? "Updated" : "No Changes";

  const tableRowsHtml = changedTables
    .sort((a, b) => Math.abs(b.net_change) - Math.abs(a.net_change))
    .map((t) => {
      const changeColor = t.net_change > 0 ? "#059669" : "#dc2626";
      const changeSymbol = t.net_change > 0 ? "+" : "";
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${formatTableName(t.table_name)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${formatNumber(t.before_count)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${formatNumber(t.after_count)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;color:${changeColor};font-weight:600">${changeSymbol}${formatNumber(t.net_change)}</td>
        </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;max-width:700px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:20px">
        <div style="display:inline-block;background:#2563eb;border-radius:12px;padding:12px">
          <span style="color:white;font-size:24px;font-weight:bold">MOS</span>
        </div>
      </div>
      
      <div style="background:${statusColor};color:white;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">DataOne Weekly Sync Report</h2>
        <p style="margin:8px 0 0;opacity:0.9">${report.completed_at.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
      </div>
      
      <div style="background:#f8fafc;padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
        <div style="display:flex;gap:15px;flex-wrap:wrap;margin-bottom:20px">
          <div style="background:white;padding:15px;border-radius:6px;flex:1;min-width:120px">
            <div style="font-size:12px;color:#64748b;text-transform:uppercase;font-weight:600">Status</div>
            <div style="font-size:18px;color:${statusColor};font-weight:600;margin-top:4px">${statusLabel}</div>
          </div>
          <div style="background:white;padding:15px;border-radius:6px;flex:1;min-width:120px">
            <div style="font-size:12px;color:#64748b;text-transform:uppercase;font-weight:600">Duration</div>
            <div style="font-size:18px;color:#1e293b;font-weight:600;margin-top:4px">${Math.round(report.duration_seconds / 60)} min</div>
          </div>
          <div style="background:white;padding:15px;border-radius:6px;flex:1;min-width:120px">
            <div style="font-size:12px;color:#64748b;text-transform:uppercase;font-weight:600">File Size</div>
            <div style="font-size:18px;color:#1e293b;font-weight:600;margin-top:4px">${report.file_size_mb.toFixed(1)} MB</div>
          </div>
        </div>
        
        ${report.error ? `
          <div style="background:#fee2e2;border-left:4px solid #dc2626;padding:15px;border-radius:4px;margin-bottom:20px">
            <div style="font-weight:600;color:#991b1b">Error</div>
            <div style="color:#7f1d1d;margin-top:4px">${report.error}</div>
          </div>
        ` : ""}
        
        ${hasChanges ? `
          <div style="margin-bottom:20px">
            <div style="display:flex;gap:20px;justify-content:center;text-align:center">
              <div>
                <div style="font-size:28px;font-weight:700;color:#059669">+${formatNumber(totalAdded)}</div>
                <div style="font-size:12px;color:#64748b;text-transform:uppercase">Rows Added</div>
              </div>
              <div>
                <div style="font-size:28px;font-weight:700;color:#dc2626">-${formatNumber(totalRemoved)}</div>
                <div style="font-size:12px;color:#64748b;text-transform:uppercase">Rows Removed</div>
              </div>
            </div>
          </div>
          
          <h3 style="color:#1f2937;font-size:16px;margin:20px 0 10px">Changed Tables (${changedTables.length})</h3>
          <table style="width:100%;border-collapse:collapse;background:white;border-radius:6px;overflow:hidden">
            <thead>
              <tr style="background:#f1f5f9">
                <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase">Table</th>
                <th style="padding:10px 12px;text-align:right;font-size:12px;color:#64748b;text-transform:uppercase">Before</th>
                <th style="padding:10px 12px;text-align:right;font-size:12px;color:#64748b;text-transform:uppercase">After</th>
                <th style="padding:10px 12px;text-align:right;font-size:12px;color:#64748b;text-transform:uppercase">Change</th>
              </tr>
            </thead>
            <tbody>
              ${tableRowsHtml}
            </tbody>
          </table>
          
          ${unchangedCount > 0 ? `<p style="color:#64748b;font-size:14px;margin-top:10px">${unchangedCount} other tables unchanged</p>` : ""}
        ` : `
          <div style="text-align:center;padding:30px">
            <div style="font-size:48px;margin-bottom:10px">&#10003;</div>
            <div style="font-size:18px;color:#059669;font-weight:600">All data up to date</div>
            <div style="color:#64748b;margin-top:8px">${formatNumber(report.total_rows_after)} total rows across ${report.table_stats.length} tables</div>
          </div>
        `}
        
        <div style="margin-top:20px;padding-top:20px;border-top:1px solid #e5e7eb">
          <h3 style="color:#1f2937;font-size:14px;margin:0 0 10px">Total Row Counts</h3>
          <div style="display:flex;gap:20px">
            <div><span style="color:#64748b">Before:</span> <strong>${formatNumber(report.total_rows_before)}</strong></div>
            <div><span style="color:#64748b">After:</span> <strong>${formatNumber(report.total_rows_after)}</strong></div>
          </div>
        </div>
      </div>
      
      <p style="text-align:center;color:#94a3b8;font-size:12px;margin-top:20px">
        MOS Tools Platform - Automated DataOne Sync Report<br />
        <a href="https://mos.tools" style="color:#2563eb">mos.tools</a>
      </p>
    </div>`;

  const textLines = [
    `DataOne Weekly Sync Report`,
    `Date: ${report.completed_at.toLocaleDateString()}`,
    `Status: ${statusLabel}`,
    `Duration: ${Math.round(report.duration_seconds / 60)} minutes`,
    `File Size: ${report.file_size_mb.toFixed(1)} MB`,
    ``,
  ];

  if (report.error) {
    textLines.push(`Error: ${report.error}`, ``);
  }

  if (hasChanges) {
    textLines.push(`Changes: +${formatNumber(totalAdded)} rows added, -${formatNumber(totalRemoved)} rows removed`, ``);
    textLines.push(`Changed Tables:`);
    changedTables.forEach((t) => {
      const sign = t.net_change > 0 ? "+" : "";
      textLines.push(`  ${formatTableName(t.table_name)}: ${formatNumber(t.before_count)} → ${formatNumber(t.after_count)} (${sign}${formatNumber(t.net_change)})`);
    });
  } else {
    textLines.push(`No changes detected. All data up to date.`);
  }

  textLines.push(``, `Total rows: ${formatNumber(report.total_rows_after)}`);

  return { subject, html, text: textLines.join("\n") };
}

export async function sendSyncReportToAdmins(report: SyncReport): Promise<{ sent: number; emails: string[] }> {
  const adminEmails = await getPlatformAdminEmails();
  const { subject, html, text } = generateSyncReportHtml(report);
  
  let sent = 0;
  for (const email of adminEmails) {
    try {
      await sendEmail({ to: email, subject, html, text });
      sent++;
    } catch (err) {
      console.error(`[dataone-sync] Failed to send report to ${email}:`, err);
    }
  }
  
  console.log(`[dataone-sync] Sent report to ${sent}/${adminEmails.length} platform admins`);
  return { sent, emails: adminEmails };
}
