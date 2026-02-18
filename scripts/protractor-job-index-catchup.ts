#!/usr/bin/env npx tsx
/**
 * Protractor Job Index Catch-up Script
 * 
 * Indexes jobs from completed Protractor work orders that were missed
 * between initial backfill and the addition of webhook-based job indexing.
 * 
 * Processes 1-2 shops at a time with rate limiting to stay within API limits.
 * 
 * Usage:
 *   npx tsx scripts/protractor-job-index-catchup.ts
 *   npx tsx scripts/protractor-job-index-catchup.ts --shop 12345
 *   npx tsx scripts/protractor-job-index-catchup.ts --dry-run
 *   npx tsx scripts/protractor-job-index-catchup.ts --batch-size 1
 */

import { getDb } from "@/lib/mongo";
import { extractJobIndexFromWorkOrder, computeJobHash } from "@/lib/job-index";
import { fetchWorkOrderById, resolveProtractorConfig } from "@/lib/integrations/protractor";
import pLimit from "p-limit";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SHOP_FILTER = args.includes("--shop") ? Number(args[args.indexOf("--shop") + 1]) : null;
const BATCH_SIZE = args.includes("--batch-size") ? Number(args[args.indexOf("--batch-size") + 1]) : 2;
const CONCURRENCY = 2;
const DELAY_BETWEEN_REQUESTS_MS = 250;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processShop(
  db: any,
  shopId: number,
  rateLimiter: ReturnType<typeof pLimit>
): Promise<{ shopId: number; total: number; indexed: number; skipped: number; fromCache: number; fromApi: number; errors: number }> {
  const stats = { shopId, total: 0, indexed: 0, skipped: 0, fromCache: 0, fromApi: 0, errors: 0 };

  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    console.log(`  Shop ${shopId}: Not configured, skipping`);
    return stats;
  }

  const completedWOs = await db.collection("protractor_work_orders").find({
    shopId: { $in: [String(shopId), Number(shopId)] },
    $or: [
      { completed: true },
      { workflowStage: { $in: ["Invoiced", "invoiced", "Posted", "posted", "Completed", "completed", "Closed", "closed"] } },
      { status: { $in: ["Invoiced", "invoiced", "Posted", "posted"] } },
    ],
    jobsIndexed: { $ne: true },
  }).toArray();

  stats.total = completedWOs.length;

  if (completedWOs.length === 0) {
    console.log(`  Shop ${shopId}: No un-indexed completed WOs found`);
    return stats;
  }

  console.log(`  Shop ${shopId}: Found ${completedWOs.length} completed WOs to index`);

  for (const cachedWO of completedWOs) {
    const woId = cachedWO.workOrderId || cachedWO.workOrderGuid || cachedWO.data?.ID;
    if (!woId) {
      stats.errors++;
      continue;
    }

    try {
      let woData = cachedWO.rawPayload;
      let source = "cache";

      if (!woData || !woData.ServicePackages) {
        woData = cachedWO.data;
      }

      const hasPackageLines = woData?.ServicePackages && (
        (Array.isArray(woData.ServicePackages) && woData.ServicePackages.length > 0) ||
        (woData.ServicePackages?.ItemCollection?.length > 0)
      );

      if (!hasPackageLines) {
        const result = await rateLimiter(async () => {
          await sleep(DELAY_BETWEEN_REQUESTS_MS);
          return fetchWorkOrderById(shopId, woId);
        });

        if (result.ok && result.workOrder) {
          woData = result.workOrder;
          source = "api";
          stats.fromApi++;
        } else {
          console.log(`    WO ${cachedWO.workOrderNumber || woId}: API fetch failed, skipping`);
          stats.errors++;
          continue;
        }
      } else {
        stats.fromCache++;
      }

      const jobEntries = extractJobIndexFromWorkOrder(shopId, woData, "protractor");

      if (jobEntries.length === 0) {
        if (!DRY_RUN) {
          await db.collection("protractor_work_orders").updateOne(
            { _id: cachedWO._id },
            { $set: { jobsIndexed: true, jobsIndexedAt: new Date(), jobsIndexedSource: "catchup-empty" } }
          );
        }
        stats.skipped++;
        continue;
      }

      let woIndexed = 0;
      for (const entry of jobEntries) {
        const contentHash = computeJobHash(entry);
        const filter = {
          shopId,
          workOrderId: entry.workOrderId,
          servicePackageId: entry.servicePackageId,
        };

        if (!DRY_RUN) {
          const existing = await db.collection("job_index").findOne(filter);
          if (existing?.contentHash === contentHash) continue;

          await db.collection("job_index").updateOne(
            filter,
            { $set: { ...entry, contentHash } },
            { upsert: true }
          );
        }
        woIndexed++;
      }

      if (!DRY_RUN) {
        await db.collection("protractor_work_orders").updateOne(
          { _id: cachedWO._id },
          { $set: { jobsIndexed: true, jobsIndexedAt: new Date(), jobsIndexedSource: `catchup-${source}` } }
        );
      }

      stats.indexed += woIndexed;

      if (woIndexed > 0 && stats.indexed % 50 === 0) {
        console.log(`    Progress: ${stats.indexed} jobs indexed from ${stats.fromCache + stats.fromApi} WOs...`);
      }

    } catch (err: any) {
      console.error(`    WO ${cachedWO.workOrderNumber || woId}: Error - ${err.message}`);
      stats.errors++;
    }
  }

  return stats;
}

async function main() {
  console.log("=== Protractor Job Index Catch-up ===");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`Shop batch size: ${BATCH_SIZE}`);
  console.log(`Concurrency: ${CONCURRENCY} requests at a time`);
  console.log(`Delay between requests: ${DELAY_BETWEEN_REQUESTS_MS}ms`);
  console.log("");

  const db = await getDb();
  const rateLimiter = pLimit(CONCURRENCY);

  let shops: any[];

  if (SHOP_FILTER) {
    shops = [{ shopId: SHOP_FILTER }];
    console.log(`Targeting single shop: ${SHOP_FILTER}`);
  } else {
    shops = await db.collection("shops").find({
      $or: [
        { "integrations.protractor": { $exists: true } },
        { protractorConnectionId: { $exists: true } },
        { protractorApiKey: { $exists: true } },
      ]
    }).project({ shopId: 1, name: 1 }).toArray();
    console.log(`Found ${shops.length} Protractor shops`);
  }

  const allResults: any[] = [];
  const startTime = Date.now();

  for (let i = 0; i < shops.length; i += BATCH_SIZE) {
    const batch = shops.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(shops.length / BATCH_SIZE);

    console.log(`\n--- Batch ${batchNum}/${totalBatches}: shops ${batch.map(s => s.shopId).join(", ")} ---`);

    const batchResults = await Promise.all(
      batch.map(shop => processShop(db, Number(shop.shopId), rateLimiter))
    );

    allResults.push(...batchResults);

    const batchIndexed = batchResults.reduce((sum, r) => sum + r.indexed, 0);
    if (batchIndexed > 0) {
      console.log(`  Batch complete: ${batchIndexed} jobs indexed`);
    }

    if (i + BATCH_SIZE < shops.length) {
      console.log("  Pausing 2s between batches...");
      await sleep(2000);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalIndexed = allResults.reduce((sum, r) => sum + r.indexed, 0);
  const totalFromCache = allResults.reduce((sum, r) => sum + r.fromCache, 0);
  const totalFromApi = allResults.reduce((sum, r) => sum + r.fromApi, 0);
  const totalErrors = allResults.reduce((sum, r) => sum + r.errors, 0);
  const totalWOs = allResults.reduce((sum, r) => sum + r.total, 0);

  console.log("\n=== Summary ===");
  console.log(`Duration: ${duration}s`);
  console.log(`Shops processed: ${allResults.length}`);
  console.log(`Total completed WOs found: ${totalWOs}`);
  console.log(`Jobs indexed: ${totalIndexed}`);
  console.log(`WOs from cache: ${totalFromCache}`);
  console.log(`WOs from API: ${totalFromApi}`);
  console.log(`Errors: ${totalErrors}`);

  if (DRY_RUN) {
    console.log("\n(DRY RUN - no data was written)");
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
