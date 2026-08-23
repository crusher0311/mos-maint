// Repository for the `shops` collection.
//
// Narrow API surface used by callers that previously reached into Mongo
// directly. Shop identity is messy in storage today — some docs keyed
// by numeric `shopId`, some by string. The lookup helpers preserve that
// behavior so callers don't have to.
import type { Collection, Document, Filter, UpdateFilter } from "mongodb";
import { getDb } from "@/lib/data/db";
import { isIdentityPgCanonical } from "@/lib/db/wave4-write-mode";
import * as pg from "./pg/identity";

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
  if (isIdentityPgCanonical()) {
    // PG returns full Mongo-shaped shop docs; the `projection` is
    // ignored on the PG side because returning the whole doc is a safe
    // superset (the caller only reads the fields it asked for).
    return (await pg.listShopsByLegacyIds(ids)) as unknown as ShopDoc[];
  }
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
  if (isIdentityPgCanonical()) {
    // The Mongo lookup matches `shopId` as either string or number
    // (`shopIdFilter`); `findShopByMosShopId` coerces to Number and
    // matches the canonical `mos_shop_id` column, covering both. The
    // `projection` is ignored (full doc is a safe superset).
    return (await pg.findShopByMosShopId(shopId)) as unknown as T | null;
  }
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
  if (isIdentityPgCanonical()) {
    // Projection ignored (full doc is a safe superset).
    return (await pg.findShopByMosShopId(shopId)) as unknown as T | null;
  }
  const col = await collection();
  const doc = await col.findOne({ shopId }, projection ? { projection } : undefined);
  return (doc as T | null) ?? null;
}

// NOT flag-gated: accepts an arbitrary Mongo Filter whose only caller
// (app/api/webhooks/shopware/route.ts) queries nested integration
// settings — `{ "shopware.tenantId": … }` / `{ "shopware.swShopId": … }`
// — which live inside the `settings` jsonb in PG with no indexed column
// and no single translatable shape. Left Mongo-only until the shopware
// webhook is migrated to a typed PG lookup — see task 997.
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

// NOT flag-gated: accepts an arbitrary Mongo Filter. Real callers use
// untranslatable shapes — an `$or` over nested integration fields
// (`tekmetric.shopId`, `integrations.protractor.apiKey` existence,
// lib/api-usage-tracker.ts + lib/announcements.ts) and a `createdAt`
// range window (lib/integrations/protractor/new-shop-sweep.ts). None map
// to an indexed PG column or a single equality/`$in` shape, so this
// stays Mongo-only — see task 997.
export async function listShopsByQuery(
  query: ShopFilter,
  projection?: ShopProjection,
): Promise<ShopDoc[]> {
  const col = await collection();
  const cursor = col.find(query);
  if (projection) cursor.project(projection);
  return (await cursor.toArray()) as unknown as ShopDoc[];
}

export async function listShopsByShopIds(
  shopIds: number[],
  projection?: ShopProjection,
): Promise<ShopDoc[]> {
  if (isIdentityPgCanonical()) {
    // Projection ignored (full doc is a safe superset).
    return (await pg.listShopsByMosShopIds(shopIds)) as unknown as ShopDoc[];
  }
  return listShopsByQuery({ shopId: { $in: shopIds } }, projection);
}

// NOT flag-gated: no live callers in the app/lib tree (grep found
// none), and it takes an arbitrary Mongo UpdateFilter. Leaving it
// Mongo-only avoids adding an untested translation path with no
// exercising caller — see task 997.
export async function updateShopById(
  shopId: number | string,
  update: ShopUpdate,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const col = await collection();
  const res = await col.updateOne(shopIdFilter(shopId), update);
  return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
}
