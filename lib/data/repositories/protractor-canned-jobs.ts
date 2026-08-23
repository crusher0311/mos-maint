// Repository for the `protractor_canned_jobs` collection.
//
// One row per shop holding the cached canned-job (service package
// template) list. Three writers:
//   - `upsertCannedJobsCache` — bulk replace summary list
//   - `saveBasicCannedJobsList` — fast initial save before enrichment
//   - `saveEnrichedCannedJobs` — background enrichment write
import type { Collection, UpdateFilter } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "protractor_canned_jobs";

export interface ProtractorCannedJobsCacheDoc {
  shopId: number;
  items: unknown[];
  fetchedAt: Date;
  source?: "api" | "enriched" | string;
  // Task #925: which Protractor list endpoint produced the cached items
  // ("cannedjob" | "servicepackagetemplate"); lets the create-WO push path
  // dispatch detail fetches directly instead of trial-and-error.
  listSource?: string | null;
  createdAt?: Date;
}

async function collection(): Promise<Collection<ProtractorCannedJobsCacheDoc>> {
  const db = await getDb();
  return db.collection<ProtractorCannedJobsCacheDoc>(COLLECTION);
}

export async function findCannedJobsCacheByShopId(
  shopId: number,
): Promise<ProtractorCannedJobsCacheDoc | null> {
  const col = await collection();
  return col.findOne({ shopId });
}

export async function upsertCannedJobsSummary(
  shopId: number,
  items: unknown[],
  fetchedAt: Date,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId },
    {
      $set: { shopId, items, fetchedAt },
      $setOnInsert: { createdAt: fetchedAt },
    },
    { upsert: true },
  );
}

export async function upsertCannedJobsBasicList(
  shopId: number,
  items: unknown[],
  fetchedAt: Date,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId },
    {
      $set: { items, fetchedAt, source: "api" },
      $setOnInsert: { createdAt: fetchedAt },
    },
    { upsert: true },
  );
}

// Task #931 backfill sweep: list cache docs still missing `listSource`
// (matches both field-absent and explicit-null docs).
export async function findCannedJobsCachesMissingListSource(
  shopIds?: number[],
): Promise<Array<Pick<ProtractorCannedJobsCacheDoc, "shopId" | "source" | "fetchedAt">>> {
  const col = await collection();
  return col
    .find(
      {
        listSource: null,
        ...(shopIds && shopIds.length ? { shopId: { $in: shopIds } } : {}),
      },
      { projection: { shopId: 1, source: 1, fetchedAt: 1 } },
    )
    .toArray();
}

// Task #931: stamp `listSource` ONLY, and only if the doc is still
// untagged — never overwrites a value written by a concurrent sync/enrich,
// never touches items/source/fetchedAt. Returns true when a doc was updated.
export async function setCannedJobsCacheListSourceIfMissing(
  shopId: number,
  listSource: string,
): Promise<boolean> {
  const col = await collection();
  const res = await col.updateOne(
    { shopId, listSource: null },
    { $set: { listSource } },
  );
  return res.modifiedCount === 1;
}

export async function upsertCannedJobsEnriched(
  shopId: number,
  items: unknown[],
  fetchedAt: Date,
  options?: { setCreatedAt?: boolean },
): Promise<void> {
  const col = await collection();
  const update: UpdateFilter<ProtractorCannedJobsCacheDoc> = {
    $set: { items, fetchedAt, source: "enriched" },
  };
  if (options?.setCreatedAt) {
    update.$setOnInsert = { createdAt: fetchedAt };
  }
  await col.updateOne({ shopId }, update, { upsert: true });
}
