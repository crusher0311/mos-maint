import { getDb } from "@/lib/db/drizzle";
import { productionLogs } from "@/lib/db/schema/logs";
import { createHash } from "crypto";
import { lt, max } from "drizzle-orm";
import { sendOpsAlert } from "@/lib/alerts/notify";

const BETTERSTACK_HOST = process.env.BETTERSTACK_QUERY_HOST;
const BETTERSTACK_USER = process.env.BETTERSTACK_QUERY_USERNAME;
const BETTERSTACK_PASS = process.env.BETTERSTACK_QUERY_PASSWORD;
const BETTERSTACK_SOURCE =
  process.env.BETTERSTACK_QUERY_SOURCE || "t500063_mos_production";

const RETENTION_DAYS = 30;
const BATCH_SIZE = 500;

// Freshness alarm defaults (overridable via env).
const DEFAULT_FRESHNESS_MAX_LAG_MIN = 30;
const DEFAULT_FRESHNESS_ALERT_REPEAT_MIN = 60;

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

/**
 * Fetch one page of logs from Better Stack.
 *
 * Pagination is **keyset** (cursor on `dt`), not OFFSET. ClickHouse OFFSET
 * pagination is O(offset) — every page re-sorts the whole window and skips,
 * so a high-volume window (tens of thousands of rows) gets quadratically slow
 * and can stall the sync. Keyset (`dt >= cursor`) lets each page seek directly.
 *
 * The cursor clause is **inclusive** (`>=`) so we never skip rows that share the
 * boundary microsecond; the one duplicated boundary row per page is harmless
 * because the insert dedups on `dt_hash`. The `offset` is only ever non-zero
 * when the caller is paging past a tie group larger than one page (many rows at
 * the identical `dt`), so it stays small and never reintroduces O(offset) cost.
 */
async function fetchBetterStackLogs(
  minutesBack: number,
  afterDt: string | null,
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

  const cursorClause = afterDt
    ? ` AND dt >= '${escapeClickhouse(afterDt)}'`
    : "";
  const offsetClause = offset > 0 ? ` OFFSET ${offset}` : "";
  const query = `SELECT dt, raw FROM remote(${escapeClickhouse(BETTERSTACK_SOURCE)}_logs) WHERE dt >= now() - INTERVAL ${minutesBack} MINUTE${cursorClause} ORDER BY dt ASC LIMIT ${BATCH_SIZE}${offsetClause} FORMAT JSONEachRow`;

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

export interface LogSyncResult {
  /** Rows that were actually NEW (not already present). The number that matters. */
  inserted: number;
  /** Rows pulled from Better Stack (incl. dedup conflicts). For visibility only. */
  fetched: number;
  /** Rows dropped before insert (e.g. missing `dt`). */
  skipped: number;
  /** Rows whose insert chunk errored. */
  errors: number;
}

export async function syncLogsFromBetterStack(
  minutesBack: number = 15,
): Promise<LogSyncResult> {
  const db = getDb();
  let inserted = 0;
  let fetched = 0;
  let skipped = 0;
  let errors = 0;
  let cursor: string | null = null; // last `dt` seen (ClickHouse datetime string)
  let tieOffset = 0; // only non-zero while paging past a >1-page group at `cursor`
  let pages = 0;

  while (true) {
    const rows = await fetchBetterStackLogs(minutesBack, cursor, tieOffset);
    if (rows.length === 0) break;
    fetched += rows.length;
    pages++;

    const batch: (typeof productionLogs.$inferInsert)[] = [];
    let maxDtInPage: string | null = null;

    for (const row of rows) {
      const dt = row.dt;
      const rawStr = typeof row.raw === "string" ? row.raw : JSON.stringify(row.raw || "");
      if (!dt) {
        skipped++;
        continue;
      }
      if (maxDtInPage === null || dt > maxDtInPage) maxDtInPage = dt;

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
          // `.returning()` after `onConflictDoNothing` yields ONLY the rows that
          // were actually inserted — conflicts (already-present dt_hash) are
          // excluded. This is the true new-row count, unlike the old code which
          // counted attempted rows and reported a frozen feed as "N inserted".
          const ret = await db
            .insert(productionLogs)
            .values(chunk)
            .onConflictDoNothing({ target: productionLogs.dtHash })
            .returning({ id: productionLogs.id });
          inserted += ret.length;
        } catch (err: any) {
          errors += chunk.length;
          console.error("[LogSync] Batch insert error:", err.message);
        }
      }
    }

    // A short page means we've drained the window.
    if (rows.length < BATCH_SIZE) break;

    // Keyset advance. Normally a full page moves the cursor forward, so we reset
    // the tie offset and seek to the new max. If a full page did NOT advance the
    // cursor, it means more than one page of rows share the exact same `dt`
    // (a burst at one timestamp); page past that tie group with a bounded OFFSET
    // rather than truncating those rows or re-fetching the same page forever.
    if (maxDtInPage && (cursor === null || maxDtInPage > cursor)) {
      cursor = maxDtInPage;
      tieOffset = 0;
    } else {
      tieOffset += BATCH_SIZE;
      console.warn(
        `[LogSync] tie group at dt=${cursor} exceeds one page; paging past with offset=${tieOffset}`,
      );
    }
    if (pages > 5000) {
      console.warn("[LogSync] page hard-cap reached; stopping");
      break;
    }
  }

  return { inserted, fetched, skipped, errors };
}

// Module-level de-dup so a sustained outage pages once per repeat window
// instead of every cron tick. Prod runs the cron on a single lock-holding
// instance, so module state is sufficient; it resets harmlessly on deploy.
let lastFreshnessAlertAt = 0;

function freshnessRepeatMs(): number {
  const min =
    parseInt(
      process.env.LOG_FRESHNESS_ALERT_REPEAT_MIN ||
        String(DEFAULT_FRESHNESS_ALERT_REPEAT_MIN),
      10,
    ) || DEFAULT_FRESHNESS_ALERT_REPEAT_MIN;
  return min * 60 * 1000;
}

export interface LogFreshnessResult {
  latest: string | null;
  lagMinutes: number | null;
  thresholdMinutes: number;
  stale: boolean;
  alerted: boolean;
}

/**
 * Data-freshness guard. The cron reporting "success" only means the run
 * returned — it does NOT mean new logs landed. This checks the actual newest
 * `dt` in `production_logs` and pages via `[OPS-ALERT]` when the feed falls
 * behind, so a silent blackout (cron green, table frozen) can't hide for hours.
 */
export async function checkLogFreshness(): Promise<LogFreshnessResult> {
  const db = getDb();
  const threshold =
    parseInt(
      process.env.LOG_FRESHNESS_MAX_LAG_MIN ||
        String(DEFAULT_FRESHNESS_MAX_LAG_MIN),
      10,
    ) || DEFAULT_FRESHNESS_MAX_LAG_MIN;

  const rows = await db
    .select({ latest: max(productionLogs.dt) })
    .from(productionLogs);
  const latestRaw = rows[0]?.latest ?? null;
  const latest = latestRaw ? new Date(latestRaw as any) : null;

  const lagMinutes =
    latest !== null ? (Date.now() - latest.getTime()) / 60000 : null;
  const stale = lagMinutes === null || lagMinutes > threshold;

  let alerted = false;
  // Only page in production. Non-prod/just-initialized envs legitimately have an
  // empty or idle production_logs table and shouldn't false-alarm.
  if (stale && process.env.NODE_ENV === "production") {
    const now = Date.now();
    if (now - lastFreshnessAlertAt >= freshnessRepeatMs()) {
      lastFreshnessAlertAt = now;
      alerted = true;
      await sendOpsAlert({
        title: "Log feed stale",
        severity: "critical",
        summary:
          latest === null
            ? "production_logs is empty — the Better Stack → Postgres log feed is not delivering."
            : `Newest production_logs row is ${Math.round(
                lagMinutes as number,
              )} min old (threshold ${threshold} min). The log feed appears frozen.`,
        fields: {
          latestDt: latest ? latest.toISOString() : "(none)",
          lagMinutes: lagMinutes === null ? "n/a" : Math.round(lagMinutes),
          thresholdMinutes: threshold,
        },
        source: "log-sync",
        dedupKey: "log-sync-stale",
      });
    }
  }

  return {
    latest: latest ? latest.toISOString() : null,
    lagMinutes: lagMinutes === null ? null : Math.round(lagMinutes),
    thresholdMinutes: threshold,
    stale,
    alerted,
  };
}

export async function purgeOldLogs(): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const result = await db
    .delete(productionLogs)
    .where(lt(productionLogs.dt, cutoff));

  return (result as any)?.rowCount || 0;
}
