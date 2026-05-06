/**
 * Repository for `shop_dvi_best_practices` (per-shop DVI best-practice
 * blurbs, keyed by {shopId, serviceKey}, hard-capped at 140 chars).
 *
 * Extracted out of `lib/dvi-best-practices.ts` on 2026-05-06 to satisfy
 * the data-access lint rule (scripts/check-direct-db.cjs) which
 * forbids new direct getDb() calls outside the repository layer.
 * The original file in lib/ now keeps only pure helpers, constants,
 * and the DEFAULT_DVI_BEST_PRACTICES seed library, and re-exports
 * these functions for back-compat with existing call sites.
 */

import { Db } from "mongodb";
import { getDb } from "@/lib/mongo";
import {
  SHOP_DVI_BEST_PRACTICES_COLLECTION,
  DVI_BEST_PRACTICE_MAX_CHARS,
  type ShopDviBestPractice,
} from "@/lib/dvi-best-practices-types";

async function collection(db?: Db) {
  const _db = db ?? (await getDb());
  return _db.collection<ShopDviBestPractice>(SHOP_DVI_BEST_PRACTICES_COLLECTION);
}

export async function listShopDviBestPractices(
  shopId: number,
  db?: Db,
): Promise<ShopDviBestPractice[]> {
  const col = await collection(db);
  return col
    .find({ shopId: Number(shopId) })
    .sort({ serviceName: 1 })
    .toArray();
}

/**
 * `Map<serviceKey, blurb>` lookup for the plan page. Empty/whitespace
 * blurbs are filtered out so we never render an empty paragraph.
 */
export async function getShopDviBestPracticeMap(
  shopId: number,
  db?: Db,
): Promise<Map<string, string>> {
  const rows = await listShopDviBestPractices(shopId, db);
  const out = new Map<string, string>();
  for (const r of rows) {
    const t = String(r.blurb || "").trim();
    if (r.serviceKey && t) out.set(r.serviceKey, t.slice(0, DVI_BEST_PRACTICE_MAX_CHARS));
  }
  return out;
}

/**
 * Upsert a blurb for {shopId, serviceKey}. Returns {before, after} for
 * audit logging — `before` is the prior blurb (or null), `after` is the
 * new blurb. Empty `blurb` removes the entry so the lookup map stays small.
 */
export async function upsertShopDviBestPractice(args: {
  shopId: number;
  serviceKey: string;
  serviceName: string;
  blurb: string;
  updatedBy?: string | null;
  db?: Db;
}): Promise<{
  before: string | null;
  after: string | null;
  serviceKey: string;
  serviceName: string;
}> {
  const shopId = Number(args.shopId);
  const serviceKey = String(args.serviceKey || "").trim();
  if (!serviceKey) throw new Error("serviceKey is required");
  const serviceName = String(args.serviceName || serviceKey).trim();
  const blurb = String(args.blurb || "").trim().slice(0, DVI_BEST_PRACTICE_MAX_CHARS);

  const col = await collection(args.db);
  const existing = await col.findOne({ shopId, serviceKey });
  const before = existing?.blurb ?? null;

  if (!blurb) {
    if (existing) await col.deleteOne({ shopId, serviceKey });
    return { before, after: null, serviceKey, serviceName };
  }

  const now = new Date();
  await col.updateOne(
    { shopId, serviceKey },
    {
      $set: {
        shopId,
        serviceKey,
        serviceName,
        blurb,
        updatedAt: now,
        updatedBy: args.updatedBy ?? null,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  return { before, after: blurb, serviceKey, serviceName };
}

/** Explicit delete; returns the prior blurb (or null) for audit logging. */
export async function deleteShopDviBestPractice(args: {
  shopId: number;
  serviceKey: string;
  db?: Db;
}): Promise<{ before: string | null; serviceKey: string; serviceName: string | null }> {
  const shopId = Number(args.shopId);
  const serviceKey = String(args.serviceKey || "").trim();
  if (!serviceKey) throw new Error("serviceKey is required");
  const col = await collection(args.db);
  const existing = await col.findOne({ shopId, serviceKey });
  if (!existing) return { before: null, serviceKey, serviceName: null };
  await col.deleteOne({ shopId, serviceKey });
  return { before: existing.blurb ?? null, serviceKey, serviceName: existing.serviceName ?? null };
}
