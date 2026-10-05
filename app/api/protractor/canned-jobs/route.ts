import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { fetchCannedJobsWithCache } from "@/lib/integrations/protractor";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMED_TRIAL_FORCE_REFRESH_ERROR =
  "PROTRACTOR_CANNED_JOBS_FORCE_REFRESH_UNAVAILABLE_DURING_TIMED_TRIAL";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    if (!shopId) {
      return NextResponse.json({ error: "No shop associated" }, { status: 400 });
    }

    const refresh = req.nextUrl.searchParams.get("refresh") === "true";

    const result = await runWithProtractorInteractiveTransport(
      shopId,
      () => fetchCannedJobsWithCache(shopId, undefined, { forceRefresh: refresh }),
    );

    if (!result.ok) {
      if (result.error?.includes("not configured")) {
        return NextResponse.json({
          cannedJobs: [],
          source: "none",
          message: "Protractor not configured",
        });
      }
      if (result.error === TIMED_TRIAL_FORCE_REFRESH_ERROR) {
        return NextResponse.json(
          {
            error: result.error,
            code: TIMED_TRIAL_FORCE_REFRESH_ERROR,
          },
          { status: 409 },
        );
      }
      console.error("[Canned Jobs] Fetch error:", result.error);
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Return all jobs - deep sync already filters by title presence
    return NextResponse.json({
      cannedJobs: result.cannedJobs || [],
      source: result.source,
    });
  } catch (err: any) {
    console.error("[Canned Jobs] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
