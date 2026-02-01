import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { getCannedJobs } from "@/lib/tekmetric";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = String(session.shopId);
    if (!shopId) {
      return NextResponse.json({ error: "No shop associated" }, { status: 400 });
    }

    const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${shopId}`;
    const shop = shopRows[0] as any;
    const tekmetricShopId = shop?.tekmetric?.shopId || shop?.tekmetric_shop_id;
    
    if (!tekmetricShopId) {
      return NextResponse.json({
        cannedJobs: [],
        source: "none",
        message: "Tekmetric not configured",
      });
    }

    const refresh = req.nextUrl.searchParams.get("refresh") === "true";
    
    if (!refresh) {
      const cachedRows = await sql`
        SELECT * FROM tekmetric_canned_jobs_cache WHERE shop_id = ${String(tekmetricShopId)}
      `;
      const cached = cachedRows[0] as any;
      
      if (cached && cached.fetched_at) {
        const cacheAge = Date.now() - new Date(cached.fetched_at).getTime();
        const ONE_HOUR = 60 * 60 * 1000;
        if (cacheAge < ONE_HOUR) {
          return NextResponse.json({
            cannedJobs: cached.canned_jobs || [],
            source: "cache",
          });
        }
      }
    }

    let allCannedJobs: any[] = [];
    let page = 0;
    let hasMore = true;
    
    while (hasMore) {
      const response = await getCannedJobs(tekmetricShopId, { page, size: 100 });
      allCannedJobs = allCannedJobs.concat(response.content || []);
      hasMore = !response.last;
      page++;
      
      if (page > 20) break;
    }

    const normalizedJobs = allCannedJobs.map(job => ({
      id: String(job.id),
      code: String(job.id),
      title: job.name || `Canned Job ${job.id}`,
      description: job.description || "",
      laborAmount: job.laborAmount || 0,
      partsAmount: job.partsAmount || 0,
      totalAmount: job.totalAmount || 0,
    }));

    await sql`
      INSERT INTO tekmetric_canned_jobs_cache (shop_id, canned_jobs, fetched_at)
      VALUES (${String(tekmetricShopId)}, ${JSON.stringify(normalizedJobs)}::jsonb, NOW())
      ON CONFLICT (shop_id) DO UPDATE SET canned_jobs = ${JSON.stringify(normalizedJobs)}::jsonb, fetched_at = NOW()
    `;

    return NextResponse.json({
      cannedJobs: normalizedJobs,
      source: "api",
    });
  } catch (err: any) {
    console.error("[Tekmetric Canned Jobs] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
