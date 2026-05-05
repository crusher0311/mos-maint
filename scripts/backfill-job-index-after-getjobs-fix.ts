// One-off backfill: re-index Tekmetric jobs for terminal ROs that the
// pre-fix incremental sync failed to populate.
//
// Background: before commit c076c31a (the `getJobs` shop-id + arg-order fix),
// any terminal RO whose jobs were not already cached in
// `tekmetric_work_orders.data.jobs` would 400 on `/jobs?repairOrder=…`,
// throw out of `indexTekmetricWorkOrderJobs`, and leave the parent
// `tekmetric_work_orders` doc with `jobsIndexed` unset. The next incremental
// sync would NOT retry those ROs because their `updatedDate` falls outside
// the `updatedDateStart` window — so they're effectively orphaned: cached
// WO doc exists, but `job_index` rows don't.
//
// This script finds those orphans and runs them through the same
// `indexTekmetricWorkOrderJobs` code path the live sync uses (now that
// `getJobs` works), then sets `jobsIndexed: true` to prevent re-processing.
//
// Usage:
//   npx tsx scripts/backfill-job-index-after-getjobs-fix.ts [--dry-run]
//                                                           [--shop=N]
//                                                           [--limit=N]
//                                                           [--cached-only]
//
// Defaults: process every shop, no cap, do real writes.
//   --dry-run       — count + classify, write nothing
//   --shop=N        — only this MOS shopId
//   --limit=N       — process at most N ROs total (sanity cap)
//   --cached-only   — only ROs whose `data.jobs` is already populated
//                     (zero Tekmetric API calls — useful for a fast first
//                     pass)
//
// Pacing: each `/jobs` API call goes through `tekmetricRequest`, which uses
// the in-process+distributed rate limiter (5 rps cap, with 429 backoff). No
// extra throttle needed here — the shared limiter naturally serializes
// against the live cron syncs.

import { getDb } from "../lib/mongo";
import { indexTekmetricWorkOrderJobs } from "../lib/integrations/tekmetric/job-index";

const TERMINAL = ["POSTED", "INVOICED", "INVOICE", "COMPLETED", "CLOSED"];

type Args = {
  dryRun: boolean;
  shop?: number;
  limit?: number;
  cachedOnly: boolean;
};

function parseArgs(): Args {
  const out: Args = { dryRun: false, cachedOnly: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--cached-only") out.cachedOnly = true;
    else if (a.startsWith("--shop=")) out.shop = Number(a.slice(7));
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice(8));
  }
  return out;
}

async function loadShopMap(db: any): Promise<Map<number, number>> {
  // shopId -> tekmetricShopId. Skip shops without a real tekmetric link.
  const shops = await db
    .collection("shops")
    .find({
      $or: [
        { "tekmetric.shopId": { $exists: true, $ne: null } },
        { tekmetricShopId: { $exists: true, $ne: null } },
      ],
    })
    .project({ shopId: 1, tekmetric: 1, tekmetricShopId: 1 })
    .toArray();

  const map = new Map<number, number>();
  for (const s of shops) {
    const mosShopId = Number(s.shopId);
    const tekShopId = Number(s.tekmetric?.shopId ?? s.tekmetricShopId);
    if (Number.isFinite(mosShopId) && Number.isFinite(tekShopId)) {
      map.set(mosShopId, tekShopId);
    }
  }
  return map;
}

async function main() {
  const args = parseArgs();
  const db = await getDb();
  const shopMap = await loadShopMap(db);

  console.log(
    `[Backfill] Loaded ${shopMap.size} Tekmetric-linked shops` +
      (args.shop ? ` (filtering to shop ${args.shop})` : "") +
      (args.cachedOnly ? " [cached-only mode: zero API calls]" : "") +
      (args.dryRun ? " [DRY RUN]" : ""),
  );

  // Candidate filter mirrors the live sync's `isTerminal && !jobsIndexed`
  // gate, plus a guard against the null/NaN-shopId junk rows we don't try
  // to fix.
  const candidateFilter: Record<string, any> = {
    statusCode: { $in: TERMINAL },
    $or: [
      { jobsIndexed: { $exists: false } },
      { jobsIndexed: { $ne: true } },
    ],
    // Allow both number-typed and string-typed shopId — many shops store
    // it as a string in tekmetric_work_orders. The in-loop `Number()` +
    // `Number.isFinite()` check below filters out the genuine junk
    // (null/NaN-valued shopIds we can't resolve to a tekmetricShopId).
    shopId: { $exists: true, $ne: null },
  };
  if (args.shop !== undefined) {
    candidateFilter.shopId = { $in: [args.shop, String(args.shop)] };
  }
  if (args.cachedOnly) {
    // `data.jobs.0` exists is the canonical Mongo idiom for "non-empty
    // array" and matches whether the field is stored as a normal array
    // or wrapped. Empty arrays (`[]`) are treated as cache-miss because
    // `indexTekmetricWorkOrderJobs` falls through to the `/jobs` API call
    // when the cached array is empty.
    candidateFilter["data.jobs.0"] = { $exists: true };
  }

  const cursor = db.collection("tekmetric_work_orders").find(candidateFilter, {
    projection: {
      shopId: 1,
      workOrderId: 1,
      workOrderNumber: 1,
      vin: 1,
      vehicleYear: 1,
      vehicleMake: 1,
      vehicleModel: 1,
      vehicleEngine: 1,
      odometer: 1,
      completedDate: 1,
      updatedDate: 1,
      data: 1,
    },
  });

  let scanned = 0;
  let skippedNoTekShop = 0;
  let skippedNanShop = 0;
  let processedCached = 0;
  let processedApi = 0;
  let succeeded = 0;
  let zeroJobs = 0;
  let failed = 0;
  const failureSamples: string[] = [];

  const startedAt = Date.now();
  let lastLogAt = startedAt;

  for await (const wo of cursor) {
    scanned++;

    // Periodic progress every 50 ROs or every 30s.
    if (scanned % 50 === 0 || Date.now() - lastLogAt > 30_000) {
      const rate = scanned / Math.max(1, (Date.now() - startedAt) / 1000);
      console.log(
        `[Backfill] scanned=${scanned} ok=${succeeded} zero=${zeroJobs} fail=${failed} ` +
          `(cached=${processedCached} api=${processedApi}) ` +
          `${rate.toFixed(2)}/s`,
      );
      lastLogAt = Date.now();
    }

    if (args.limit !== undefined && succeeded + failed >= args.limit) {
      console.log(`[Backfill] Hit --limit=${args.limit}, stopping.`);
      break;
    }

    const shopId = Number(wo.shopId);
    if (!Number.isFinite(shopId)) {
      skippedNanShop++;
      continue;
    }
    const tekmetricShopId = shopMap.get(shopId);
    if (!tekmetricShopId) {
      skippedNoTekShop++;
      continue;
    }

    const workOrderId = Number(wo.workOrderId);
    if (!Number.isFinite(workOrderId)) {
      failed++;
      if (failureSamples.length < 5)
        failureSamples.push(
          `WO ${wo.workOrderId}: non-numeric workOrderId (shop ${shopId})`,
        );
      continue;
    }

    const hasCachedJobs =
      Array.isArray(wo.data?.jobs) && wo.data.jobs.length > 0;
    if (hasCachedJobs) processedCached++;
    else processedApi++;

    if (args.dryRun) {
      // In dry-run, just classify — don't call the indexer or write.
      continue;
    }

    try {
      const completedDate =
        wo.data?.completedDate ||
        wo.completedDate ||
        wo.data?.postedDate ||
        wo.data?.updatedDate ||
        wo.updatedDate ||
        new Date().toISOString();

      const indexed = await indexTekmetricWorkOrderJobs(
        shopId,
        tekmetricShopId,
        workOrderId,
        Number(wo.workOrderNumber || workOrderId),
        {
          vin: wo.vin,
          year: wo.vehicleYear,
          make: wo.vehicleMake,
          model: wo.vehicleModel,
          engine: wo.vehicleEngine,
        },
        completedDate,
        wo.odometer ?? null,
        { indexedVia: "backfill" },
      );

      // Confirmed by `db.tekmetric_work_orders.aggregate({$group:{_id:{$type:"$workOrderId"}}})`:
      // every doc in this collection (509k+) stores workOrderId as a string,
      // so a single String() match is exhaustive. shopId varies (int vs
      // string), hence the $in there. If a future migration ever stores
      // workOrderId numerically, switch this to `{ $in: [String(workOrderId), workOrderId] }`.
      const updateFilter = {
        shopId: { $in: [shopId, String(shopId)] },
        workOrderId: String(workOrderId),
      };
      if (indexed > 0) {
        await db
          .collection("tekmetric_work_orders")
          .updateOne(updateFilter, { $set: { jobsIndexed: true } });
        succeeded++;
      } else {
        // Genuinely zero jobs (e.g. an estimate-only RO). Still mark
        // jobsIndexed: true so we don't re-scan it next run.
        await db
          .collection("tekmetric_work_orders")
          .updateOne(updateFilter, { $set: { jobsIndexed: true } });
        zeroJobs++;
      }
    } catch (err: any) {
      failed++;
      if (failureSamples.length < 10) {
        failureSamples.push(
          `WO ${workOrderId} (shop ${shopId}): ${err?.message ?? err}`,
        );
      }
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("\n[Backfill] === FINAL ===");
  console.log(`  scanned:           ${scanned}`);
  console.log(`  succeeded:         ${succeeded}  (jobsIndexed=true, jobs > 0)`);
  console.log(`  zero-jobs:         ${zeroJobs}   (jobsIndexed=true, jobs = 0)`);
  console.log(`  failed:            ${failed}`);
  console.log(`  skipped-no-tek:    ${skippedNoTekShop}  (shop has no tekmetricShopId)`);
  console.log(`  skipped-nan-shop:  ${skippedNanShop}    (shopId is null/NaN — junk data)`);
  console.log(`  via-cached-jobs:   ${processedCached}   (no Tekmetric API call)`);
  console.log(`  via-api:           ${processedApi}      (one Tekmetric /jobs call each)`);
  console.log(`  elapsed:           ${elapsedSec}s`);
  if (failureSamples.length > 0) {
    console.log("\n  Failure samples:");
    failureSamples.forEach((f) => console.log(`    - ${f}`));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[Backfill] FATAL:", err);
  process.exit(1);
});
