/**
 * Slow-query analyzer — pure core (task #1161).
 *
 * Env-tunable gating + sanitizers, kept free of any DB/server-only imports
 * so they can be unit-tested under plain tsx. The buffered persistence
 * lives in lib/slow-query/tracker.ts.
 *
 * Env vars:
 *   SLOW_QUERY_TRACKING_DISABLED=1  — kill switch; hot paths do no extra work.
 *   SLOW_QUERY_THRESHOLD_MS         — capture threshold (default 500ms).
 *   SLOW_QUERY_SAMPLE_RATE          — 0..1 fraction of slow ops recorded (default 1).
 */
// NOTE: no node "crypto" import — this module is pulled in via
// src/instrumentation.ts and must stay bundleable outside the pure Node
// runtime. shapeHash is a grouping key, not a security primitive, so a
// fast pure-JS FNV-1a hash is sufficient.

export const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 500;

export function slowQueryTrackingEnabled(): boolean {
  return process.env.SLOW_QUERY_TRACKING_DISABLED !== "1";
}

export function slowQueryThresholdMs(): number {
  const n = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SLOW_QUERY_THRESHOLD_MS;
}

export function slowQuerySampleRate(): number {
  const n = parseFloat(process.env.SLOW_QUERY_SAMPLE_RATE || "");
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Mongo command sanitizer — keep the structural shape (keys + operators),
// redact every leaf value so no customer PII / secrets are ever stored.
// ---------------------------------------------------------------------------

const MAX_DEPTH = 6;
const MAX_KEYS = 40;
const MAX_ARRAY = 5;

function sanitizeValue(v: unknown, depth: number): unknown {
  if (v === null || v === undefined) return "?";
  if (Array.isArray(v)) {
    if (depth >= MAX_DEPTH) return `[…${v.length}]`;
    const out = v.slice(0, MAX_ARRAY).map((x) => sanitizeValue(x, depth + 1));
    if (v.length > MAX_ARRAY) out.push(`…+${v.length - MAX_ARRAY}`);
    return out;
  }
  if (typeof v === "object") {
    if (depth >= MAX_DEPTH) return "{…}";
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (i++ >= MAX_KEYS) {
        out["…"] = "truncated";
        break;
      }
      out[k] = sanitizeValue(val, depth + 1);
    }
    return out;
  }
  // Every scalar leaf (string, number, bool, ObjectId-ish, Date) → "?".
  return "?";
}

/** Mongo command sections that carry query STRUCTURE worth keeping. */
const SHAPE_SECTIONS = [
  "filter",
  "query",
  "pipeline",
  "sort",
  "projection",
  "update",
  "updates",
  "deletes",
  "key",
  "indexes",
  "hint",
] as const;

/**
 * Reduce a Mongo command document to a sanitized shape string. Keys and
 * operators ($gte, $in, $regex, aggregation stages) are preserved; every
 * value is replaced with "?". Bulk document payloads (insert/update docs)
 * are collapsed rather than walked in full.
 */
export function sanitizeMongoCommand(
  commandName: string,
  command: Record<string, unknown> | null | undefined,
): string {
  if (!command || typeof command !== "object") return commandName;
  const shape: Record<string, unknown> = {};
  for (const section of SHAPE_SECTIONS) {
    if (section in command) {
      shape[section] = sanitizeValue((command as any)[section], 0);
    }
  }
  if ("documents" in command) {
    const docs = (command as any).documents;
    shape.documents = Array.isArray(docs) ? `[${docs.length} docs]` : "?";
  }
  if ("limit" in command) shape.limit = "?";
  if ("skip" in command) shape.skip = "?";
  let text: string;
  try {
    text = `${commandName} ${JSON.stringify(shape)}`;
  } catch {
    text = commandName;
  }
  return text.length > 2000 ? text.slice(0, 1997) + "…" : text;
}

/** Extract the target collection from a Mongo command document. */
export function mongoCommandCollection(
  commandName: string,
  command: Record<string, unknown> | null | undefined,
): string | null {
  const v = command ? (command as any)[commandName] : null;
  if (typeof v === "string" && v) return v;
  const agg = command ? (command as any).aggregate : null;
  if (typeof agg === "string" && agg) return agg;
  return null;
}

/** Administrative / heartbeat commands we never record. */
const IGNORED_MONGO_COMMANDS = new Set([
  "hello",
  "ismaster",
  "isMaster",
  "ping",
  "endSessions",
  "saslStart",
  "saslContinue",
  "authenticate",
  "getMore", // duration belongs to the originating find/aggregate
  "buildInfo",
  "connectionStatus",
  "listCollections",
  "listIndexes",
]);

export function isIgnoredMongoCommand(commandName: string): boolean {
  return IGNORED_MONGO_COMMANDS.has(commandName);
}

// ---------------------------------------------------------------------------
// SQL sanitizer — strip literal values from query text. Drizzle sends
// parameterized queries ($1, $2 …) so most text is already value-free, but
// hand-built sql.unsafe() strings can inline literals; redact them all.
// ---------------------------------------------------------------------------

/**
 * Conservative single-pass lexer, not regexes: fully consumes standard
 * literals ('' doubling), escape literals (E'…' with backslash escapes),
 * dollar-quoted literals ($tag$…$tag$), and strips line (--) and nested
 * block comments. An unterminated literal/comment redacts the REST of the
 * text — when parsing is uncertain we drop text rather than retain it.
 */
export function sanitizeSqlText(text: string): string {
  const t = String(text || "");
  let out = "";
  let i = 0;
  const n = t.length;
  while (i < n) {
    const c = t[i];
    const prev = i > 0 ? t[i - 1] : "";

    // Escape string literal: E'...' (backslash escapes valid inside).
    if ((c === "e" || c === "E") && t[i + 1] === "'" && !/[\w$]/.test(prev)) {
      i += 2;
      let closed = false;
      while (i < n) {
        if (t[i] === "\\") i += 2;
        else if (t[i] === "'" && t[i + 1] === "'") i += 2;
        else if (t[i] === "'") {
          i++;
          closed = true;
          break;
        } else i++;
      }
      out += "?";
      if (!closed) break; // unterminated → redact remainder
      continue;
    }

    // Standard literal: '...' with '' doubling (backslash is NOT an escape).
    if (c === "'") {
      i++;
      let closed = false;
      while (i < n) {
        if (t[i] === "'" && t[i + 1] === "'") i += 2;
        else if (t[i] === "'") {
          i++;
          closed = true;
          break;
        } else i++;
      }
      out += "?";
      if (!closed) break;
      continue;
    }

    // Dollar-quoted literal: $tag$ ... $tag$ (but NOT $1 placeholders).
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(t.slice(i));
      if (m) {
        const close = m[0];
        const end = t.indexOf(close, i + close.length);
        out += "?";
        if (end === -1) break; // unterminated → redact remainder
        i = end + close.length;
        continue;
      }
      // $1-style placeholder — keep as-is.
      const ph = /^\$\d+/.exec(t.slice(i));
      if (ph) {
        out += ph[0];
        i += ph[0].length;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    // Line comment: -- to end of line — stripped entirely.
    if (c === "-" && t[i + 1] === "-") {
      const nl = t.indexOf("\n", i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }

    // Block comment: /* ... */ (nested, per PG) — stripped entirely.
    if (c === "/" && t[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (t[i] === "/" && t[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (t[i] === "*" && t[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) break; // unterminated → redact remainder
      continue;
    }

    // Quoted identifier: "..." — keep (identifiers, not values).
    if (c === '"') {
      const end = t.indexOf('"', i + 1);
      if (end === -1) break;
      out += t.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // Numeric literal (not part of an identifier or $n placeholder) → ?
    if (/\d/.test(c) && !/[\w$]/.test(prev)) {
      let j = i;
      while (j < n && /[\d.]/.test(t[j])) j++;
      out += "?";
      i = j;
      continue;
    }

    out += c;
    i++;
  }

  const collapsed = out.replace(/\s+/g, " ").trim();
  return collapsed.length > 2000 ? collapsed.slice(0, 1997) + "…" : collapsed;
}

/** Best-effort main table extraction from SQL text. */
export function sqlTargetTable(text: string): string | null {
  const t = String(text || "");
  const m =
    /\b(?:from|into|update|join)\s+(?:only\s+)?("?[A-Za-z_][\w$]*"?(?:\."?[A-Za-z_][\w$]*"?)?)/i.exec(
      t,
    );
  if (!m) return null;
  return m[1].replace(/"/g, "").split(".").pop() || null;
}

export function sqlOperation(text: string): string {
  const m = /^\s*([A-Za-z]+)/.exec(String(text || ""));
  return (m ? m[1] : "query").toLowerCase().slice(0, 40);
}

/**
 * Stable hash of a sanitized shape, used to group repeat offenders.
 * Two independent 32-bit FNV-1a passes (different offsets) → 16 hex chars,
 * plenty for grouping distinct query shapes.
 */
export function shapeHash(db: string, target: string | null, shape: string): string {
  const input = `${db}|${target || ""}|${shape}`;
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000197) >>> 0;
  }
  return (
    h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
  );
}

export type SlowQueryDbKind = "mongo" | "pg";

export interface SlowQueryRecord {
  ts: Date;
  db: SlowQueryDbKind;
  operation: string;
  target: string | null;
  shape: string;
  shapeHash: string;
  durationMs: number;
  rowsReturned?: number | null;
  docsExamined?: number | null;
  source?: string | null;
  caller?: string | null;
}

/** Process-role tag recorded with each capture (web vs worker etc.). */
export function slowQuerySource(): string {
  return (
    process.env.RENDER_SERVICE_NAME ||
    process.env.SOURCE_WORKER ||
    process.env.SERVICE_NAME ||
    "web"
  );
}
