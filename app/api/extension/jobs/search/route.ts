import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";
import { scoreJob, buildSearchQuery, STOPWORDS, ScoredJob } from "@/lib/job-scoring";

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
    const query = searchParams.get("q") || "";
    const smsShopId = searchParams.get("shopId");
    const provider = searchParams.get("provider") || "tekmetric";
    const year = searchParams.get("year");
    const make = searchParams.get("make");
    const model = searchParams.get("model");
    const engine = searchParams.get("engine");
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const db = await getDb();
    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    // Use user's session shop if available (most reliable)
    // This ensures extension uses the same shop as the web app
    let mosShopId: number | null = auth.user.shopId ? parseInt(auth.user.shopId) : null;
    
    // Only fall back to SMS shop ID lookup if user doesn't have a session shop
    if (!mosShopId && smsShopId) {
      if (provider === "tekmetric") {
        const shopQuery: any = { "tekmetric.shopId": parseInt(smsShopId) };
        if (!isPlatformAdmin) {
          shopQuery.shopId = { $in: userShopIds };
        }
        const shop = await db.collection("shops").findOne(shopQuery);
        if (shop) {
          mosShopId = shop.shopId;
        }
      } else if (provider === "protractor") {
        const shopQuery: any = { "protractor.connectionId": smsShopId };
        if (!isPlatformAdmin) {
          shopQuery.shopId = { $in: userShopIds };
        }
        const shop = await db.collection("shops").findOne(shopQuery);
        if (shop) {
          mosShopId = shop.shopId;
        }
      }
    }

    if (!query.trim()) {
      return NextResponse.json({ jobs: [] }, { headers: corsHeaders });
    }
    
    console.log(`[Jobs Search] Query: "${query}", Y/M/M/E: ${year}/${make}/${model}/${engine}, shopId: ${mosShopId}`);

    const jobsCollection = db.collection("job_index");

    // Build search query using same stopword logic as web app
    const { coreTokens, allTokens } = buildSearchQuery(query);
    
    const matchStage: Record<string, any> = {};
    
    // Shop filter
    if (mosShopId) {
      matchStage.shopId = mosShopId;
    } else if (!isPlatformAdmin) {
      matchStage.shopId = { $in: userShopIds };
    }
    
    // Text search using same logic as web app
    if (coreTokens.length > 0) {
      matchStage.$or = [
        { "job.keywords": { $all: coreTokens } },
        { "job.title": { $regex: coreTokens.map(t => `(?=.*${t})`).join(""), $options: "i" } },
      ];
    } else if (allTokens.length > 0) {
      matchStage["job.keywords"] = { $in: allTokens };
    } else {
      // Fallback to regex on title
      const searchRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      matchStage.$or = [
        { "job.title": searchRegex },
        { "title": searchRegex },
      ];
    }
    
    // Optional make/model filtering for pre-filtering
    if (make) {
      matchStage["vehicle.make"] = { $regex: new RegExp(make, "i") };
    }

    // Fetch candidates
    const jobs: any[] = await jobsCollection
      .aggregate([
        { $match: matchStage },
        { $sort: { performedAt: -1 } },
        { $limit: limit * 5 }
      ])
      .toArray();

    console.log(`[Jobs Search] Found ${jobs.length} candidates for scoring`);

    // Score using shared scoring logic
    const targetVehicle = { year, make, model, engine };
    const scoredJobs: ScoredJob[] = jobs.map(job => scoreJob(job, targetVehicle));
    
    // Filter by gate pass and minimum score threshold
    const eligibleJobs = scoredJobs.filter(j => j.gatePass && j.matchScore >= 40);
    
    // Sort by score
    eligibleJobs.sort((a, b) => b.matchScore - a.matchScore);
    
    // Deduplicate by job title + vehicle
    const uniqueJobs = new Map<string, ScoredJob>();
    for (const job of eligibleJobs) {
      const key = `${job.job?.title || job.title || ''}-${job.vehicle?.make || ''}-${job.vehicle?.model || ''}-${job.vehicle?.year || ''}`;
      const existing = uniqueJobs.get(key);
      if (!existing || existing.matchScore < job.matchScore) {
        uniqueJobs.set(key, job);
      }
    }

    const results = Array.from(uniqueJobs.values()).slice(0, limit);

    const formattedJobs = results.map((job: any) => ({
      _id: job._id.toString(),
      title: job.job?.title || job.title || "Job",
      description: job.job?.description,
      code: job.job?.code,
      vehicle: job.vehicle,
      workOrderNumber: job.workOrderNumber,
      laborItems: (job.job?.lines || job.lines || [])
        .filter((l: any) => l.lineType === "labor")
        .map((l: any) => ({
          name: l.description,
          hours: l.quantity || l.hours || 1
        })),
      parts: (job.job?.lines || job.lines || [])
        .filter((l: any) => l.lineType === "part")
        .map((l: any) => ({
          name: l.description,
          partNumber: l.partNumber,
          brand: l.manufacturer,
          quantity: l.quantity || 1,
          cost: l.cost || 0,
          retail: l.unitPrice || l.extendedPrice || 0
        })),
      totals: job.job?.totals || job.totals || { totalAmount: 0 },
      matchScore: job.matchScore,
      matchBand: job.matchBand,
      matchBandLabel: job.matchBandLabel,
      matchReason: job.matchReason,
      source: job.source || "protractor"
    }));

    return NextResponse.json({ 
      jobs: formattedJobs,
      total: formattedJobs.length,
      query,
      stats: {
        totalFound: jobs.length,
        gatesFailed: scoredJobs.filter(j => !j.gatePass).length,
        belowThreshold: scoredJobs.filter(j => j.gatePass && j.matchScore < 40).length,
        returned: formattedJobs.length,
      }
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Jobs Search] Error:", error);
    return NextResponse.json(
      { error: "Search failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}
