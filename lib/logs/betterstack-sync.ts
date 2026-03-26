import { getDb } from "@/lib/db/drizzle";
import { productionLogs } from "@/lib/db/schema/logs";
import { createHash } from "crypto";
import { lt } from "drizzle-orm";

const BETTERSTACK_HOST = process.env.BETTERSTACK_QUERY_HOST;
const BETTERSTACK_USER = process.env.BETTERSTACK_QUERY_USERNAME;
const BETTERSTACK_PASS = process.env.BETTERSTACK_QUERY_PASSWORD;
const BETTERSTACK_SOURCE =
  process.env.BETTERSTACK_QUERY_SOURCE || "t500063_mos_production";

const RETENTION_DAYS = 30;
const BATCH_SIZE = 500;

function escapeClickhouse(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function makeDtHash(dt: string, message: string): string {
  return createHash("sha256")
    .update(`${dt}|${message}`)
    .digest("hex")
    .slice(0, 64);
}

function parseLevel(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('"level":"error"') || lower.includes(" error ") || lower.includes("[error]")) return "error";
  if (lower.includes('"level":"warn"') || lower.includes(" warn ") || lower.includes("[warn]")) return "warn";
  if (lower.includes('"level":"debug"') || lower.includes(" debug ") || lower.includes("[debug]")) return "debug";
  return "info";
}

interface BetterStackRow {
  dt?: string;
  message?: string;
  appname?: string;
  host?: string;
  [key: string]: unknown;
}

async function fetchBetterStackLogs(
  minutesBack: number,
  offset: number = 0,
): Promise<BetterStackRow[]> {
  if (!BETTERSTACK_HOST || !BETTERSTACK_USER || !BETTERSTACK_PASS) {
    throw new Error("Better Stack credentials not configured");
  }

  const endpoint = `https://${BETTERSTACK_HOST}?output_format_pretty_row_numbers=0`;
  const auth = Buffer.from(`${BETTERSTACK_USER}:${BETTERSTACK_PASS}`).toString(
    "base64",
  );
  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "plain/text",
  };

  const query = `SELECT dt, raw FROM remote(${escapeClickhouse(BETTERSTACK_SOURCE)}_logs) WHERE dt >= now() - INTERVAL ${minutesBack} MINUTE ORDER BY dt ASC LIMIT ${BATCH_SIZE} OFFSET ${offset} FORMAT JSONEachRow`;

  const res = await fetch(endpoint, { method: "POST", headers, body: query });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`BetterStack query failed: ${res.status} - ${errText.slice(0, 200)}`);
  }

  const text = await res.text();
  if (!text.trim()) return [];

  const lines = text.trim().split("\n").filter(Boolean);
  const rows: BetterStackRow[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip unparseable lines
    }
  }
  return rows;
}

export async function syncLogsFromBetterStack(
  minutesBack: number = 15,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  const db = getDb();
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const rows = await fetchBetterStackLogs(minutesBack, offset);

    if (rows.length === 0) {
      hasMore = false;
      break;
    }

    const batch: (typeof productionLogs.$inferInsert)[] = [];

    for (const row of rows) {
      const dt = row.dt;
      const rawStr = typeof row.raw === "string" ? row.raw : JSON.stringify(row.raw || "");
      if (!dt) {
        skipped++;
        continue;
      }

      let parsed: any = null;
      try {
        parsed = JSON.parse(rawStr);
      } catch {
        // raw is not JSON
      }

      const messageText =
        parsed?.message
          ? typeof parsed.message === "object"
            ? JSON.stringify(parsed.message)
            : String(parsed.message)
          : rawStr.slice(0, 500);

      const dtHash = makeDtHash(dt, rawStr.slice(0, 1000));
      const appname = parsed?.syslog?.appname || (row as any).appname || null;
      const host = parsed?.syslog?.host || (row as any).host || null;

      batch.push({
        dt: new Date(dt),
        level: parsed?.level || parseLevel(rawStr),
        message: messageText.slice(0, 10000),
        messageJson: parsed as any,
        appname,
        host,
        raw: rawStr.slice(0, 50000),
        dtHash,
      });
    }

    if (batch.length > 0) {
      const CHUNK = 100;
      for (let i = 0; i < batch.length; i += CHUNK) {
        const chunk = batch.slice(i, i + CHUNK);
        try {
          await db
            .insert(productionLogs)
            .values(chunk)
            .onConflictDoNothing({ target: productionLogs.dtHash });
          inserted += chunk.length;
        } catch (err: any) {
          errors += chunk.length;
          console.error("[LogSync] Batch insert error:", err.message);
        }
      }
    }

    if (rows.length < BATCH_SIZE) {
      hasMore = false;
    } else {
      offset += BATCH_SIZE;
    }
  }

  return { inserted, skipped, errors };
}

export async function purgeOldLogs(): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const result = await db
    .delete(productionLogs)
    .where(lt(productionLogs.dt, cutoff));

  return (result as any)?.rowCount || 0;
}
