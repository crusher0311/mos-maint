import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { getCannedJobs } from "@/lib/tekmetric";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const smsShopId = searchParams.get("shopId");
    const provider = searchParams.get("provider") || "tekmetric";
    const refresh = searchParams.get("refresh") === "true";

    if (!smsShopId) {
      return NextResponse.json(
        { error: "shopId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    const providerParam = searchParams.get("provider") || undefined;
    const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin, providerHint: providerParam });
    
    if (!shopResult) {
      return NextResponse.json(
        { error: `No accessible shop configured for SMS shop ID ${smsShopId}` },
        { status: 404, headers: corsHeaders }
      );
    }
    
    const mosShopId = shopResult.mosShopId;
    const db = await getDb();

    const shop = await db.collection("shops").findOne({ shopId: mosShopId });
    const tekmetricShopId = shop?.tekmetric?.shopId || shop?.tekmetricShopId;

    let cannedJobs: any[] = [];
    let source = "none";

    if (provider === "tekmetric" && tekmetricShopId) {
      const ONE_HOUR = 60 * 60 * 1000;
      
      if (!refresh) {
        const cached = await db.collection("tekmetric_canned_jobs_cache").findOne({ 
          shopId: tekmetricShopId 
        });
        
        if (cached && cached.fetchedAt) {
          const cacheAge = Date.now() - new Date(cached.fetchedAt).getTime();
          if (cacheAge < ONE_HOUR && cached.cannedJobs?.length > 0) {
            cannedJobs = cached.cannedJobs;
            source = "cache";
            console.log(`[Extension Canned Jobs] Cache hit for Tekmetric shop ${tekmetricShopId}: ${cannedJobs.length} jobs`);
          }
        }
      }

      if (cannedJobs.length === 0) {
        try {
          console.log(`[Extension Canned Jobs] Fetching from Tekmetric API for shop ${tekmetricShopId}`);
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

          await db.collection("tekmetric_canned_jobs_cache").updateOne(
            { shopId: tekmetricShopId },
            {
              $set: {
                shopId: tekmetricShopId,
                mosShopId: mosShopId,
                cannedJobs: cannedJobs,
                fetchedAt: new Date(),
              }
            },
            { upsert: true }
          );

          source = "api";
          console.log(`[Extension Canned Jobs] Fetched ${cannedJobs.length} jobs from Tekmetric API`);
        } catch (err: any) {
          console.error("[Extension Canned Jobs] Tekmetric API error:", err.message);
        }
      }
    }

    const shopIntervals = shop?.maintenanceIntervals || [];

    const jobs = [
      ...cannedJobs.map((job: any) => ({
        id: job.id || job.code,
        tekmetricId: job.id,
        name: job.name || job.title,
        description: job.description || job.note || "",
        code: job.code,
        category: job.category || job.jobCategoryCode || "",
        source: "tekmetric",
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
