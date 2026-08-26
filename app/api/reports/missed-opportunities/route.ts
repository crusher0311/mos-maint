import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import {
  hasCurrentMissedOpportunityReportShape,
  normalizeMissedOpportunityReportCache,
  normalizeWindowDays,
} from "@/lib/missed-opportunities";
import {
  computeMissedOpportunityReport,
  REPORT_TTL_MS,
} from "@/lib/missed-opportunities-service";
import {
  getCachedMissedOppReport,
  setCachedMissedOppReport,
} from "@/lib/data/repositories/missed-opportunities";
import {
  classifyMissedOpportunityLoad,
  runMissedOpportunityRefresh,
} from "@/lib/missed-opportunities-refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Task #1146 — shop-level Missed Opportunities report.
 *
 * GET ?days=7|30|90[&refresh=1]
 *
 * Serves the per-(shop, window) cached report when it's younger than
 * REPORT_TTL_MS; otherwise recomputes (bounded work — see
 * lib/missed-opportunities-service.ts) and re-caches. `refresh=1` forces a
 * recompute. Gated behind the same premium entitlement as Estimate Assist,
 * whose matcher this report reuses.
 */
export async function GET(req: NextRequest) {
  const requestStartedAt = Date.now();
  const routeTimings: Record<string, number> = {};
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const shopId = Number(session.shopId);

    let stageStartedAt = Date.now();
    const entitlements = await getFeatureEntitlements(shopId);
    routeTimings.entitlementLookupMs = Date.now() - stageStartedAt;
    if (!entitlements.canUseFeature("estimate_assist")) {
      return NextResponse.json(
        {
          ok: false,
          code: "FEATURE_NOT_AVAILABLE",
          error: "The Missed Opportunities report is not included in your plan.",
          upgradeRequired: true,
        },
        { status: 402 },
      );
    }

    const windowDays = normalizeWindowDays(req.nextUrl.searchParams.get("days"));
    const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";

    stageStartedAt = Date.now();
    const cached = await getCachedMissedOppReport(shopId, windowDays);
    routeTimings.reportCacheReadMs = Date.now() - stageStartedAt;
    const cacheHasCurrentShape =
      cached && hasCurrentMissedOpportunityReportShape(cached.report);
    const fresh =
      cacheHasCurrentShape &&
      Date.now() - new Date(cached.generatedAt).getTime() < REPORT_TTL_MS;
    const loadMode = classifyMissedOpportunityLoad({
      hasUsableCache: Boolean(cacheHasCurrentShape),
      cacheIsFresh: Boolean(fresh),
      forceRefresh,
    });
    if (cached && loadMode === "fresh_hit") {
      logRouteTiming("fresh_hit");
      return NextResponse.json({
        ok: true,
        cached: true,
        report: normalizeMissedOpportunityReportCache(cached.report),
      });
    }

    const recompute = () => runMissedOpportunityRefresh(
      shopId,
      windowDays,
      async () => {
        const report = await computeMissedOpportunityReport(shopId, windowDays);
        const writeStartedAt = Date.now();
        await setCachedMissedOppReport(shopId, windowDays, report).catch((err: any) => {
          console.warn(`[MissedOpps] Shop ${shopId}: cache write failed:`, err?.message || err);
        });
        console.log(`[MissedOppsTiming] ${JSON.stringify({
          shopId,
          windowDays,
          cacheWriteMs: Date.now() - writeStartedAt,
        })}`);
        return report;
      },
    );

    // Any usable current-shape report is returned immediately on a normal
    // navigation. The browser follows with refresh=1, whose request remains
    // alive until the single-flight refresh completes.
    if (cached && loadMode === "stale_hit") {
      logRouteTiming("stale_hit", { refreshPending: true });
      return NextResponse.json({
        ok: true,
        cached: true,
        stale: false,
        refreshPending: true,
        report: normalizeMissedOpportunityReportCache(cached.report),
      });
    }

    try {
      const refresh = recompute();
      const report = await refresh.promise;
      logRouteTiming(forceRefresh ? "forced_refresh" : "cold_compute", {
        refreshJoined: refresh.joined,
      });
      return NextResponse.json({ ok: true, cached: false, report });
    } catch (computeErr: any) {
      // Degrade to the stale cache instead of a hard error when we have one.
      // DrizzleQueryError's message is just the SQL text; the actionable
      // driver error lives on `cause` — log both so the next failure is
      // diagnosable from the log feed.
      console.error(
        `[MissedOpps] Shop ${shopId}: compute failed:`,
        computeErr?.message || computeErr,
        computeErr?.cause ? `| cause: ${computeErr.cause?.message || computeErr.cause}` : "",
      );
      if (cached && cacheHasCurrentShape) {
        logRouteTiming("refresh_failure_fallback");
        return NextResponse.json({
          ok: true,
          cached: true,
          stale: true,
          report: normalizeMissedOpportunityReportCache(cached.report),
        });
      }
      return NextResponse.json(
        { ok: false, error: "Failed to build the report. Please try again." },
        { status: 500 },
      );
    }
    function logRouteTiming(cacheStatus: string, extra: Record<string, unknown> = {}) {
      console.log(`[MissedOppsTiming] ${JSON.stringify({
        shopId,
        windowDays,
        cacheStatus,
        ...routeTimings,
        routeElapsedMs: Date.now() - requestStartedAt,
        ...extra,
      })}`);
    }
  } catch (err: any) {
    console.error("[MissedOpps] route error:", err?.message || err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
