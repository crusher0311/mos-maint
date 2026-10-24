/**
 * Re-normalize Shopmonkey shops from their already-cached
 * `shopmonkey_work_orders` rows into the normalized stores + job_index
 * history (no full history re-pull). Repairs shops whose cache filled via
 * webhooks while normalization never ran (e.g. VIN-less marine units that the
 * old webhook hard-skip dropped), and backfills the service-job history that
 * every pre-fix ingest discarded.
 *
 * Usage:
 *   npx tsx scripts/renormalize-shopmonkey-from-cache.ts <shopId> [<shopId> ...]
 *
 * OPERATOR-GATED: writes to the shared Mongo cluster + canonical PG. Run one
 * shop at a time off-peak if in doubt. Idempotent — contentHash dedup makes
 * re-runs cheap.
 */
import { renormalizeShopmonkeyShopFromCache } from "@/lib/integrations/shopmonkey/ingest";

async function main() {
  const shopIds = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (shopIds.length === 0) {
    console.error("Usage: npx tsx scripts/renormalize-shopmonkey-from-cache.ts <shopId> [<shopId> ...]");
    process.exit(1);
  }

  for (const shopId of shopIds) {
    console.log(`\n=== Re-normalizing Shopmonkey shop ${shopId} from cache ===`);
    const start = Date.now();
    const result = await renormalizeShopmonkeyShopFromCache(shopId);
    console.log(
      `=== shop ${shopId} done in ${Math.round((Date.now() - start) / 1000)}s: ` +
        `cachedRows=${result.cachedRows} processed=${result.processed} skippedNoData=${result.skippedNoData} ` +
        `WO ${result.summary.workOrdersCreated}c/${result.summary.workOrdersUpdated}u/${result.summary.workOrdersSkipped}s/${result.summary.workOrdersErrored}e ` +
        `serviceJobs=${result.summary.serviceJobsWritten} (${result.summary.serviceJobErrors}e) lineItems=${result.summary.lineItemsWritten} ===`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Renormalize failed:", err);
  process.exit(1);
});
