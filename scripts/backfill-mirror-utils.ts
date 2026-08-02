/**
 * Pure helpers for the Mongo→PG backfill mirrors (task #1018).
 *
 * Extracted from scripts/backfill-mongo-to-supabase.ts so they can be
 * unit-tested without importing the script (which auto-runs main()).
 *
 * Fixes two empirically-confirmed prod failure modes (2026-08-02):
 *   1. UNDEFINED_VALUE — postgres-js rejects `undefined` params. Absent
 *      Mongo fields must reach PG as SQL NULL.
 *   2. Tuple expansion — drizzle renders a raw JS array param as a SQL
 *      tuple (`($20, $21, ...)` / `()`), not a jsonb value. Arrays and
 *      plain objects destined for jsonb columns must be bound as a single
 *      JSON-text parameter cast with `::jsonb`.
 */
import { sql, type SQL } from "drizzle-orm";

export function quoteIdent(name: string): string {
  // Allow snake_case identifiers only — defensive guard, not a SQL builder.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Bind one extracted value as a single SQL parameter:
 *  - undefined / null   → NULL (postgres-js throws UNDEFINED_VALUE on undefined)
 *  - Date               → passed through (postgres-js serializes timestamps)
 *  - array / object     → JSON.stringify + ::jsonb cast, ONE parameter
 *                         (BSON ObjectId/Decimal128 serialize via toJSON)
 *  - scalars            → passed through
 */
export function mirrorParam(v: unknown): SQL {
  if (v === undefined || v === null) return sql`${null}`;
  if (v instanceof Date) return sql`${v}`;
  if (typeof v === "object") {
    // JSON.stringify can return undefined for exotic inputs (e.g. a bare
    // function); normalize to SQL NULL rather than crashing the row.
    const json = JSON.stringify(v);
    if (json === undefined) return sql`${null}`;
    return sql`${json}::jsonb`;
  }
  return sql`${v}`;
}

export interface BuildUpsertOpts {
  /** Conflict target columns. Absent → `backfill_mongo_id` insert-or-skip. */
  conflictKey?: string[];
  /** Refresh non-key columns on conflict (default true when conflictKey set). */
  refreshOnConflict?: boolean;
}

/** Build the parameterised upsert used by every mirror spec. */
export function buildMirrorUpsert(
  tableName: string,
  values: Record<string, unknown>,
  opts: BuildUpsertOpts = {},
): SQL {
  const cols = Object.keys(values);
  const colsSql = cols.map(quoteIdent).join(", ");
  const valuesChunk = sql.join(
    cols.map((c) => mirrorParam(values[c])),
    sql`, `,
  );

  const conflictKey = opts.conflictKey;
  const refresh = opts.refreshOnConflict !== false;

  let conflictClause: SQL;
  if (conflictKey && conflictKey.length > 0) {
    const target = conflictKey.map(quoteIdent).join(", ");
    if (refresh) {
      const updatable = cols
        .filter((c) => !conflictKey.includes(c))
        .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
        .join(", ");
      conflictClause = updatable
        ? sql.raw(` ON CONFLICT (${target}) DO UPDATE SET ${updatable}`)
        : sql.raw(` ON CONFLICT (${target}) DO NOTHING`);
    } else {
      conflictClause = sql.raw(` ON CONFLICT (${target}) DO NOTHING`);
    }
  } else {
    conflictClause = sql.raw(` ON CONFLICT ("backfill_mongo_id") DO NOTHING`);
  }

  return sql`INSERT INTO ${sql.raw(quoteIdent(tableName))} (${sql.raw(colsSql)}) VALUES (${valuesChunk})${conflictClause}`;
}

/**
 * Human-diagnosable error line for the "sample errors" output. postgres-js
 * wraps the real PG error: the SQLSTATE lives on `err.code` and drizzle can
 * nest the driver error under `err.cause`. Include both so future mirror
 * failures are diagnosable without reproduction.
 */
export function describeMirrorError(reason: unknown): string {
  const fmt = (e: any): string => {
    if (e == null) return String(e);
    const msg = e?.message != null ? String(e.message) : String(e);
    const code = e?.code ? ` [${String(e.code)}]` : "";
    return `${msg}${code}`;
  };
  let out = fmt(reason);
  const cause = (reason as any)?.cause;
  if (cause != null && cause !== reason) {
    out += ` (cause: ${fmt(cause)})`;
  }
  return out;
}

/* ------------------------- support_tickets enums ------------------------- */
/* Keep in sync with lib/db/schema/support-tickets.ts pgEnum definitions.    */

export const TICKET_STATUSES = new Set([
  "open", "in_progress", "pending", "resolved", "closed",
]);
export const TICKET_PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
export const TICKET_CATEGORIES = new Set([
  "technical", "billing", "integration", "feature_request", "general",
]);

/**
 * Enum-safe coercion. Mongo tickets carry categories outside the PG
 * `ticket_category` enum (e.g. `account`); rather than extend the enum
 * (operator DDL) we map unknowns to the fallback and let the caller stash
 * the original value in `metadata` so nothing is lost. Documented choice
 * per task #1018.
 */
export function safeEnum(
  v: unknown,
  allowed: Set<string>,
  fallback: string,
): { value: string; original: string | null } {
  if (v == null || v === "") return { value: fallback, original: null };
  const s = String(v);
  if (allowed.has(s)) return { value: s, original: null };
  return { value: fallback, original: s };
}
