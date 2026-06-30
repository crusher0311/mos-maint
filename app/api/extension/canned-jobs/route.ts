import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { getCannedJobs } from "@/lib/integrations/tekmetric";
import { protractorAdapter } from "@/lib/integrations/protractor/adapter";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ONE_HOUR = 60 * 60 * 1000;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * Fetch canned jobs from Protractor and write them to the cache. Returns the
 * mapped jobs (possibly empty). Never overwrites the cache with an empty
 * result so a transient empty/error can't poison the cache-hit check (which
 * requires length > 0). Shared by the synchronous miss path and the
 * stale-while-revalidate background refresh.
 */
async function fetchAndCacheProtractorCannedJobs(db: any, mosShopId: number): Promise<any[]> {
  let cannedJobs: any[] = [];
  try {
    console.log(`[Extension Canned Jobs] Fetching from Protractor API for shop ${mosShopId}`);
    const result = await protractorAdapter.getCannedJobs(mosShopId);
    if (result.ok && result.data) {
      cannedJobs = result.data.map((job: any) => ({
        id: job.id || job.code,
        code: job.code || job.id,
        title: job.name || job.title || `Canned Job ${job.id}`,
        name: job.name || job.title || `Canned Job ${job.id}`,
        description: job.description || "",
        category: job.category || "",
        labor: job.labor || [],
        parts: job.parts || [],
        totalCost: job.totalCost || 0,
      }));

      if (cannedJobs.length > 0) {
        await db.collection("protractor_canned_jobs_cache").updateOne(
          { shopId: mosShopId },
          {
            $set: {
              shopId: mosShopId,
              cannedJobs,
              fetchedAt: new Date(),
            },
          },
          { upsert: true }
        );
        console.log(`[Extension Canned Jobs] Fetched ${cannedJobs.length} jobs from Protractor API`);
      } else {
        console.warn(`[Extension Canned Jobs] Protractor returned 0 jobs for shop ${mosShopId}; not overwriting cache`);
      }
    }
  } catch (err: any) {
    console.error("[Extension Canned Jobs] Protractor API error:", err.message);
  }
  return cannedJobs;
}

/**
 * Fetch canned jobs from Tekmetric (paged, with a per-page upstream timeout so
 * a slow/hung shop can't block the caller) and write them to the cache.
 * Returns the mapped jobs (possibly empty). Never overwrites the cache with an
 * empty result. Shared by the synchronous miss path and the
 * stale-while-revalidate background refresh.
 */
async function fetchAndCacheTekmetricCannedJobs(
  db: any,
  tekmetricShopId: number | string,
  mosShopId: number,
): Promise<any[]> {
  let cannedJobs: any[] = [];
  try {
    console.log(`[Extension Canned Jobs] Fetching from Tekmetric API for shop ${tekmetricShopId}`);
    let allCannedJobs: any[] = [];
    let page = 0;
    let hasMore = true;

    while (hasMore) {
      // Heart-shop slowdown mitigation: cap each page at 5s. On timeout we
      // break the loop with whatever pages we already collected (still better
      // than blocking the extension for the full 14s+ we saw in production),
      // and if we got nothing the stale-cache fallback kicks in.
      let response = await withUpstreamTimeout(
        getCannedJobs(tekmetricShopId, { page, size: 100 }),
        5000,
        `tekmetric canned-jobs page=${page} shop=${tekmetricShopId}`,
        null as any,
      );
      // One retry on the first page with a slightly longer budget — a single
      // transient slow response shouldn't leave the extension with nothing
      // when a warm cache exists/can be built.
      if (!response && page === 0) {
        console.warn(`[Extension Canned Jobs] page 0 timed out for shop ${tekmetricShopId} — retrying once (8s)`);
        response = await withUpstreamTimeout(
          getCannedJobs(tekmetricShopId, { page, size: 100 }),
          8000,
          `tekmetric canned-jobs retry page=0 shop=${tekmetricShopId}`,
          null as any,
        );
      }
      if (!response) {
        console.warn(`[Extension Canned Jobs] page ${page} timed out — using ${allCannedJobs.length} jobs collected so far`);
        break;
      }
      allCannedJobs = allCannedJobs.concat(response.content || []);
      hasMore = !response.last;
      page++;
      if (page > 20) break;
    }

    cannedJobs = allCannedJobs.map(job => ({
      id: String(job.id),
      code: String(job.id),
      title: job.name || `Canned Job ${job.id}`,
      name: job.name || `Canned Job ${job.id}`,
      description: job.note || "",
      category: job.jobCategoryCode || "",
      laborRates: job.laborRates || [],
      labor: job.labor || [],
      parts: job.parts || [],
      discounts: job.discounts || [],
      fees: job.fees || [],
      totalCost: job.totalCost || 0,
      packagePrice: job.packagePrice || false,
    }));

    // Only cache a non-empty result. Caching an empty array (e.g. from a
    // timed-out fetch) used to poison the cache: the cache-hit check requires
    // `cannedJobs.length > 0`, so a 0-row row behaves as a permanent miss that
    // re-fetches (and re-caches empty) on every request.
    if (cannedJobs.length > 0) {
      await db.collection("tekmetric_canned_jobs_cache").updateOne(
        { shopId: tekmetricShopId },
        {
          $set: {
            shopId: tekmetricShopId,
            mosShopId: mosShopId,
            cannedJobs: cannedJobs,
            fetchedAt: new Date(),
          },
        },
        { upsert: true }
      );
      console.log(`[Extension Canned Jobs] Fetched ${cannedJobs.length} jobs from Tekmetric API`);
    } else {
      console.warn(`[Extension Canned Jobs] Tekmetric returned 0 jobs for shop ${tekmetricShopId}; not overwriting cache`);
    }
  } catch (err: any) {
    console.error("[Extension Canned Jobs] Tekmetric API error:", err.message);
  }
  return cannedJobs;
}

/**
 * Kick off a background cache refresh without blocking the response. This
 * runs in a long-lived Node web process (Render), so the event loop keeps the
 * promise alive after the response is sent. Errors are swallowed (the fetch
 * helpers already log) so a failed refresh can't crash the process.
 */
function revalidateInBackground(label: string, work: () => Promise<unknown>): void {
  work().catch((err: any) => {
    console.warn(`[Extension Canned Jobs] background revalidate failed (${label}):`, err?.message || err);
  });
}

async function _GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const smsShopId = searchParams.get("shopId");
    const provider = searchParams.get("provider") || "tekmetric";
    const refresh = searchParams.get("refresh") === "true";

    const guard = await guardExtensionShopRequest(request, {
      smsShopId,
      provider,
      requiredFeatures: ["job_lookup"],
      featureLabel: "Job Lookup",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const mosShopId = guard.mosShopId;
    const db = await getDb();

    const shop = await db.collection("shops").findOne({ shopId: mosShopId });
    const tekmetricShopId = shop?.tekmetric?.shopId || shop?.tekmetricShopId;

    let cannedJobs: any[] = [];
    let source = "none";

    const hasProtractor = !!(shop?.protractor?.connectionId);

    if (provider === "protractor" && hasProtractor) {
      const cached = refresh
        ? null
        : await db.collection("protractor_canned_jobs_cache").findOne({ shopId: mosShopId });

      const cacheHasJobs = cached?.cannedJobs?.length > 0;
      const cacheAge = cached?.fetchedAt ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;

      if (cacheHasJobs && cacheAge < ONE_HOUR) {
        // Fresh cache — serve it.
        cannedJobs = cached.cannedJobs;
        source = "cache";
        console.log(`[Extension Canned Jobs] Cache hit for Protractor shop ${mosShopId}: ${cannedJobs.length} jobs`);
      } else if (cacheHasJobs) {
        // Stale cache — serve it immediately and refresh in the background so
        // the user never waits on the upstream fetch (stale-while-revalidate).
        cannedJobs = cached.cannedJobs;
        source = "stale_revalidate";
        console.log(`[Extension Canned Jobs] Serving stale Protractor cache for shop ${mosShopId} (age=${Math.round(cacheAge / 1000)}s) and revalidating in background`);
        revalidateInBackground(`protractor shop=${mosShopId}`, () =>
          fetchAndCacheProtractorCannedJobs(db, mosShopId)
        );
      } else {
        // No usable cache — must fetch synchronously.
        cannedJobs = await fetchAndCacheProtractorCannedJobs(db, mosShopId);
        if (cannedJobs.length > 0) {
          source = "api";
        } else {
          // Graceful fallback: serve last-known-good cache (ignore TTL) when
          // the live fetch produced nothing.
          const stale = await db.collection("protractor_canned_jobs_cache").findOne({ shopId: mosShopId });
          if (stale?.cannedJobs?.length > 0) {
            cannedJobs = stale.cannedJobs;
            source = "stale_cache";
            console.warn(`[Extension Canned Jobs] Served ${cannedJobs.length} stale Protractor canned jobs for shop ${mosShopId} (fetchedAt=${stale.fetchedAt})`);
          }
        }
      }
    } else if (provider === "tekmetric" && tekmetricShopId) {
      const cached = refresh
        ? null
        : await db.collection("tekmetric_canned_jobs_cache").findOne({ shopId: tekmetricShopId });

      const cacheHasJobs = cached?.cannedJobs?.length > 0;
      const cacheAge = cached?.fetchedAt ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;

      if (cacheHasJobs && cacheAge < ONE_HOUR) {
        // Fresh cache — serve it.
        cannedJobs = cached.cannedJobs;
        source = "cache";
        console.log(`[Extension Canned Jobs] Cache hit for Tekmetric shop ${tekmetricShopId}: ${cannedJobs.length} jobs`);
      } else if (cacheHasJobs) {
        // Stale cache — serve it immediately and refresh in the background
        // (stale-while-revalidate) so the user never blocks on the upstream
        // fetch right after the 1-hour TTL expires.
        cannedJobs = cached.cannedJobs;
        source = "stale_revalidate";
        console.log(`[Extension Canned Jobs] Serving stale Tekmetric cache for shop ${tekmetricShopId} (age=${Math.round(cacheAge / 1000)}s) and revalidating in background`);
        revalidateInBackground(`tekmetric shop=${tekmetricShopId}`, () =>
          fetchAndCacheTekmetricCannedJobs(db, tekmetricShopId, mosShopId)
        );
      } else {
        // No usable cache — must fetch synchronously (per-page timeout inside).
        cannedJobs = await fetchAndCacheTekmetricCannedJobs(db, tekmetricShopId, mosShopId);
        if (cannedJobs.length > 0) {
          source = "api";
        } else {
          // Graceful fallback: serve the last-known-good cached row even if
          // it's past its 1h TTL. Better slightly stale than empty.
          const stale = await db.collection("tekmetric_canned_jobs_cache").findOne({
            shopId: tekmetricShopId,
          });
          if (stale?.cannedJobs?.length > 0) {
            cannedJobs = stale.cannedJobs;
            source = "stale_cache";
            console.warn(`[Extension Canned Jobs] Served ${cannedJobs.length} stale canned jobs for shop ${tekmetricShopId} (fetchedAt=${stale.fetchedAt})`);
          }
        }
      }
    }

    const shopIntervals = shop?.maintenanceIntervals || [];

    const effectiveSource = (hasProtractor && provider === "protractor") ? "protractor" : "tekmetric";

    const jobs = [
      ...cannedJobs.map((job: any) => ({
        id: job.id || job.code,
        tekmetricId: job.id,
        name: job.name || job.title,
        description: job.description || job.note || "",
        code: job.code,
        category: job.category || job.jobCategoryCode || "",
        source: effectiveSource,
        labor: job.labor || [],
        parts: job.parts || [],
        totalCost: job.totalCost || 0,
        packagePrice: job.packagePrice || false
      })),
      ...shopIntervals.map((interval: any) => ({
        id: `interval_${interval.service}`,
        name: interval.service,
        description: `Due every ${interval.miles?.toLocaleString()} miles or ${interval.months} months`,
        interval: interval.miles,
        source: "shop_interval",
        labor: [],
        parts: [],
        totalCost: 0
      }))
    ];

    return NextResponse.json({ 
      jobs,
      total: jobs.length,
      source,
      tekmetricShopId: tekmetricShopId || null
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Canned Jobs] Error:", error);
    return NextResponse.json(
      { error: "Failed to load canned jobs" },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
