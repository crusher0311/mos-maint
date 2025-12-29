import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { fetchCannedJobsWithCache } from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const maxAge = refresh ? 0 : undefined;

    const result = await fetchCannedJobsWithCache(shopId, maxAge);

    if (!result.ok) {
      if (result.error?.includes("not configured")) {
        return NextResponse.json({
          cannedJobs: [],
          source: "none",
          message: "Protractor not configured",
        });
      }
      console.error("[Canned Jobs] Fetch error:", result.error);
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    // Filter to only include jobs with alphanumeric codes (contain at least one letter)
    // This excludes purely numeric placeholder codes like "0001", "0002", etc.
    const filteredJobs = (result.cannedJobs || []).filter((job: any) => {
      if (!job.code) return false;
      const code = job.code.trim();
      if (!code) return false;
      // Must contain at least one letter (A-Z or a-z)
      return /[a-zA-Z]/.test(code);
    });

    return NextResponse.json({
      cannedJobs: filteredJobs,
      source: result.source,
    });
  } catch (err: any) {
    console.error("[Canned Jobs] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
