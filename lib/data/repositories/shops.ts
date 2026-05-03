// Repository for the `shops` collection.
//
// Narrow API surface used by callers that previously reached into Mongo
// directly. Shop identity is messy in storage today — some docs keyed
// by numeric `shopId`, some by string. The lookup helpers preserve that
// behavior so callers don't have to.
import type { Collection, Filter, UpdateFilter } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "shops";

export interface ShopDoc {
  shopId: number | string;
  name?: string;
  [extra: string]: unknown;
}

function shopIdFilter(shopId: number | string): Filter<ShopDoc> {
  return { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] };
}

async function collection(): Promise<Collection<ShopDoc>> {
  const db = await getDb();
  return db.collection<ShopDoc>(COLLECTION);
}

export async function findShopByShopId(
  shopId: number | string,
  projection?: Record<string, 0 | 1>,
): Promise<ShopDoc | null> {
  const col = await collection();
  return col.findOne(shopIdFilter(shopId), projection ? { projection } : undefined);
}

export async function findShopByExactShopId(
  shopId: number,
  projection?: Record<string, 0 | 1>,
): Promise<ShopDoc | null> {
  const col = await collection();
  return col.findOne({ shopId }, projection ? { projection } : undefined);
}

export async function findShopByQuery(
  query: Filter<ShopDoc>,
  projection?: Record<string, 0 | 1>,
): Promise<ShopDoc | null> {
  const col = await collection();
  return col.findOne(query, projection ? { projection } : undefined);
}

export async function listShopsByQuery(
  query: Filter<ShopDoc>,
  projection?: Record<string, 0 | 1>,
): Promise<ShopDoc[]> {
  const col = await collection();
  const cursor = col.find(query);
  if (projection) cursor.project(projection);
  return cursor.toArray() as Promise<ShopDoc[]>;
}

export async function listShopsByShopIds(
  shopIds: number[],
  projection?: Record<string, 0 | 1>,
): Promise<ShopDoc[]> {
  return listShopsByQuery({ shopId: { $in: shopIds } }, projection);
}

export async function updateShopById(
  shopId: number | string,
  update: UpdateFilter<ShopDoc>,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const col = await collection();
  const res = await col.updateOne(shopIdFilter(shopId), update);
  return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
}
