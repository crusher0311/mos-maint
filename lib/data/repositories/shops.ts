// Repository for the `shops` collection.
//
// Narrow API surface used by callers that previously reached into Mongo
// directly. Shop identity is messy in storage today — some docs keyed
// by numeric `shopId`, some by string. The lookup helpers preserve that
// behavior so callers don't have to.
import type { Collection, Document, Filter, UpdateFilter } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "shops";

export interface ShopDoc extends Document {
  shopId: number | string;
  // Some legacy shop docs are keyed off `id` (the integer primary key
  // from the originating system) instead of `shopId`. A handful of
  // platform-admin code paths look up by that field.
  id?: number;
  name?: string;
  locationIdentifier?: string;
  [extra: string]: unknown;
}

type ShopFilter = Filter<Document>;
type ShopUpdate = UpdateFilter<Document>;
type ShopProjection = Record<string, 0 | 1>;

export async function listShopsByLegacyIds(
  ids: number[],
  projection?: ShopProjection,
): Promise<ShopDoc[]> {
  return listShopsByQuery({ id: { $in: ids } }, projection);
}

function shopIdFilter(shopId: number | string): ShopFilter {
  return { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] };
}

async function collection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(COLLECTION);
}

export async function findShopByShopId<T extends ShopDoc = ShopDoc>(
  shopId: number | string,
  projection?: ShopProjection,
): Promise<T | null> {
  const col = await collection();
  const doc = await col.findOne(
    shopIdFilter(shopId),
    projection ? { projection } : undefined,
  );
  return (doc as T | null) ?? null;
}

export async function findShopByExactShopId<T extends ShopDoc = ShopDoc>(
  shopId: number,
  projection?: ShopProjection,
): Promise<T | null> {
  const col = await collection();
  const doc = await col.findOne({ shopId }, projection ? { projection } : undefined);
  return (doc as T | null) ?? null;
}

export async function findShopByQuery(
  query: ShopFilter,
  projection?: ShopProjection,
): Promise<ShopDoc | null> {
  const col = await collection();
  return (await col.findOne(
    query,
    projection ? { projection } : undefined,
  )) as ShopDoc | null;
}

export async function listShopsByQuery(
  query: ShopFilter,
  projection?: ShopProjection,
): Promise<ShopDoc[]> {
  const col = await collection();
  const cursor = col.find(query);
  if (projection) cursor.project(projection);
  return (await cursor.toArray()) as ShopDoc[];
}

export async function listShopsByShopIds(
  shopIds: number[],
  projection?: ShopProjection,
): Promise<ShopDoc[]> {
  return listShopsByQuery({ shopId: { $in: shopIds } }, projection);
}

export async function updateShopById(
  shopId: number | string,
  update: ShopUpdate,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const col = await collection();
  const res = await col.updateOne(shopIdFilter(shopId), update);
  return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
}
