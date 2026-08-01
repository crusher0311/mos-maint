// Repository for the advisory `dvi` and `dvi_results` Mongo collections
// (task #1000, PACKAGE 2).
//
// DVI is ADVISORY-ONLY data (never a history anchor). `dvi` is written
// by the AutoFlow DVI import (`lib/integrations/dvi.ts`); `dvi_results`
// is the per-RO snapshot written by the AutoFlow client + enriched with
// a primary-SMS cross-reference by the AutoFlow webhook. This repository
// exposes the narrow read/write shapes the app needs so route + client
// code never reaches into the Mongo driver directly for these two
// collections (enforced by `scripts/check-direct-db.cjs`).
//
// Every public helper is gated on `isDviPgCanonical()`. When OFF
// (default), the original Mongo body runs verbatim (zero behaviour
// change). When ON, reads go to the Postgres mirror (lib/db/schema/
// wave3.ts) and writes replay the Mongo write via
// `shadowWriteMongoLegacyStore` while `shouldShadowWriteMongoDvi()` is
// on. Read semantics (query shape, sort, projection) are preserved
// exactly across both paths.
import type { Document } from "mongodb";
import { getDb } from "@/lib/mongo";
import {
  isDviPgCanonical,
  shouldShadowWriteMongoDvi,
  shadowWriteMongoLegacyStore,
} from "@/lib/db/legacy-store-write-mode";
import * as pg from "./pg/dvi";

type AnyDoc = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* dvi writes (importDVI)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Inserts one or more `dvi` docs. Callers pass the exact doc shape they
 * previously handed to `db.collection("dvi").insertOne/insertMany`.
 */
export async function insertDvi(docs: AnyDoc[]): Promise<void> {
  if (!docs.length) return;
  if (isDviPgCanonical()) {
    await pg.insertDviDocs(docs);
    if (shouldShadowWriteMongoDvi()) {
      await shadowWriteMongoLegacyStore("dvi.insert", () => insertDviMongo(docs));
    }
    return;
  }
  await insertDviMongo(docs);
}

async function insertDviMongo(docs: AnyDoc[]): Promise<void> {
  const db = await getDb();
  if (docs.length === 1) {
    await db.collection("dvi").insertOne(docs[0] as Document);
  } else {
    await db.collection("dvi").insertMany(docs as Document[]);
  }
}

/* -------------------------------------------------------------------------- */
/* dvi_results snapshot upsert (autoflow/client.ts)                            */
/* -------------------------------------------------------------------------- */

/**
 * Upserts a `dvi_results` snapshot keyed by (shopId, roNumber). `set`
 * is the `$set` doc; `setOnInsert` is the `$setOnInsert` doc.
 */
export async function upsertDviResult(
  shopId: number,
  roNumber: string,
  set: AnyDoc,
  setOnInsert: AnyDoc,
): Promise<void> {
  if (isDviPgCanonical()) {
    await pg.upsertDviResultSnapshot(shopId, roNumber, set, setOnInsert);
    if (shouldShadowWriteMongoDvi()) {
      await shadowWriteMongoLegacyStore("dvi_results.upsert", () =>
        upsertDviResultMongo(shopId, roNumber, set, setOnInsert),
      );
    }
    return;
  }
  await upsertDviResultMongo(shopId, roNumber, set, setOnInsert);
}

async function upsertDviResultMongo(
  shopId: number,
  roNumber: string,
  set: AnyDoc,
  setOnInsert: AnyDoc,
): Promise<void> {
  const db = await getDb();
  await db.collection("dvi_results").updateOne(
    { shopId, roNumber },
    { $set: set, $setOnInsert: setOnInsert },
    { upsert: true },
  );
}

/* -------------------------------------------------------------------------- */
/* dvi_results cross-reference update (autoflow/webhook.ts)                    */
/* -------------------------------------------------------------------------- */

/**
 * Applies the primary-SMS cross-reference fields to the snapshot(s)
 * matching (shopId, roNumber). `shopIdVariants`/`roVariants` carry the
 * string/number `$in`/`$or` variants the legacy Mongo query used.
 * Returns the matched count.
 */
export async function updateDviResultCrossRef(
  shopId: number,
  roNumber: string,
  set: AnyDoc,
  shopIdVariants: unknown[],
  roVariants: unknown[],
): Promise<number> {
  if (isDviPgCanonical()) {
    const matched = await pg.updateDviResultCrossRef(shopId, roNumber, set);
    if (shouldShadowWriteMongoDvi()) {
      await shadowWriteMongoLegacyStore("dvi_results.crossRef", () =>
        updateDviResultCrossRefMongo(set, shopIdVariants, roVariants),
      );
    }
    return matched;
  }
  return updateDviResultCrossRefMongo(set, shopIdVariants, roVariants);
}

async function updateDviResultCrossRefMongo(
  set: AnyDoc,
  shopIdVariants: unknown[],
  roVariants: unknown[],
): Promise<number> {
  const db = await getDb();
  const res = await db.collection("dvi_results").updateOne(
    {
      shopId: { $in: shopIdVariants },
      $or: roVariants.map((ro) => ({ roNumber: ro })),
    },
    { $set: set },
  );
  return res.matchedCount;
}

/* -------------------------------------------------------------------------- */
/* dvi_results reads                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Finds a `dvi_results` snapshot by (shopId, roNumber), matching either
 * string or number forms of each. Used by the DVI cache read and the
 * extension ro-context / plan routes.
 */
export async function findDviResultByRo(
  shopId: string | number,
  roNumber: string | number,
): Promise<Document | null> {
  if (isDviPgCanonical()) {
    return (await pg.findDviResultByRo(
      Number(shopId),
      String(roNumber),
    )) as Document | null;
  }
  return findDviResultByRoMongo(shopId, roNumber);
}

async function findDviResultByRoMongo(
  shopId: string | number,
  roNumber: string | number,
): Promise<Document | null> {
  const db = await getDb();
  return db.collection("dvi_results").findOne({
    shopId: { $in: [Number(shopId), String(shopId)] },
    roNumber: { $in: [roNumber, String(roNumber)] },
  });
}

/**
 * Finds the most recent `dvi_results` snapshot matching (shopId,
 * roNumber) OR (shopId, vin), sorted newest-first by `fetchedAt`. Used
 * by the additive AutoFlow DVI lookup in ro-context.
 */
export async function findLatestDviResultByRoOrVin(
  shopId: string | number,
  roNumber: string | number,
  vin: string | null,
): Promise<Document | null> {
  if (isDviPgCanonical()) {
    return (await pg.findLatestDviResultByRoOrVin(
      Number(shopId),
      String(roNumber),
      vin ? vin.toUpperCase() : null,
    )) as Document | null;
  }
  return findLatestDviResultByRoOrVinMongo(shopId, roNumber, vin);
}

async function findLatestDviResultByRoOrVinMongo(
  shopId: string | number,
  roNumber: string | number,
  vin: string | null,
): Promise<Document | null> {
  const db = await getDb();
  const query: AnyDoc = {
    shopId: { $in: [shopId, String(shopId), Number(shopId)] },
    $or: [{ roNumber: String(roNumber) }, { roNumber }],
  };
  if (vin) {
    (query.$or as AnyDoc[]).push({ vin: vin.toUpperCase() });
  }
  return db
    .collection("dvi_results")
    .findOne(query, { sort: { fetchedAt: -1 } });
}
