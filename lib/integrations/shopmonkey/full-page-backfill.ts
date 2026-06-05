/**
 * Shopmonkey full-page backfill — mirrors
 * lib/integrations/tekmetric/full-page-backfill.ts.
 *
 * Runs a single per-shop backfill chunk under the per-shop in-flight lock so
 * concurrent cron + manual invocations of the same shop can't stack up and burn
 * the shared rate budget. Delegates the fetch/normalize to the registered
 * ShopmonkeyAdapter (`runBackfill`); progress + lock state live on the
 * `shopmonkey_backfill_progress` doc.
 *
 * PROD-SAFE GATING: config-gated no-op. `runFullPageBackfillChunk` refuses to
 * run for a shop that hasn't configured Shopmonkey, and the cron entry point
 * (`runFullPageBackfillCycle`) enumerates only opted-in shops — currently zero,
 * so it does nothing. NO real fleet backfill is ever kicked off automatically;
 * a shop must explicitly opt in by setting `shopmonkey.apiKey`.
 */

import { getDb } from "@/lib/mongo";
import { shopmonkeyAdapter } from "./adapter";
import {
  acquireInFlightLock,
  bumpInFlightHeartbeat,
  releaseInFlightLock,
  PROGRESS_COLLECTION,
} from "./inflight-lock";
import { getConfiguredShopmonkeyShops } from "./incremental-sync";
import type { BackfillOptions } from "@/lib/integrations/core/types";

export interface FullPageBackfillResult {
  shopId: number;
  ran: boolean;
  complete: boolean;
  chunksProcessed: number;
  totalJobsIndexed: number;
  busy?: boolean;
  heldBy?: string | null;
  error?: string;
  skippedReason?: string;
}

/**
 * Run a single backfill chunk for one shop under the in-flight lock.
 * No-op (ran:false) when Shopmonkey isn't configured for the shop or when
 * another run already holds the lock.
 */
export async function runFullPageBackfillChunk(
  shopId: number,
  options?: BackfillOptions,
): Promise<FullPageBackfillResult> {
  const base: FullPageBackfillResult = {
    shopId,
    ran: false,
    complete: false,
    chunksProcessed: 0,
    totalJobsIndexed: 0,
  };

  if (!(await shopmonkeyAdapter.isConfigured(shopId))) {
    return { ...base, skippedReason: "Shopmonkey not configured for this shop" };
  }

  const db = await getDb();

  const lock = await acquireInFlightLock(db, shopId);
  if (!lock.acquired) {
    return { ...base, busy: true, heldBy: lock.heldBy, skippedReason: "another backfill run holds the lock" };
  }

  try {
    const result = await shopmonkeyAdapter.runBackfill(shopId, options);
    await bumpInFlightHeartbeat(db, shopId, lock.owner);

    await db.collection(PROGRESS_COLLECTION).updateOne(
      { shopId },
      {
        $set: {
          shopId,
          lastChunkAt: new Date(),
          complete: !!result.complete,
          lastChunkJobsIndexed: result.totalJobsIndexed || 0,
        },
        $inc: { chunksProcessed: result.chunksProcessed || 0 },
      },
      { upsert: true },
    );

    return {
      shopId,
      ran: true,
      complete: !!result.complete,
      chunksProcessed: result.chunksProcessed || 0,
      totalJobsIndexed: result.totalJobsIndexed || 0,
      error: result.ok ? undefined : result.error,
    };
  } catch (err: any) {
    return { ...base, ran: true, error: err?.message || "unknown" };
  } finally {
    await releaseInFlightLock(db, shopId, lock.owner);
  }
}

/**
 * Run one backfill cycle across all configured Shopmonkey shops. No-op when
 * none are configured (the current fleet state).
 */
export async function runFullPageBackfillCycle(
  options?: BackfillOptions,
): Promise<{ shopsConsidered: number; results: FullPageBackfillResult[]; skippedReason?: string }> {
  const shops = await getConfiguredShopmonkeyShops();
  if (shops.length === 0) {
    return { shopsConsidered: 0, results: [], skippedReason: "no Shopmonkey shops configured" };
  }

  const results: FullPageBackfillResult[] = [];
  for (const shop of shops) {
    results.push(await runFullPageBackfillChunk(shop.shopId, options));
  }
  return { shopsConsidered: shops.length, results };
}
