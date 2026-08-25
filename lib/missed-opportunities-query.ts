/**
 * Task #1180 — pure query-fragment builder for the Missed Opportunities
 * closed-RO window filter.
 *
 * Why this exists: the report's "closed at" is a raw sql`` coalesce
 * expression (coalesce(closed_date, completed_date)), and drizzle has NO
 * column encoder for a raw SQL expression. `gte(rawExpr, someDate)` passes
 * the JS Date to postgres-js unserialized, which throws
 * ERR_INVALID_ARG_TYPE ("Received an instance of Date") — every compute
 * fails and the report route 500s. The fix is to bind an ISO-8601 string
 * and cast it to timestamptz explicitly, so the driver only ever sees a
 * string parameter.
 *
 * Kept free of `server-only` / DB-pool imports so it can be unit-tested
 * under tsx (tests/missed-opportunities.smoke.ts).
 */
import { sql, type SQL } from "drizzle-orm";

/**
 * `<closeDateExpr> >= <since>` with the Date bound as an ISO string cast
 * to timestamptz. Never pass a raw JS Date into a comparison against a
 * raw sql`` expression (see module docblock).
 */
export function buildCloseDateSincePredicate(
  closeDateExpr: SQL<Date | null>,
  since: Date,
): SQL<boolean> {
  return sql<boolean>`${closeDateExpr} >= ${since.toISOString()}::timestamptz`;
}
