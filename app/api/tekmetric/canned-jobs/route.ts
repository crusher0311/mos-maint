import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getCannedJobs } from "@/lib/tekmetric";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const shopId = Number(session.shopId);
    if (!shopId) {
      return NextResponse.json({ error: "No shop associated" }, { status: 400 });
    }

    const shop = await db.collection("shops").findOne({ shopId });
    const tekmetricShopId = shop?.tekmetric?.shopId || shop?.tekmetricShopId;
    
    if (!tekmetricShopId) {
      return NextResponse.json({
        cannedJobs: [],
        source: "none",
        message: "Tekmetric not configured",
      });
    }

    const refresh = req.nextUrl.searchParams.get("refresh") === "true";
    const cacheKey = `tekmetric_canned_jobs_${tekmetricShopId}`;
    
    if (!refresh) {
      const cached = await db.collection("tekmetric_canned_jobs_cache").findOne({ 
        shopId: tekmetricShopId 
      });
      
      if (cached && cached.fetchedAt) {
        const cacheAge = Date.now() - new Date(cached.fetchedAt).getTime();
        const ONE_HOUR = 60 * 60 * 1000;
        if (cacheAge < ONE_HOUR) {
          return NextResponse.json({
            cannedJobs: cached.cannedJobs || [],
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

    await db.collection("tekmetric_canned_jobs_cache").updateOne(
      { shopId: tekmetricShopId },
      {
        $set: {
          shopId: tekmetricShopId,
          cannedJobs: normalizedJobs,
          fetchedAt: new Date(),
        }
      },
      { upsert: true }
    );

    return NextResponse.json({
      cannedJobs: normalizedJobs,
      source: "api",
    });
  } catch (err: any) {
    console.error("[Tekmetric Canned Jobs] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
