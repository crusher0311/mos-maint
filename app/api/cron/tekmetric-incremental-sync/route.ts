import { NextRequest, NextResponse } from "next/server";
import { runWithTekmetricPriority } from "@/lib/integrations/tekmetric/client";
import { runIncrementalSyncCycle, ensureCacheIndexes } from "@/lib/integrations/tekmetric/incremental-sync";
import { getDb } from "@/lib/mongo";
import { runWithTekmetricApiCallTracking } from "@/lib/integrations/tekmetric/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

// Task: cron/backfill Tekmetric traffic must yield to advisor-facing
// requests — bind ambient 'background' rate-limit priority for the
// whole handler so every Tekmetric call under it inherits it.
export async function GET(req: NextRequest) {
  return runWithTekmetricPriority("background", () => _GETImpl(req));
}

async function _GETImpl(req: NextRequest) {
  // Task #1079: when the incremental cycle lives on the background worker
  // service, this WEB endpoint must not run it — otherwise callers outside
  // the suppressed scheduler registration (daily-all, the legacy
  // tekmetric-sync-worker script, manual curls) would run a duplicate
  // cycle on the web instance. The route's in-process overlap guard cannot
  // see the worker's cycle, so gate here, before any work.
  if (process.env.TEKMETRIC_INCREMENTAL_ON_WORKER === "true") {
    return NextResponse.json({
      ok: true,
      skipped: true,
      message: "Incremental sync is owned by the background worker (TEKMETRIC_INCREMENTAL_ON_WORKER=true); web endpoint is a no-op",
    });
  }

  // Check if sync is disabled for this deployment
  if (process.env.DISABLE_TEKMETRIC_SYNC === "true") {
    return NextResponse.json({
      ok: true,
      message: "Tekmetric sync disabled via DISABLE_TEKMETRIC_SYNC environment variable",
      disabled: true
    });
  }

  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Wrap the whole cycle in an AsyncLocalStorage scope so the API-call
  // count we report is *this* run's calls only — not leaked from any
  // other concurrent Tekmetric operation in the same Node process (e.g.
  // an admin RO retry click). Mirrors the per-chunk 429 tracking pattern.
  return runWithTekmetricApiCallTracking(async (apiCallCounter) => {
  try {
    await ensureCacheIndexes();
    
    const { results, duration, skippedOverlap, deadlineHit, shopsDeferred } = await runIncrementalSyncCycle();

    if (skippedOverlap) {
      return NextResponse.json({ ok: true, skippedOverlap: true, message: "Previous cycle still running" });
    }
    
    const totalSynced = results.reduce((sum, r) => sum + r.synced, 0);
    const totalRemoved = results.reduce((sum, r) => sum + r.removed, 0);
    const totalFromCacheVehicles = results.reduce((sum, r) => sum + r.fromCache.vehicles, 0);
    const totalFromCacheCustomers = results.reduce((sum, r) => sum + r.fromCache.customers, 0);
    const totalPagesQueued = results.reduce((sum, r) => sum + r.pagesQueued, 0);
    const errors = results.filter(r => r.error).length;
    const skipped = results.filter(r => r.skipped).length;
    const apiCallCount = apiCallCounter.count;

    // Task #1079: negative-cache hit rate in the completion log so on-call
    // can confirm the failed-fetch retry storm stays gone without querying
    // Mongo. Rate = backoff-skipped lookups / all lookups (cache + negative
    // + live) for vehicles and customers combined.
    const negVehicles = results.reduce((sum, r) => sum + (r.negativeCacheHits?.vehicles ?? 0), 0);
    const negCustomers = results.reduce((sum, r) => sum + (r.negativeCacheHits?.customers ?? 0), 0);
    const liveVehicles = results.reduce((sum, r) => sum + (r.liveFetches?.vehicles ?? 0), 0);
    const liveCustomers = results.reduce((sum, r) => sum + (r.liveFetches?.customers ?? 0), 0);
    const negTotal = negVehicles + negCustomers;
    const lookupTotal = negTotal + liveVehicles + liveCustomers + totalFromCacheVehicles + totalFromCacheCustomers;
    const negRatePct = lookupTotal > 0 ? Math.round((negTotal / lookupTotal) * 100) : 0;

    console.log(`[Cron] Tekmetric incremental sync completed in ${duration}ms — API calls made: ${apiCallCount} (budget: 600/min): ${totalSynced} synced, ${totalRemoved} removed, ${totalFromCacheVehicles}/${totalFromCacheCustomers} from cache, negative-cache hits ${negVehicles}/${negCustomers} (${negRatePct}% of ${lookupTotal} lookups), ${liveVehicles}/${liveCustomers} live fetches, ${totalPagesQueued} pages queued, ${errors} errors, ${skipped} skipped${deadlineHit ? `, DEADLINE HIT (${shopsDeferred} shops deferred)` : ""}`);

    // Fire-and-forget plan pre-generation for ALL dashboard-visible vehicles
    if (CRON_SECRET) {
      try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL 
          || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
          || `http://localhost:${process.env.PORT || 5000}`;
        
        const db = await getDb();
        
        // Get all Tekmetric shops - use tekmetric.shopId as the shop identifier
        const tekmetricShops = await db.collection("shops")
          .find({ "tekmetric.shopId": { $exists: true, $ne: null } })
          .project({ _id: 0, shopId: 1, tekmetric: 1 })
          .toArray();
        
        console.log(`[Cron] Found ${tekmetricShops.length} Tekmetric shops for pregeneration`);
        
        let triggeredCount = 0;
        for (const shop of tekmetricShops) {
          // Use internal shop.shopId (NOT tekmetric.shopId) since work orders are stored with internal ID
          const internalShopId = shop.shopId;
          const tekmetricShopId = shop.tekmetric?.shopId;
          if (!internalShopId) continue;
          
          // Get top 50 vehicles by most recent work order (dashboard order)
          // Tekmetric work orders are stored with internal shopId (not tekmetric shopId)
          
          // Debug: count work orders for this shop
          const woCount = await db.collection("tekmetric_work_orders").countDocuments({
            shopId: { $in: [internalShopId, String(internalShopId), Number(internalShopId)] }
          });
          console.log(`[Cron] Shop ${internalShopId} (tek: ${tekmetricShopId}): Found ${woCount} work orders in tekmetric_work_orders`);
          
          const recentVehicles = await db.collection("tekmetric_work_orders")
            .aggregate([
              { $match: { shopId: { $in: [internalShopId, String(internalShopId), Number(internalShopId)] } } },
              { $sort: { fetchedAt: -1 } },
              { $group: { _id: "$vin", lastUpdated: { $first: "$fetchedAt" } } },
              { $sort: { lastUpdated: -1 } },
              { $limit: 50 },
            ])
            .toArray();
          
          console.log(`[Cron] Shop ${internalShopId}: Aggregated ${recentVehicles.length} unique VINs`);
          
          const vins = recentVehicles
            .map((v: any) => v._id as string)
            .filter((v: string) => v && typeof v === 'string' && v.length === 17);
          
          console.log(`[Cron] Shop ${internalShopId}: ${vins.length} valid VINs after filter`);
          
          if (vins.length > 0) {
            triggeredCount++;
            fetch(`${baseUrl}/api/internal/plan-pregenerate`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CRON_SECRET}`,
              },
              body: JSON.stringify({ shopId: internalShopId, vins }),
            }).catch(err => console.log(`[Cron] Plan pregenerate failed for shop ${internalShopId}:`, err.message));
          }
        }
        console.log(`[Cron] Triggered plan pre-generation for ${triggeredCount}/${tekmetricShops.length} Tekmetric shops with vehicles`);
      } catch (pregenerateErr: any) {
        console.error(`[Cron] Tekmetric pregenerate error:`, pregenerateErr.message);
      }
    }

    return NextResponse.json({
      ok: true,
      duration: `${duration}ms`,
      tekmetricApiCalls: apiCallCount,
      summary: {
        totalShops: results.length,
        totalSynced,
        totalRemoved,
        fromCache: {
          vehicles: totalFromCacheVehicles,
          customers: totalFromCacheCustomers,
        },
        negativeCacheHits: {
          vehicles: negVehicles,
          customers: negCustomers,
          ratePct: negRatePct,
        },
        liveFetches: {
          vehicles: liveVehicles,
          customers: liveCustomers,
        },
        pagesQueued: totalPagesQueued,
        errors,
        skipped,
      },
      shops: results
    });
  } catch (err: any) {
    const finalApiCalls = apiCallCounter.count;
    console.error(`[Cron] Tekmetric incremental sync error (API calls made: ${finalApiCalls}):`, err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
  });
}
