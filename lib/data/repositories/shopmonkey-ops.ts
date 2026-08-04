// Repository for the Shopmonkey OPERATIONAL backfill-progress store
// (task #1030).
//
// Backs the Mongo `shopmonkey_backfill_progress` collection — the per-shop
// backfill progress + in-flight-lock bookkeeping written by
// `lib/integrations/shopmonkey/full-page-backfill.ts` / `inflight-lock.ts`
// and consumed by `lib/backfill/trigger.ts` and the admin sync-health view.
//
// Mongo-only for now: unlike the Tekmetric/Protractor/Shop-Ware ops stores
// this one has no PG cutover flag yet (the Shopmonkey fleet is 0-1 shops).
// When Shopmonkey joins the `<INT>_OPS_PG_CANONICAL` family, add the same
// dispatch layer the other `*-ops` repos use.

import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "shopmonkey_backfill_progress";

export type AnyDoc = Record<string, unknown>;

export interface ProgressUpdate {
  set?: AnyDoc;
  inc?: Record<string, number>;
  setOnInsert?: AnyDoc;
  unset?: string[];
}

async function collection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(COLLECTION);
}

/** Read one shop's progress doc (keyed by numeric shopId). */
export async function findShopmonkeyBackfillProgress(
  shopId: number,
): Promise<AnyDoc | null> {
  const col = await collection();
  return (await col.findOne({ shopId })) as AnyDoc | null;
}

/** Read all progress docs (admin sync-health view). */
export async function findAllShopmonkeyBackfillProgress(): Promise<AnyDoc[]> {
  const col = await collection();
  return (await col.find({}).toArray()) as AnyDoc[];
}

/** Upsert/patch one shop's progress doc (backfill trigger reset path). */
export async function updateShopmonkeyBackfillProgress(
  shopId: number,
  update: ProgressUpdate,
  options: { upsert?: boolean } = {},
): Promise<void> {
  const col = await collection();
  const mongoUpdate: AnyDoc = {};
  if (update.set && Object.keys(update.set).length > 0) mongoUpdate.$set = update.set;
  if (update.inc && Object.keys(update.inc).length > 0) mongoUpdate.$inc = update.inc;
  if (update.setOnInsert && Object.keys(update.setOnInsert).length > 0) {
    mongoUpdate.$setOnInsert = update.setOnInsert;
  }
  if (update.unset && update.unset.length > 0) {
    mongoUpdate.$unset = Object.fromEntries(update.unset.map((k) => [k, ""]));
  }
  if (Object.keys(mongoUpdate).length === 0) return;
  await col.updateOne({ shopId }, mongoUpdate, { upsert: !!options.upsert });
}

/**
 * Summary of every connected Shopmonkey shop for the admin sync-health view:
 * connection metadata + id-detection state off the shop doc, plus how many
 * order rows (webhook or sync sourced) we hold in `shopmonkey_work_orders`.
 * Never exposes the API key.
 */
export interface ShopmonkeyShopSummary {
  shopId: number;
  name: string | null;
  locationId: string | null;
  companyId: string | null;
  locationIdSource: string | null;
  companyIdSource: string | null;
  idsValidation: AnyDoc | null;
  connectedAt: Date | null;
  lastSyncAt: Date | null;
  cachedOrderCount: number;
  lastOrderReceivedAt: Date | null;
}

export async function findShopmonkeyShopSummaries(): Promise<ShopmonkeyShopSummary[]> {
  const db = await getDb();
  const shops = await db
    .collection("shops")
    .find(
      { "shopmonkey.apiKey": { $exists: true, $ne: null } },
      {
        projection: {
          shopId: 1,
          name: 1,
          "shopmonkey.locationId": 1,
          "shopmonkey.companyId": 1,
          "shopmonkey.locationIdSource": 1,
          "shopmonkey.companyIdSource": 1,
          "shopmonkey.idsValidation": 1,
          "shopmonkey.connectedAt": 1,
          "shopmonkey.lastSyncAt": 1,
          _id: 0,
        },
      },
    )
    .toArray();

  const summaries: ShopmonkeyShopSummary[] = [];
  for (const s of shops as any[]) {
    if (s?.shopId == null) continue;
    const shopIdNum = Number(s.shopId);
    // shopmonkey_work_orders stores shopId as STRING (webhook writer).
    const [count, latest] = await Promise.all([
      db.collection("shopmonkey_work_orders").countDocuments({
        shopId: { $in: [String(shopIdNum), shopIdNum] as any[] },
      }),
      db
        .collection("shopmonkey_work_orders")
        .find({ shopId: { $in: [String(shopIdNum), shopIdNum] as any[] } })
        .sort({ updatedAt: -1 })
        .limit(1)
        .project({ updatedAt: 1, _id: 0 })
        .toArray(),
    ]);
    summaries.push({
      shopId: shopIdNum,
      name: s.name ?? null,
      locationId: s.shopmonkey?.locationId ?? null,
      companyId: s.shopmonkey?.companyId ?? null,
      locationIdSource: s.shopmonkey?.locationIdSource ?? null,
      companyIdSource: s.shopmonkey?.companyIdSource ?? null,
      idsValidation: s.shopmonkey?.idsValidation ?? null,
      connectedAt: s.shopmonkey?.connectedAt ?? null,
      lastSyncAt: s.shopmonkey?.lastSyncAt ?? null,
      cachedOrderCount: count,
      lastOrderReceivedAt: latest[0]?.updatedAt ?? null,
    });
  }
  return summaries;
}
