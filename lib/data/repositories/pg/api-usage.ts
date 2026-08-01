/**
 * Postgres-backed `api_usage` / `api_rate_limits` repository — the read
 * & write surface used by `lib/data/repositories/api-usage.ts` when
 * `API_USAGE_PG_CANONICAL=1` (task #999).
 *
 * Backs the `api_usage` and `api_rate_limits` tables
 * (lib/db/schema/integration-ops.ts). The Mongo `api_usage` docs carry a
 * fixed set of typed columns plus an evolving tail of bookkeeping fields
 * (minuteBucket, retryCount, token counts, …). To preserve doc shape
 * across the cutover we map the known fields onto typed columns and
 * stash every unknown field in the `extra` jsonb; on read the typed
 * columns are overlaid back onto the spread `extra` so callers see an
 * identical record.
 *
 * `api_rate_limits` is the transient cross-worker limiter: a string
 * `slot_key` + `count` + TTL. Mongo uses `findOneAndUpdate` with `$inc`
 * / `$setOnInsert`; PG mirrors that with `INSERT … ON CONFLICT DO
 * UPDATE` preserving increment/claim semantics exactly.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag.
 */
import { and, desc, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { apiRateLimits, apiUsage } from "@/lib/db/schema/integration-ops";

type AnyDoc = Record<string, unknown>;

/** Columns that map 1:1 onto typed `api_usage` columns. */
const TYPED_USAGE_KEYS = new Set([
  "_id",
  "id",
  "provider",
  "shopId",
  "shopName",
  "endpoint",
  "method",
  "statusCode",
  "isError",
  "isRateLimited",
  "errorMessage",
  "errorCode",
  "latencyMs",
  "requestId",
  "sourceWorker",
  "timestamp",
]);

function toDate(v: unknown): Date | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNum(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * The PG primary key is the Mongo `_id` hex when present (so an operator
 * backfill is idempotent), else a fresh UUID.
 */
function usageId(doc: AnyDoc): string {
  const raw = doc._id ?? doc.id;
  if (raw !== undefined && raw !== null) {
    // Mongo ObjectId → hex string; anything else → its string form.
    const s =
      typeof raw === "object" && raw !== null && "toString" in raw
        ? (raw as { toString: () => string }).toString()
        : String(raw);
    if (s) return s;
  }
  return crypto.randomUUID();
}

function usageRow(doc: AnyDoc): typeof apiUsage.$inferInsert {
  const extra: AnyDoc = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!TYPED_USAGE_KEYS.has(k)) extra[k] = v;
  }
  const ts = toDate(doc.timestamp) ?? new Date();
  return {
    id: usageId(doc),
    provider: String(doc.provider),
    shopId: toNum(doc.shopId),
    shopName: (doc.shopName as string | undefined) ?? null,
    endpoint: (doc.endpoint as string | undefined) ?? null,
    method: (doc.method as string | undefined) ?? null,
    statusCode: toNum(doc.statusCode),
    isError: Boolean(doc.isError),
    isRateLimited: Boolean(doc.isRateLimited),
    errorMessage: (doc.errorMessage as string | undefined) ?? null,
    errorCode: (doc.errorCode as string | undefined) ?? null,
    latencyMs: toNum(doc.latencyMs),
    requestId: (doc.requestId as string | undefined) ?? null,
    sourceWorker: (doc.sourceWorker as string | undefined) ?? null,
    timestamp: ts,
    extra: Object.keys(extra).length > 0 ? extra : null,
  } as typeof apiUsage.$inferInsert;
}

export async function pgInsertUsageRecords(records: AnyDoc[]): Promise<void> {
  if (records.length === 0) return;
  const db = getDb();
  await db
    .insert(apiUsage)
    .values(records.map((r) => usageRow(r)))
    .onConflictDoNothing({ target: apiUsage.id });
}

/* -------------------------------------------------------------------------- */
/* api_rate_limits                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Mongo `findOneAndUpdate({_id:key}, {$inc:{count:1},
 * $setOnInsert:{createdAt,expiresAt}}, {upsert, returnDocument:"after"})`.
 * PG upsert with an atomic `count + 1` and DO-UPDATE-only-touches-count
 * (createdAt/expiresAt are $setOnInsert, so preserved on conflict).
 */
export async function pgClaimRateLimitSlot(
  key: string,
  expiresAt: Date,
): Promise<{ count: number }> {
  const db = getDb();
  const rows = await db
    .insert(apiRateLimits)
    .values({
      slotKey: key,
      count: 1,
      createdAt: new Date(),
      expiresAt,
    } as typeof apiRateLimits.$inferInsert)
    .onConflictDoUpdate({
      target: apiRateLimits.slotKey,
      set: { count: sql`${apiRateLimits.count} + 1` },
    })
    .returning({ count: apiRateLimits.count });
  return { count: rows[0]?.count ?? 1 };
}

/** Mongo `updateOne({_id:key}, {$inc:{count:-1}})` — no upsert. */
export async function pgReleaseRateLimitSlot(key: string): Promise<void> {
  const db = getDb();
  await db
    .update(apiRateLimits)
    .set({ count: sql`${apiRateLimits.count} - 1` })
    .where(eq(apiRateLimits.slotKey, key));
}

/* -------------------------------------------------------------------------- */
/* Read helpers (windowed counts, top-N by shop, recent 429s)                  */
/* -------------------------------------------------------------------------- */

/** count(*) for provider since `since` (optionally error/rate-limited only). */
export async function pgCountUsage(opts: {
  provider: string;
  since: Date;
  isError?: boolean;
  isRateLimited?: boolean;
}): Promise<number> {
  const db = getDb();
  const conds = [
    eq(apiUsage.provider, opts.provider),
    gte(apiUsage.timestamp, opts.since),
  ];
  if (opts.isError !== undefined) conds.push(eq(apiUsage.isError, opts.isError));
  if (opts.isRateLimited !== undefined)
    conds.push(eq(apiUsage.isRateLimited, opts.isRateLimited));
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(apiUsage)
    .where(and(...conds));
  return rows[0]?.n ?? 0;
}

/** avg(latency_ms) for provider since `since`. */
export async function pgAvgLatency(
  provider: string,
  since: Date,
): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ avg: sql<number>`coalesce(avg(${apiUsage.latencyMs}), 0)` })
    .from(apiUsage)
    .where(and(eq(apiUsage.provider, provider), gte(apiUsage.timestamp, since)));
  return Number(rows[0]?.avg ?? 0);
}

/** group by shop_id order by count desc limit N (shop_id not null). */
export async function pgTopShops(
  provider: string,
  since: Date,
  limit: number,
): Promise<{ shopId: number; count: number }[]> {
  const db = getDb();
  const rows = await db
    .select({
      shopId: apiUsage.shopId,
      count: sql<number>`count(*)::int`,
    })
    .from(apiUsage)
    .where(
      and(
        eq(apiUsage.provider, provider),
        gte(apiUsage.timestamp, since),
        isNotNull(apiUsage.shopId),
      ),
    )
    .groupBy(apiUsage.shopId)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  return rows
    .filter((r) => r.shopId !== null)
    .map((r) => ({ shopId: r.shopId as number, count: r.count }));
}

/** Recent rate-limited / 429 rows, newest first. */
export async function pgRecent429s(
  provider: string,
  since: Date,
  limit: number,
): Promise<{ timestamp: Date; endpoint: string | null; shopId: number | null }[]> {
  const db = getDb();
  const rows = await db
    .select({
      timestamp: apiUsage.timestamp,
      endpoint: apiUsage.endpoint,
      shopId: apiUsage.shopId,
    })
    .from(apiUsage)
    .where(
      and(
        eq(apiUsage.provider, provider),
        gte(apiUsage.timestamp, since),
        or(eq(apiUsage.isRateLimited, true), eq(apiUsage.statusCode, 429)),
      ),
    )
    .orderBy(desc(apiUsage.timestamp))
    .limit(limit);
  return rows;
}
