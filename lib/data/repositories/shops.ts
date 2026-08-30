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

export const __laborRateRuleDeps = {
  isIdentityPgCanonical,
  findPgShop: pg.findShopByMosShopId,
  listPgShops: pg.listShopsByMosShopIds,
  replacePgLaborRateRules: pg.replaceLaborRateRulesForShopIds,
  replacePgLaborRateRulesIfRevision: pg.replaceLaborRateRulesForShopIdIfRevision,
  getCollection: collection,
};

export const __sharedSettingsDeps = {
  isIdentityPgCanonical,
  updatePgShopFields: pg.updateShopFields,
  replacePgLaborRateRules: pg.replaceLaborRateRulesForShopIds,
  getCollection: collection,
};

/** Complete-path replacement used by the shared enterprise settings catalog. */
export async function replaceSharedSettingsForShop(
  shopId: number,
  fields: Record<string, unknown>,
): Promise<{ matchedCount: number; modifiedCount: number }> {
  const replacesLaborRates = Object.prototype.hasOwnProperty.call(fields, "laborRateRules");
  if (__sharedSettingsDeps.isIdentityPgCanonical()) {
    let result: {
      matchedCount: number;
      modifiedCount: number;
      revisions?: Record<number, number>;
    };
    if (replacesLaborRates) {
      const laborResult = await __sharedSettingsDeps.replacePgLaborRateRules(
        [shopId],
        Array.isArray(fields.laborRateRules) ? fields.laborRateRules : [],
      );
      if (laborResult.matchedCount !== 1) return laborResult;
      const remainingFields = { ...fields };
      delete remainingFields.laborRateRules;
      if (Object.keys(remainingFields).length > 0) {
        const settingsResult = await __sharedSettingsDeps.updatePgShopFields(
          shopId,
          remainingFields,
        );
        result = { ...settingsResult, revisions: laborResult.revisions };
      } else {
        result = laborResult;
      }
    } else {
      result = await __sharedSettingsDeps.updatePgShopFields(shopId, fields);
    }
    if (result.matchedCount !== 1) return result;

    // These settings still have live Mongo-backed readers (including sticker
    // rendering and location-level forms). Keep their observable store in sync
    // and surface a failure rather than reporting a copy that users cannot see.
    const col = await __sharedSettingsDeps.getCollection();
    const mongoResult = await col.updateOne(
      { $or: [{ shopId }, { shopId: String(shopId) }] },
      {
        $set: {
          ...fields,
          updatedAt: new Date(),
          ...(replacesLaborRates && result.revisions?.[shopId] !== undefined
            ? { laborRateRulesRevision: result.revisions[shopId] }
            : {}),
        },
        ...(replacesLaborRates && result.revisions?.[shopId] === undefined
          ? { $inc: { laborRateRulesRevision: 1 } }
          : {}),
      },
    );
    if (mongoResult.matchedCount !== 1) {
      throw new Error(`Mongo settings shadow not found for shop ${shopId}`);
    }
    return result;
  }
  const col = await __sharedSettingsDeps.getCollection();
  const result = await col.updateOne(
    { $or: [{ shopId }, { shopId: String(shopId) }] },
    {
      $set: { ...fields, updatedAt: new Date() },
      ...(replacesLaborRates ? { $inc: { laborRateRulesRevision: 1 } } : {}),
    },
  );
  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
  };
}

/**
 * Sticker rendering checks this Mongo-backed binary cache before config URLs.
 * Replace (or clear) it with the sticker category so an old destination logo
 * cannot shadow the newly copied settings. There is no canonical PG table for
 * shop media.
 */
export async function replaceShopLogoMedia(
  sourceShopId: number,
  destinationShopId: number,
): Promise<void> {
  const db = await getDb();
  const media = db.collection("shop_media");
  const source = await media.findOne({
    shopId: { $in: [sourceShopId, String(sourceShopId)] },
    type: "logo",
  });
  const destinationFilter = {
    shopId: { $in: [destinationShopId, String(destinationShopId)] },
    type: "logo",
  };
  if (!source?.dataUri) {
    await media.deleteMany(destinationFilter);
    return;
  }
  await media.updateOne(
    destinationFilter,
    {
      $set: {
        shopId: destinationShopId,
        type: "logo",
        dataUri: source.dataUri,
        contentType: source.contentType || "image/png",
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
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
  if (__laborRateRuleDeps.isIdentityPgCanonical()) {
    // Projection ignored (full doc is a safe superset).
    return (await __laborRateRuleDeps.listPgShops(shopIds)) as unknown as ShopDoc[];
  }
  const col = await __laborRateRuleDeps.getCollection();
  const cursor = col.find({
    shopId: { $in: [...shopIds, ...shopIds.map(String)] },
  });
  if (projection) cursor.project(projection);
  return (await cursor.toArray()) as unknown as ShopDoc[];
}

export async function listAllShops(): Promise<ShopDoc[]> {
  if (isIdentityPgCanonical()) {
    return (await pg.listAllShops()) as unknown as ShopDoc[];
  }
  return listShopsByQuery({});
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

export async function listShopLaborRateRulesByIds(
  shopIds: number[],
): Promise<Array<{
  shopId: number | string;
  name?: string;
  locationIdentifier?: string;
  laborRateRules?: unknown[];
  laborRateRulesRevision?: number;
}>> {
  if (__laborRateRuleDeps.isIdentityPgCanonical()) {
    return (await __laborRateRuleDeps.listPgShops(shopIds)) as unknown as Array<{
      shopId: number | string;
      name?: string;
      locationIdentifier?: string;
      laborRateRules?: unknown[];
      laborRateRulesRevision?: number;
    }>;
  }
  const col = await __laborRateRuleDeps.getCollection();
  const stringShopIds = shopIds.map(String);
  const docs = await col.find(
    {
      $or: [
        { shopId: { $in: shopIds } },
        { shopId: { $in: stringShopIds } },
      ],
    },
    {
      projection: {
        shopId: 1,
        name: 1,
        locationIdentifier: 1,
        laborRateRules: 1,
        laborRateRulesRevision: 1,
      },
    },
  ).toArray();
  return docs as unknown as Array<{
    shopId: number | string;
    name?: string;
    locationIdentifier?: string;
    laborRateRules?: unknown[];
    laborRateRulesRevision?: number;
  }>;
}

export async function findShopLaborRateRulesById(
  shopId: number,
): Promise<{
  shopId: number | string;
  name?: string;
  shopName?: string;
  laborRateRules?: unknown[];
  laborRateRulesRevision?: number;
} | null> {
  if (__laborRateRuleDeps.isIdentityPgCanonical()) {
    return await __laborRateRuleDeps.findPgShop(shopId) as {
      shopId: number | string;
      name?: string;
      shopName?: string;
      laborRateRules?: unknown[];
      laborRateRulesRevision?: number;
    } | null;
  }
  const col = await __laborRateRuleDeps.getCollection();
  return await col.findOne(
    { $or: [{ shopId }, { shopId: String(shopId) }] },
    { projection: { shopId: 1, name: 1, shopName: 1, laborRateRules: 1, laborRateRulesRevision: 1 } },
  ) as {
    shopId: number | string;
    name?: string;
    shopName?: string;
    laborRateRules?: unknown[];
    laborRateRulesRevision?: number;
  } | null;
}

export async function replaceLaborRateRulesForShopIds(
  shopIds: number[],
  laborRateRules: unknown[],
): Promise<{
  matchedCount: number;
  modifiedCount: number;
  revisions?: Record<number, number>;
}> {
  if (shopIds.length === 0) return { matchedCount: 0, modifiedCount: 0 };
  if (__laborRateRuleDeps.isIdentityPgCanonical()) {
    return __laborRateRuleDeps.replacePgLaborRateRules(shopIds, laborRateRules);
  }
  const col = await __laborRateRuleDeps.getCollection();
  const stringShopIds = shopIds.map(String);
  const result = await col.updateMany(
    {
      $or: [
        { shopId: { $in: shopIds } },
        { shopId: { $in: stringShopIds } },
      ],
    },
    {
      $set: { laborRateRules, updatedAt: new Date() },
      $inc: { laborRateRulesRevision: 1 },
    },
  );
  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
  };
}

export async function replaceLaborRateRulesForShopIdIfRevision(
  shopId: number,
  laborRateRules: unknown[],
  expectedRevision: number,
): Promise<{ matchedCount: number; modifiedCount: number; revision?: number }> {
  if (__laborRateRuleDeps.isIdentityPgCanonical()) {
    return __laborRateRuleDeps.replacePgLaborRateRulesIfRevision(
      shopId,
      laborRateRules,
      expectedRevision,
    );
  }
  const col = await __laborRateRuleDeps.getCollection();
  const revisionFilter = expectedRevision === 0
    ? {
        $or: [
          { laborRateRulesRevision: 0 },
          { laborRateRulesRevision: { $exists: false } },
          { laborRateRulesRevision: null },
        ],
      }
    : { laborRateRulesRevision: expectedRevision };
  const result = await col.updateOne(
    {
      $and: [
        { $or: [{ shopId }, { shopId: String(shopId) }] },
        revisionFilter,
      ],
    },
    {
      $set: { laborRateRules, updatedAt: new Date() },
      $inc: { laborRateRulesRevision: 1 },
    },
  );
  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    ...(result.matchedCount === 1 ? { revision: expectedRevision + 1 } : {}),
  };
}
