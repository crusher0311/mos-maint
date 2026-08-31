// Repository for the `platform_features` collection.
//
// Platform features are the global feature catalog (what features
// exist, which tier they belong to, display order, pricing, etc.).
// The per-shop on/off state lives in `shop_features` and already has
// its own repository.
import type {
  AnyBulkWriteOperation,
  Collection,
  Filter,
  UpdateFilter,
  WithId,
} from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "platform_features";

export interface PlatformFeatureDoc {
  _id?: ObjectId;
  order?: number;
  name?: string;
  slug?: string;
  description?: string;
  category?: string;
  status?: string;
  icon?: string;
  compatibleSMS?: string[];
  includedInTiers?: string[];
  stripeProductId?: string;
  stripePriceId?: string;
  pricePerMonth?: number;
  requiresFeature?: string;
  bundledFeatures?: string[];
  bundledWith?: string;
  createdAt?: Date;
  updatedAt?: Date;
  [extra: string]: unknown;
}

async function collection(): Promise<Collection<PlatformFeatureDoc>> {
  const db = await getDb();
  return db.collection<PlatformFeatureDoc>(COLLECTION);
}

export async function listPlatformFeatures(
  filter: Filter<PlatformFeatureDoc> = {},
  options: {
    sort?: Record<string, 1 | -1>;
    projection?: Record<string, 0 | 1>;
  } = {},
): Promise<WithId<PlatformFeatureDoc>[]> {
  const col = await collection();
  const cursor = col.find(filter).sort(options.sort ?? { order: 1 });
  if (options.projection) cursor.project(options.projection);
  return cursor.toArray();
}

export async function findPlatformFeatureBySlug(
  slug: string,
): Promise<WithId<PlatformFeatureDoc> | null> {
  const col = await collection();
  return col.findOne({ slug });
}

export async function findPlatformFeatureById(
  id: string | ObjectId,
): Promise<WithId<PlatformFeatureDoc> | null> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const col = await collection();
  return col.findOne({ _id } as Filter<PlatformFeatureDoc>);
}

export async function findPlatformFeaturesByIds(
  ids: (string | ObjectId)[],
): Promise<WithId<PlatformFeatureDoc>[]> {
  if (ids.length === 0) return [];
  const objectIds = ids.map((id) => (typeof id === "string" ? new ObjectId(id) : id));
  const col = await collection();
  return col
    .find({ _id: { $in: objectIds } } as Filter<PlatformFeatureDoc>)
    .toArray();
}

export async function findHighestOrderedPlatformFeature(): Promise<WithId<PlatformFeatureDoc> | null> {
  const col = await collection();
  return col.findOne({}, { sort: { order: -1 } });
}

export async function insertPlatformFeature(
  doc: PlatformFeatureDoc,
): Promise<ObjectId> {
  const col = await collection();
  const res = await col.insertOne(doc);
  return res.insertedId as ObjectId;
}

export async function insertPlatformFeatures(
  docs: PlatformFeatureDoc[],
): Promise<number> {
  if (docs.length === 0) return 0;
  const col = await collection();
  const res = await col.insertMany(docs);
  return res.insertedCount;
}

/**
 * Add newly introduced canonical features without changing any existing
 * administrator-managed catalog row.
 */
export async function insertMissingPlatformFeatures(
  docs: PlatformFeatureDoc[],
): Promise<number> {
  if (docs.length === 0) return 0;
  const col = await collection();
  const res = await col.bulkWrite(
    docs
      .filter((doc): doc is PlatformFeatureDoc & { slug: string } => Boolean(doc.slug))
      .map((doc) => ({
        updateOne: {
          filter: { slug: doc.slug },
          update: { $setOnInsert: doc },
          upsert: true,
        },
      })),
  );
  return res.upsertedCount ?? 0;
}

export async function updatePlatformFeatureById(
  id: string | ObjectId,
  update: UpdateFilter<PlatformFeatureDoc>,
  options: { returnDocument?: "before" | "after" } = {},
): Promise<WithId<PlatformFeatureDoc> | null> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const col = await collection();
  return col.findOneAndUpdate(
    { _id } as Filter<PlatformFeatureDoc>,
    update,
    { returnDocument: options.returnDocument ?? "after" },
  );
}

export async function deletePlatformFeatureById(
  id: string | ObjectId,
): Promise<{ deletedCount: number }> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const col = await collection();
  const res = await col.deleteOne({ _id } as Filter<PlatformFeatureDoc>);
  return { deletedCount: res.deletedCount };
}

export async function countPlatformFeatures(
  filter: Filter<PlatformFeatureDoc> = {},
): Promise<number> {
  const col = await collection();
  return col.countDocuments(filter);
}

/**
 * Run a single bulkWrite against `platform_features` — used by the
 * reorder + bulk-tier-update routes which need to apply many
 * `updateOne` ops in one round-trip.
 */
export async function bulkWritePlatformFeatures(
  ops: AnyBulkWriteOperation<PlatformFeatureDoc>[],
): Promise<{ modifiedCount: number }> {
  if (ops.length === 0) return { modifiedCount: 0 };
  const col = await collection();
  const res = await col.bulkWrite(ops);
  return { modifiedCount: res.modifiedCount ?? 0 };
}
