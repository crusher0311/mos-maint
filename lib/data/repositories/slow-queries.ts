/**
 * Postgres repository for the slow-query analyzer (task #1161).
 *
 * All DB access for slow-query capture, dashboard reads, retention purge,
 * and spike-alert stats lives here so no other slow-query file needs
 * direct DB imports (direct-db lint stays clean).
 */
import { and, desc, asc, gte, eq, lt, ilike, or, sql, count } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { slowQueries } from "@/lib/db/schema/slow-queries";
import type { SlowQueryRecord } from "@/lib/slow-query/core";

export async function insertSlowQueryRecords(
  records: SlowQueryRecord[],
): Promise<number> {
  if (!records.length) return 0;
  const db = getDb();
  await db.insert(slowQueries).values(
    records.map((r) => ({
      ts: r.ts,
      db: r.db,
      operation: r.operation.slice(0, 40),
      target: r.target ? r.target.slice(0, 200) : null,
      shape: r.shape,
      shapeHash: r.shapeHash,
      durationMs: Math.round(r.durationMs),
      rowsReturned: r.rowsReturned ?? null,
      docsExamined: r.docsExamined ?? null,
      source: r.source ? r.source.slice(0, 120) : null,
      caller: r.caller ? r.caller.slice(0, 300) : null,
    })),
  );
  return records.length;
}

export interface SlowQueryListFilters {
  sinceHours: number;
  db?: "mongo" | "pg";
  target?: string;
  q?: string;
  sort?: "duration" | "ts";
  limit?: number;
  offset?: number;
}

export async function listSlowQueries(filters: SlowQueryListFilters) {
  const db = getDb();
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const since = new Date(Date.now() - filters.sinceHours * 3600 * 1000);

  const conds = [gte(slowQueries.ts, since)];
  if (filters.db) conds.push(eq(slowQueries.db, filters.db));
  if (filters.target) conds.push(ilike(slowQueries.target, `%${filters.target}%`));
  if (filters.q) {
    conds.push(
      or(
        ilike(slowQueries.shape, `%${filters.q}%`),
        ilike(slowQueries.target, `%${filters.q}%`),
        ilike(slowQueries.source, `%${filters.q}%`),
        ilike(slowQueries.caller, `%${filters.q}%`),
      )!,
    );
  }
  const where = and(...conds);

  const orderBy =
    filters.sort === "ts"
      ? [desc(slowQueries.ts)]
      : [desc(slowQueries.durationMs), desc(slowQueries.ts)];

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(slowQueries)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit + 1)
      .offset(offset),
    db.select({ n: count() }).from(slowQueries).where(where),
  ]);

  const hasMore = rows.length > limit;
  return {
    entries: hasMore ? rows.slice(0, limit) : rows,
    total: Number(totalRows[0]?.n ?? 0),
    hasMore,
  };
}

export async function summarizeSlowQueries(opts: {
  sinceHours: number;
  db?: "mongo" | "pg";
  limit?: number;
}) {
  const db = getDb();
  const since = new Date(Date.now() - opts.sinceHours * 3600 * 1000);
  const conds = [gte(slowQueries.ts, since)];
  if (opts.db) conds.push(eq(slowQueries.db, opts.db));

  const rows = await db
    .select({
      shapeHash: slowQueries.shapeHash,
      db: sql<string>`min(${slowQueries.db})`,
      target: sql<string | null>`min(${slowQueries.target})`,
      operation: sql<string>`min(${slowQueries.operation})`,
      shape: sql<string>`min(${slowQueries.shape})`,
      count: count(),
      totalMs: sql<number>`sum(${slowQueries.durationMs})::bigint`,
      avgMs: sql<number>`avg(${slowQueries.durationMs})::float`,
      maxMs: sql<number>`max(${slowQueries.durationMs})`,
      lastSeen: sql<string>`max(${slowQueries.ts})`,
    })
    .from(slowQueries)
    .where(and(...conds))
    .groupBy(slowQueries.shapeHash)
    .orderBy(desc(sql`sum(${slowQueries.durationMs})`))
    .limit(Math.min(opts.limit ?? 50, 200));

  return rows.map((r) => ({
    ...r,
    count: Number(r.count),
    totalMs: Number(r.totalMs),
    avgMs: Math.round(Number(r.avgMs)),
    maxMs: Number(r.maxMs),
  }));
}

/**
 * Retention purge: delete rows older than `retentionDays`, then enforce a
 * hard row cap by deleting the oldest overflow so the table can never grow
 * unbounded even under a capture storm.
 */
export async function purgeSlowQueries(
  retentionDays: number,
  maxRows: number,
): Promise<{ purgedOld: number; purgedOverflow: number }> {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
  const oldResult = await db
    .delete(slowQueries)
    .where(lt(slowQueries.ts, cutoff));
  const purgedOld = (oldResult as any)?.rowCount ?? (oldResult as any)?.count ?? 0;

  let purgedOverflow = 0;
  const totalRows = await db.select({ n: count() }).from(slowQueries);
  const total = Number(totalRows[0]?.n ?? 0);
  if (total > maxRows) {
    const overflow = total - maxRows;
    const boundary = await db
      .select({ id: slowQueries.id })
      .from(slowQueries)
      .orderBy(asc(slowQueries.id))
      .limit(1)
      .offset(overflow - 1);
    const boundaryId = boundary[0]?.id;
    if (boundaryId != null) {
      const res = await db
        .delete(slowQueries)
        .where(sql`${slowQueries.id} <= ${boundaryId}`);
      purgedOverflow = (res as any)?.rowCount ?? (res as any)?.count ?? overflow;
    }
  }
  return { purgedOld, purgedOverflow };
}

/**
 * Spike-alert inputs: slow-query volume + worst latency in the recent
 * window vs a per-window baseline over the preceding hours.
 */
export async function slowQueryWindowStats(
  windowMinutes: number,
  baselineHours: number,
): Promise<{
  windowCount: number;
  windowMaxMs: number;
  baselinePerWindow: number;
  worstTarget: string | null;
}> {
  const db = getDb();
  const now = Date.now();
  const windowStart = new Date(now - windowMinutes * 60 * 1000);
  const baselineStart = new Date(
    now - (baselineHours * 60 + windowMinutes) * 60 * 1000,
  );

  const [windowRows, baselineRows, worstRows] = await Promise.all([
    db
      .select({ n: count(), maxMs: sql<number>`coalesce(max(${slowQueries.durationMs}), 0)` })
      .from(slowQueries)
      .where(gte(slowQueries.ts, windowStart)),
    db
      .select({ n: count() })
      .from(slowQueries)
      .where(and(gte(slowQueries.ts, baselineStart), lt(slowQueries.ts, windowStart))),
    db
      .select({ target: slowQueries.target })
      .from(slowQueries)
      .where(gte(slowQueries.ts, windowStart))
      .orderBy(desc(slowQueries.durationMs))
      .limit(1),
  ]);

  const baselineWindows = Math.max(1, (baselineHours * 60) / windowMinutes);
  return {
    windowCount: Number(windowRows[0]?.n ?? 0),
    windowMaxMs: Number(windowRows[0]?.maxMs ?? 0),
    baselinePerWindow: Number(baselineRows[0]?.n ?? 0) / baselineWindows,
    worstTarget: worstRows[0]?.target ?? null,
  };
}

/**
 * Atomically claim the spike-alert incident (shared PG state, survives
 * autoscaling — module state does not). Returns true iff THIS caller won
 * the right to page: either no incident is active, or the repeat cooldown
 * has elapsed. Winning also marks the incident active and stamps the time.
 */
export async function claimSlowQueryAlert(repeatMs: number): Promise<boolean> {
  const db = getDb();
  const rows = await db.execute(sql`
    UPDATE slow_query_alert_state
    SET active = TRUE, last_alert_at = now()
    WHERE id = 1
      AND (active = FALSE
           OR last_alert_at IS NULL
           OR last_alert_at < now() - make_interval(secs => ${repeatMs / 1000}))
    RETURNING id
  `);
  return (rows as unknown as unknown[]).length > 0;
}

/**
 * Atomically clear the incident. Returns true iff THIS caller flipped it
 * from active to inactive (so exactly one instance emits the all-clear).
 */
export async function clearSlowQueryAlert(): Promise<boolean> {
  const db = getDb();
  const rows = await db.execute(sql`
    UPDATE slow_query_alert_state
    SET active = FALSE
    WHERE id = 1 AND active = TRUE
    RETURNING id
  `);
  return (rows as unknown as unknown[]).length > 0;
}
