import { NextRequest, NextResponse } from "next/server";
import { runWithTekmetricPriority } from "@/lib/integrations/tekmetric/client";
import { runIncrementalSyncCycle, ensureCacheIndexes } from "@/lib/integrations/tekmetric/incremental-sync";
import { getDb } from "@/lib/mongo";
import { inlineBusinessHoursBlock } from "@/lib/inline-business-hours";
import { runWithTekmetricApiCallTracking } from "@/lib/integrations/tekmetric/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;

// Plan pre-generation throttle (2026-08-14 incident — see comment at the
// pregenerate block below). Interval is env-tunable; the in-flight flag
// prevents a slow staggered run from overlapping the next interval's run.
const PREGEN_INTERVAL_MS = (() => {
  const parsed = Number(process.env.TEKMETRIC_PLAN_PREGEN_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 1000;
})();
// Delay between per-shop pregenerate POSTs so the fleet fan-out is spread
// out instead of landing as one burst on this same web process.
const PREGEN_SHOP_STAGGER_MS = (() => {
  const parsed = Number(process.env.TEKMETRIC_PLAN_PREGEN_STAGGER_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3000;
})();
let lastPregenerateAt = 0;
let pregenInFlight = false;
function shouldRunPregenerate(): boolean {
  // Fleet business-hours guard (2026-08-17): the pregen pass runs its plan
  // builds ON the web instances via self-POSTs, and with N instances each
  // holding its own module-level throttle the fleet gets N overlapping
  // ~15-min passes per interval — measurable p95 damage exactly when
  // advisors are working. A cache warm that slows live traffic is
  // net-negative, so daytime passes are skipped entirely; evening/night/
  // weekend passes still warm the caches. Same window + kill switch as the
  // inline fullpage guard.
  const biz = inlineBusinessHoursBlock();
  if (biz.blocked) {
    return false;
  }
  const elapsed = Date.now() - lastPregenerateAt;
  // Lease semantics: within an interval the flag blocks overlap; past the
  // interval a still-set flag means the previous pass hung (fetch/query
  // that never settled) and is considered expired — never wedge forever.
  if (pregenInFlight && elapsed < PREGEN_INTERVAL_MS) return false;
  return elapsed >= PREGEN_INTERVAL_MS;
}

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
    // Task #1089 (webhook-first): how many shops were skipped this tick
    // because live webhook coverage put them on the slow safety-net cadence.
    const webhookCovered = results.filter(r => r.skipReason?.startsWith("webhook_covered")).length;
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

    console.log(`[Cron] Tekmetric incremental sync completed in ${duration}ms — API calls made: ${apiCallCount} (budget: 600/min): ${totalSynced} synced, ${totalRemoved} removed, ${totalFromCacheVehicles}/${totalFromCacheCustomers} from cache, negative-cache hits ${negVehicles}/${negCustomers} (${negRatePct}% of ${lookupTotal} lookups), ${liveVehicles}/${liveCustomers} live fetches, ${totalPagesQueued} pages queued, ${errors} errors, ${skipped} skipped (${webhookCovered} webhook-covered)${deadlineHit ? `, DEADLINE HIT (${shopsDeferred} shops deferred)` : ""}`);

    // Fire-and-forget plan pre-generation for ALL dashboard-visible vehicles.
    //
    // 2026-08-14 incident: this block used to be effectively rare because
    // sync cycles took hours; once cycles completed every ~2 minutes it
    // fired a fleet-wide storm (177 shops × 50 VINs, sometimes double) every
    // few minutes and starved the web process event loop — advisors saw
    // 30s+ button loads. Guards: (1) at most once per
    // TEKMETRIC_PLAN_PREGEN_INTERVAL_MS (default 60 min), (2) an in-process
    // in-flight flag so overlapping cycles can't double-fire, (3) the
    // per-shop POSTs are staggered instead of all-at-once.
    if (CRON_SECRET && shouldRunPregenerate()) {
      pregenInFlight = true;
      lastPregenerateAt = Date.now();
      // ENTIRE pass (target discovery + POST fan-out) runs detached so the
      // cron response is never held by per-shop Mongo work. The in-flight
      // flag is a LEASE, not a lock: shouldRunPregenerate() ignores it once
      // PREGEN_INTERVAL_MS has elapsed, so a hung fetch/query can only
      // suppress pregen for one interval, never permanently.
      void (async () => {
        let queued = 0;
        let shopCount = 0;
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
          shopCount = tekmetricShops.length;
          console.log(`[Cron] Plan pre-generation pass starting: ${shopCount} Tekmetric shops (next pass in ~${Math.round(PREGEN_INTERVAL_MS / 60000)}min)`);
          
          for (const shop of tekmetricShops) {
            // Use internal shop.shopId (NOT tekmetric.shopId) since work orders are stored with internal ID
            const internalShopId = shop.shopId;
            if (!internalShopId) continue;
            
            // Top 50 vehicles by most recent work order (dashboard order);
            // maxTimeMS bounds the query so one bad shop can't hang the pass.
            let vins: string[] = [];
            try {
              const recentVehicles = await db.collection("tekmetric_work_orders")
                .aggregate([
                  { $match: { shopId: { $in: [internalShopId, String(internalShopId), Number(internalShopId)] } } },
                  { $sort: { fetchedAt: -1 } },
                  { $group: { _id: "$vin", lastUpdated: { $first: "$fetchedAt" } } },
                  { $sort: { lastUpdated: -1 } },
                  { $limit: 50 },
                ], { maxTimeMS: 30_000 })
                .toArray();
              vins = recentVehicles
                .map((v: any) => v._id as string)
                .filter((v: string) => v && typeof v === 'string' && v.length === 17);
            } catch (aggErr: any) {
              console.log(`[Cron] Plan pregenerate VIN discovery failed for shop ${internalShopId}:`, aggErr?.message);
              continue;
            }
            if (vins.length === 0) continue;
            
            try {
              await fetch(`${baseUrl}/api/internal/plan-pregenerate`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${CRON_SECRET}`,
                },
                body: JSON.stringify({ shopId: internalShopId, vins }),
                // Warming 50 VINs is network-bound but must not hang the
                // lease; the route batches 5 VINs concurrently so 2 min is
                // generous.
                signal: AbortSignal.timeout(120_000),
              });
              queued++;
            } catch (err: any) {
              console.log(`[Cron] Plan pregenerate failed for shop ${internalShopId}:`, err?.message);
            }
            if (PREGEN_SHOP_STAGGER_MS > 0) {
              await new Promise((r) => setTimeout(r, PREGEN_SHOP_STAGGER_MS));
            }
          }
          console.log(`[Cron] Plan pre-generation pass complete: ${queued}/${shopCount} shops (staggered ${PREGEN_SHOP_STAGGER_MS}ms apart)`);
        } catch (pregenerateErr: any) {
          console.error(`[Cron] Tekmetric pregenerate error:`, pregenerateErr?.message);
        } finally {
          pregenInFlight = false;
        }
      })();
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
        webhookCovered,
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
