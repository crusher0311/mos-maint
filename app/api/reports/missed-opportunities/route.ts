import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { normalizeWindowDays } from "@/lib/missed-opportunities";
import {
  computeMissedOpportunityReport,
  REPORT_TTL_MS,
} from "@/lib/missed-opportunities-service";
import {
  getCachedMissedOppReport,
  setCachedMissedOppReport,
} from "@/lib/data/repositories/missed-opportunities";

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
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const shopId = Number(session.shopId);

    const entitlements = await getFeatureEntitlements(shopId);
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

    const cached = await getCachedMissedOppReport(shopId, windowDays);
    const fresh =
      cached &&
      Date.now() - new Date(cached.generatedAt).getTime() < REPORT_TTL_MS;
    if (cached && fresh && !forceRefresh) {
      return NextResponse.json({ ok: true, cached: true, report: cached.report });
    }

    try {
      const report = await computeMissedOpportunityReport(shopId, windowDays);
      await setCachedMissedOppReport(shopId, windowDays, report).catch((err) =>
        console.warn(`[MissedOpps] Shop ${shopId}: cache write failed:`, err?.message || err),
      );
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
      if (cached) {
        return NextResponse.json({
          ok: true,
          cached: true,
          stale: true,
          report: cached.report,
        });
      }
      return NextResponse.json(
        { ok: false, error: "Failed to build the report. Please try again." },
        { status: 500 },
      );
    }
  } catch (err: any) {
    console.error("[MissedOpps] route error:", err?.message || err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
