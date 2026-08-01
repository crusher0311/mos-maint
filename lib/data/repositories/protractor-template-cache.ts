// Repository for the `protractor_template_cache` collection.
//
// Per-template (per-shop) cache of `/ServicePackageTemplate/Read/{id}`
// responses. Stores both successful payloads and 404 markers, each with
// its own TTL (handled by `expiresAt`).
//
// Task #999: reads/writes dispatch to Postgres when
// `PROTRACTOR_OPS_PG_CANONICAL=1`, with a Mongo shadow write during the
// soak window (`WRITE_MONGO_PROTRACTOR_OPS`). Default flag OFF keeps
// Mongo canonical — byte-identical to prior behavior.
import type { Collection } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isProtractorOpsPgCanonical,
  shouldShadowWriteMongoProtractorOps,
  shadowWriteMongoIntegrationOps,
} from "@/lib/db/integration-ops-write-mode";
import * as pg from "./pg/protractor-template-cache";

const COLLECTION = "protractor_template_cache";

export interface ProtractorTemplateCacheDoc {
  cacheKey: string;
  shopId: number;
  templateId: string;
  template: any | null;
  is404: boolean;
  fetchedAt: Date;
  expiresAt: Date;
}

export interface TemplateCacheShopStats {
  shopId: number;
  total: number;
  cached: number;
  notFound: number;
}

async function collection(): Promise<Collection<ProtractorTemplateCacheDoc>> {
  const db = await getDb();
  return db.collection<ProtractorTemplateCacheDoc>(COLLECTION);
}

export async function findFreshTemplateCacheEntry(
  cacheKey: string,
): Promise<ProtractorTemplateCacheDoc | null> {
  if (isProtractorOpsPgCanonical()) {
    return pg.findFreshTemplateCacheEntry(cacheKey);
  }
  return findFreshTemplateCacheEntryMongo(cacheKey);
}

async function findFreshTemplateCacheEntryMongo(
  cacheKey: string,
): Promise<ProtractorTemplateCacheDoc | null> {
  const col = await collection();
  return col.findOne({ cacheKey, expiresAt: { $gt: new Date() } });
}

export async function upsertTemplateCacheEntry(
  entry: ProtractorTemplateCacheDoc,
): Promise<void> {
  if (isProtractorOpsPgCanonical()) {
    await pg.upsertTemplateCacheEntry(entry);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.template_cache.upsert",
      () => upsertTemplateCacheEntryMongo(entry),
    );
    return;
  }
  await upsertTemplateCacheEntryMongo(entry);
}

async function upsertTemplateCacheEntryMongo(
  entry: ProtractorTemplateCacheDoc,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { cacheKey: entry.cacheKey },
    { $set: entry },
    { upsert: true },
  );
}

// Admin maintenance: bulk clear (optionally scoped to a shop / 404s only).
export async function clearTemplateCache(opts: {
  shopId?: number | null;
  clear404sOnly?: boolean;
}): Promise<number> {
  if (isProtractorOpsPgCanonical()) {
    const cleared = await pg.clearTemplateCache(opts);
    await shadowWriteMongoIntegrationOps(
      shouldShadowWriteMongoProtractorOps,
      "protractor.template_cache.clear",
      () => clearTemplateCacheMongo(opts),
    );
    return cleared;
  }
  return clearTemplateCacheMongo(opts);
}

async function clearTemplateCacheMongo(opts: {
  shopId?: number | null;
  clear404sOnly?: boolean;
}): Promise<number> {
  const col = await collection();
  const filter: Record<string, any> = {};
  if (opts.shopId != null) filter.shopId = opts.shopId;
  if (opts.clear404sOnly) filter.is404 = true;
  const result = await col.deleteMany(filter);
  return result.deletedCount ?? 0;
}

// Admin diagnostics: per-shop cached / not-found template counts.
export async function templateCacheStats(): Promise<TemplateCacheShopStats[]> {
  if (isProtractorOpsPgCanonical()) return pg.templateCacheStats();
  const col = await collection();
  const stats = await col
    .aggregate<{
      _id: number;
      total: number;
      cached: number;
      notFound: number;
    }>([
      {
        $group: {
          _id: { shopId: "$shopId", is404: "$is404" },
          count: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: "$_id.shopId",
          total: { $sum: "$count" },
          cached: {
            $sum: { $cond: [{ $eq: ["$_id.is404", false] }, "$count", 0] },
          },
          notFound: {
            $sum: { $cond: [{ $eq: ["$_id.is404", true] }, "$count", 0] },
          },
        },
      },
      { $sort: { total: -1 } },
    ])
    .toArray();
  return stats.map((s) => ({
    shopId: s._id,
    total: s.total,
    cached: s.cached,
    notFound: s.notFound,
  }));
}
