import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { 
  fetchCannedJobs, 
  enrichCannedJobsWithDetails,
  upsertCannedJobsCache,
  ProtractorCannedJob 
} from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900; // 15 minutes max

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    if (!shopId) {
      return NextResponse.json({ error: "No shop associated" }, { status: 400 });
    }

    console.log(`[Canned Jobs Enrich] Starting deep sync for shop ${shopId}...`);

    // Step 1: Fetch all canned jobs from list
    const listResult = await fetchCannedJobs(shopId);
    if (!listResult.ok || !listResult.cannedJobs) {
      console.error("[Canned Jobs Enrich] Failed to fetch list:", listResult.error);
      return NextResponse.json({ error: listResult.error }, { status: 500 });
    }

    const totalJobs = listResult.cannedJobs.length;
    console.log(`[Canned Jobs Enrich] Fetched ${totalJobs} jobs from list, starting enrichment...`);

    // Step 2: Enrich with details (filtering out empty titles)
    const enrichedJobs = await enrichCannedJobsWithDetails(
      shopId, 
      listResult.cannedJobs,
      { filterEmptyTitles: true }
    );

    console.log(`[Canned Jobs Enrich] Enrichment complete: ${enrichedJobs.length} useful jobs found`);

    // Step 3: Save to cache
    await upsertCannedJobsCache(shopId, enrichedJobs as ProtractorCannedJob[]);

    return NextResponse.json({
      ok: true,
      totalScanned: totalJobs,
      usefulJobs: enrichedJobs.length,
      message: `Scanned ${totalJobs} items, found ${enrichedJobs.length} with titles/content`,
    });
  } catch (err: any) {
    console.error("[Canned Jobs Enrich] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
