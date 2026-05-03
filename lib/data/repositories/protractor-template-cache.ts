// Repository for the `protractor_template_cache` collection.
//
// Per-template (per-shop) cache of `/ServicePackageTemplate/Read/{id}`
// responses. Stores both successful payloads and 404 markers, each with
// its own TTL (handled by `expiresAt`).
import type { Collection } from "mongodb";
import { getDb } from "@/lib/data/db";

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

async function collection(): Promise<Collection<ProtractorTemplateCacheDoc>> {
  const db = await getDb();
  return db.collection<ProtractorTemplateCacheDoc>(COLLECTION);
}

export async function findFreshTemplateCacheEntry(
  cacheKey: string,
): Promise<ProtractorTemplateCacheDoc | null> {
  const col = await collection();
  return col.findOne({ cacheKey, expiresAt: { $gt: new Date() } });
}

export async function upsertTemplateCacheEntry(
  entry: ProtractorTemplateCacheDoc,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { cacheKey: entry.cacheKey },
    { $set: entry },
    { upsert: true },
  );
}
