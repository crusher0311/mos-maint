/**
 * Shopmonkey incremental sync — mirrors
 * lib/integrations/tekmetric/incremental-sync.ts.
 *
 * Drives the per-shop incremental sync cycle that keeps active Shopmonkey
 * orders fresh between webhooks. Delegates the actual fetch/normalize to the
 * registered ShopmonkeyAdapter (`runIncrementalSync`) so the mapping logic
 * lives in one place.
 *
 * PROD-SAFE GATING: this is a config-gated no-op. With zero Shopmonkey shops
 * configured (the current fleet state — no shop has `shopmonkey.apiKey`), the
 * cycle enumerates nothing and returns immediately. It never runs a real fleet
 * backfill and never touches a shop that hasn't opted into Shopmonkey.
 */

import { getDb } from "@/lib/mongo";
import { shopmonkeyAdapter } from "./adapter";
import type { SyncResult } from "@/lib/integrations/core/types";

export interface ShopmonkeyShopRef {
  shopId: number;
  locationId?: string | null;
  companyId?: string | null;
}

export interface IncrementalSyncCycleResult {
  shopsConsidered: number;
  shopsSynced: number;
  totalRecords: number;
  perShop: Array<{ shopId: number; result: SyncResult }>;
  skippedReason?: string;
}

/**
 * Enumerate the shops that have explicitly configured Shopmonkey (per-shop
 * `shopmonkey.apiKey`). This is the gate that keeps the whole module a no-op
 * until a shop opts in. We deliberately do NOT fall back to the global env key
 * here — a global key must not silently enroll the entire fleet into sync.
 */
export async function getConfiguredShopmonkeyShops(): Promise<ShopmonkeyShopRef[]> {
  const db = await getDb();
  const docs = await db
    .collection("shops")
    .find(
      { "shopmonkey.apiKey": { $exists: true, $ne: null } },
      { projection: { shopId: 1, "shopmonkey.locationId": 1, "shopmonkey.companyId": 1 } },
    )
    .toArray();

  return docs
    .filter((d: any) => d?.shopId != null)
    .map((d: any) => ({
      shopId: Number(d.shopId),
      locationId: d.shopmonkey?.locationId ?? null,
      companyId: d.shopmonkey?.companyId ?? null,
    }));
}

/**
 * Run one incremental sync cycle across all configured Shopmonkey shops.
 * No-op (shopsConsidered: 0) when none are configured.
 */
export async function runIncrementalSyncCycle(): Promise<IncrementalSyncCycleResult> {
  const shops = await getConfiguredShopmonkeyShops();

  const result: IncrementalSyncCycleResult = {
    shopsConsidered: shops.length,
    shopsSynced: 0,
    totalRecords: 0,
    perShop: [],
  };

  if (shops.length === 0) {
    result.skippedReason = "no Shopmonkey shops configured";
    return result;
  }

  for (const shop of shops) {
    try {
      const syncResult = await shopmonkeyAdapter.runIncrementalSync(shop.shopId);
      result.perShop.push({ shopId: shop.shopId, result: syncResult });
      if (syncResult.ok) {
        result.shopsSynced++;
        result.totalRecords += syncResult.recordsProcessed || 0;
      }
    } catch (err: any) {
      result.perShop.push({
        shopId: shop.shopId,
        result: { ok: false, recordsProcessed: 0, error: err?.message || "unknown" },
      });
    }
  }

  return result;
}
