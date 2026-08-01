// Repository for the `api_usage` and `api_rate_limits` collections.
//
// These collections back the cross-worker rate limiter and the
// observability dashboards. Callers stay narrow: insert records,
// claim/release rate-limit slots, and run a small set of stats
// queries.
import type { Collection, Document, Filter, ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";
import { shadowWriteMongoIntegrationOps } from "@/lib/db/integration-ops-write-mode";
import {
  pgAvgLatency,
  pgClaimRateLimitSlot,
  pgCountUsage,
  pgInsertUsageRecords,
  pgRecent429s,
  pgReleaseRateLimitSlot,
  pgTopShops,
} from "@/lib/data/repositories/pg/api-usage";

const USAGE_COLLECTION = "api_usage";
const RATE_LIMIT_COLLECTION = "api_rate_limits";

/**
 * Flag helpers for the api-usage cutover (task #999), local to this repo
 * per the ops-store convention (mirroring
 * `lib/db/integration-cache-write-mode.ts`): the schema/foundation adds
 * no new flag to `lib/db/*`, so polarity + shadow-write live here.
 *
 *   API_USAGE_PG_CANONICAL === "1"  → PG is canonical (read/write PG,
 *                                     shadow-write Mongo). Default OFF
 *                                     keeps byte-identical Mongo
 *                                     behaviour.
 *   WRITE_MONGO_API_USAGE !== "0"   → keep the Mongo shadow write on
 *                                     during the post-flip soak.
 */
function isApiUsagePgCanonical(): boolean {
  return process.env.API_USAGE_PG_CANONICAL === "1";
}
function shouldShadowWriteMongoApiUsage(): boolean {
  return process.env.WRITE_MONGO_API_USAGE !== "0";
}

export interface ApiUsageRecord extends Document {
  _id?: ObjectId;
  provider: string;
  shopId?: number | null;
  shopName?: string;
  endpoint: string;
  method: string;
  statusCode: number;
  isError: boolean;
  isRateLimited?: boolean;
  errorMessage?: string;
  errorCode?: string;
  latencyMs: number;
  requestId?: string;
  sourceWorker?: string;
  timestamp: Date;
}

type UsageFilter = Filter<Document>;

export interface RateLimitRecord {
  _id: string;
  count: number;
  createdAt?: Date;
  expiresAt?: Date;
}

async function usageCollection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(USAGE_COLLECTION);
}

async function rateLimitCollection(): Promise<Collection<RateLimitRecord>> {
  const db = await getDb();
  return db.collection<RateLimitRecord>(RATE_LIMIT_COLLECTION);
}

export async function insertUsageRecords(records: Document[]): Promise<void> {
  if (records.length === 0) return;
  if (isApiUsagePgCanonical()) {
    await pgInsertUsageRecords(records.map((r) => ({ ...r })));
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoApiUsage,
      "api_usage.insert",
      async () => {
        const col = await usageCollection();
        await col.insertMany(records.map((r) => ({ ...r })));
      },
    );
    return;
  }
  const col = await usageCollection();
  await col.insertMany(records.map((r) => ({ ...r })));
}

export interface RateLimitClaimResult {
  count: number;
}

export async function claimRateLimitSlot(
  key: string,
  expiresAt: Date,
): Promise<RateLimitClaimResult> {
  if (isApiUsagePgCanonical()) {
    const result = await pgClaimRateLimitSlot(key, expiresAt);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoApiUsage,
      "api_rate_limits.claim",
      async () => {
        const col = await rateLimitCollection();
        await col.updateOne(
          { _id: key },
          {
            $inc: { count: 1 },
            $setOnInsert: { createdAt: new Date(), expiresAt },
          },
          { upsert: true },
        );
      },
    );
    return result;
  }
  const col = await rateLimitCollection();
  const result = await col.findOneAndUpdate(
    { _id: key },
    {
      $inc: { count: 1 },
      $setOnInsert: { createdAt: new Date(), expiresAt },
    },
    { upsert: true, returnDocument: "after" },
  );
  return { count: result?.count ?? 1 };
}

export async function releaseRateLimitSlot(key: string): Promise<void> {
  if (isApiUsagePgCanonical()) {
    await pgReleaseRateLimitSlot(key);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoApiUsage,
      "api_rate_limits.release",
      async () => {
        const col = await rateLimitCollection();
        await col.updateOne({ _id: key }, { $inc: { count: -1 } });
      },
    );
    return;
  }
  const col = await rateLimitCollection();
  await col.updateOne({ _id: key }, { $inc: { count: -1 } });
}

export async function countUsage(filter: UsageFilter): Promise<number> {
  const col = await usageCollection();
  return col.countDocuments(filter);
}

export async function aggregateUsage<T = Document>(pipeline: Document[]): Promise<T[]> {
  const col = await usageCollection();
  return col.aggregate<T>(pipeline).toArray();
}

export async function findOneUsage(
  filter: UsageFilter,
): Promise<ApiUsageRecord | null> {
  const col = await usageCollection();
  return (await col.findOne(filter)) as ApiUsageRecord | null;
}

export interface FindUsageOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  projection?: Record<string, 0 | 1>;
}

export async function findUsage(
  filter: UsageFilter,
  opts: FindUsageOptions = {},
): Promise<ApiUsageRecord[]> {
  const col = await usageCollection();
  const cursor = col.find(filter);
  if (opts.sort) cursor.sort(opts.sort);
  if (opts.limit) cursor.limit(opts.limit);
  if (opts.projection) cursor.project(opts.projection);
  return (await cursor.toArray()) as ApiUsageRecord[];
}

export async function ensureApiUsageIndexes(): Promise<void> {
  const col = await usageCollection();
  await Promise.all([
    col.createIndex({ provider: 1, timestamp: -1 }),
    col.createIndex({ provider: 1, isError: 1, timestamp: -1 }),
    col.createIndex({ provider: 1, shopId: 1, timestamp: -1 }),
    col.createIndex({ requestId: 1 }, { sparse: true }),
    col.createIndex({ timestamp: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 }),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Typed, flag-gated read helpers                                             */
/*                                                                            */
/* These wrap the specific windowed-count / group-by-shop / recent-429       */
/* shapes that the usage-stats readers need, so those callers no longer      */
/* have to hand-write Mongo pipelines (which can't be generically            */
/* translated to SQL). When PG is canonical they run SQL; otherwise they     */
/* run the equivalent Mongo query, byte-identical to the old inline code.    */
/* -------------------------------------------------------------------------- */

export interface UsageWindowCountOptions {
  isError?: boolean;
  isRateLimited?: boolean;
}

/** count(*) for a provider since `since`, optionally error/429-only. */
export async function countUsageInWindow(
  provider: string,
  since: Date,
  opts: UsageWindowCountOptions = {},
): Promise<number> {
  if (isApiUsagePgCanonical()) {
    return pgCountUsage({ provider, since, ...opts });
  }
  const filter: UsageFilter = { provider, timestamp: { $gte: since } };
  if (opts.isError !== undefined) filter.isError = opts.isError;
  if (opts.isRateLimited !== undefined) filter.isRateLimited = opts.isRateLimited;
  const col = await usageCollection();
  return col.countDocuments(filter);
}

/** avg(latencyMs) for a provider since `since`. */
export async function avgLatencyInWindow(
  provider: string,
  since: Date,
): Promise<number> {
  if (isApiUsagePgCanonical()) {
    return pgAvgLatency(provider, since);
  }
  const col = await usageCollection();
  const rows = await col
    .aggregate<{ avg: number }>([
      { $match: { provider, timestamp: { $gte: since } } },
      { $group: { _id: null, avg: { $avg: "$latencyMs" } } },
    ])
    .toArray();
  return rows[0]?.avg ?? 0;
}

/** Top-N shops by request count for a provider since `since`. */
export async function topShopsInWindow(
  provider: string,
  since: Date,
  limit: number,
): Promise<{ shopId: number; count: number }[]> {
  if (isApiUsagePgCanonical()) {
    return pgTopShops(provider, since, limit);
  }
  const col = await usageCollection();
  const rows = await col
    .aggregate<{ _id: number; count: number }>([
      {
        $match: {
          provider,
          timestamp: { $gte: since },
          shopId: { $exists: true, $ne: null },
        },
      },
      { $group: { _id: "$shopId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ])
    .toArray();
  return rows.map((r) => ({ shopId: r._id, count: r.count }));
}

/** Recent rate-limited / 429 rows for a provider, newest first. */
export async function recentRateLimitedInWindow(
  provider: string,
  since: Date,
  limit: number,
): Promise<{ timestamp: Date; endpoint?: string; shopId?: number }[]> {
  if (isApiUsagePgCanonical()) {
    const rows = await pgRecent429s(provider, since, limit);
    return rows.map((r) => ({
      timestamp: r.timestamp,
      endpoint: r.endpoint ?? undefined,
      shopId: r.shopId ?? undefined,
    }));
  }
  const col = await usageCollection();
  const rows = (await col
    .find({
      provider,
      $or: [{ isRateLimited: true }, { statusCode: 429 }],
      timestamp: { $gte: since },
    })
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray()) as ApiUsageRecord[];
  return rows.map((r) => ({
    timestamp: r.timestamp,
    endpoint: r.endpoint,
    shopId: r.shopId ?? undefined,
  }));
}
