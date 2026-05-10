import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { 
  fetchCannedJobs, 
  enrichCannedJobsWithDetails,
  upsertCannedJobsCache,
  ProtractorCannedJob,
  clearPoisonedTemplate404sOnce,
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

    // Step 0 (task #405): one-shot cleanup of `is404`-poisoned entries in
    // protractor_template_cache, left behind by the old wrong-endpoint
    // enrichment path. Idempotent (gated by a marker doc), so safe to
    // call on every enrich; only the first call after deploy actually
    // does work. Don't fail the request if cleanup throws — the new
    // enrichment path uses a different cache collection and works fine
    // either way.
    try {
      const cleanup = await clearPoisonedTemplate404sOnce();
      if (!cleanup.skipped) {
        console.log(
          `[Canned Jobs Enrich] Task #405 cleanup ran: ${cleanup.deletedCount} poisoned entries deleted across ${cleanup.byShop?.length ?? 0} shops`,
        );
      }
    } catch (cleanupErr: any) {
      console.error("[Canned Jobs Enrich] Task #405 cleanup failed (continuing):", cleanupErr?.message);
    }

    // Step 1: Fetch all canned jobs from list
    const listResult = await fetchCannedJobs(shopId);
    if (!listResult.ok || !listResult.cannedJobs) {
      console.error("[Canned Jobs Enrich] Failed to fetch list:", listResult.error);
      return NextResponse.json({ error: listResult.error }, { status: 500 });
    }

    const totalJobs = listResult.cannedJobs.length;
    console.log(`[Canned Jobs Enrich] Fetched ${totalJobs} jobs from list, starting enrichment...`);

    // Step 2: Enrich with details (filtering out empty titles).
    // Pass `listSource` so enrichment hits the right detail endpoint —
    // `/ServicePackage/CannedJob/{id}` for v2.0 shops whose list came
    // from `/CannedJob/`, or the canonical bare `/ServicePackageTemplate/{id}`
    // for v1.0 / template-fallback shops like 116. (Task #406.)
    const enrichedJobs = await enrichCannedJobsWithDetails(
      shopId,
      listResult.cannedJobs,
      { filterEmptyTitles: true, listSource: listResult.source }
    );

    console.log(`[Canned Jobs Enrich] Enrichment complete: ${enrichedJobs.length} useful jobs found`);

    // Step 3: Save to cache
    // Mark as fully enriched: every item has been through
    // enrichCannedJobsWithDetails (titles + lines populated). This lets
    // fetchCannedJobsWithCache short-circuit to the cache instead of
    // re-fetching the empty-titled basic /CannedJob/ list and clobbering
    // this result. (Bug seen on shop 116 — task #387.)
    await upsertCannedJobsCache(shopId, enrichedJobs as ProtractorCannedJob[], { source: "enriched" });

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
