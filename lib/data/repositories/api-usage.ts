// Repository for the `api_usage` and `api_rate_limits` collections.
//
// These collections back the cross-worker rate limiter and the
// observability dashboards. Callers stay narrow: insert records,
// claim/release rate-limit slots, and run a small set of stats
// queries.
import type { Collection, Document, Filter, ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";

const USAGE_COLLECTION = "api_usage";
const RATE_LIMIT_COLLECTION = "api_rate_limits";

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
