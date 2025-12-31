import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";

// Scoring weights
const SCORE_EXACT_TITLE = 100;
const SCORE_TITLE_PREFIX = 50;
const SCORE_TITLE_CONTAINS = 30;
const SCORE_CODE_MATCH = 40;
const SCORE_DESCRIPTION = 10;
const SCORE_YEAR_MATCH = 15;
const SCORE_MAKE_MATCH = 25;
const SCORE_MODEL_MATCH = 20;

function scoreJob(job: any, queryTokens: string[], queryFull: string, year?: string, make?: string, model?: string): number {
  let score = 0;
  
  const title = (job.job?.title || job.title || "").toLowerCase();
  const description = (job.job?.description || job.description || "").toLowerCase();
  const code = (job.job?.code || job.code || "").toLowerCase();
  const jobYear = job.vehicle?.year?.toString() || "";
  const jobMake = (job.vehicle?.make || "").toLowerCase();
  const jobModel = (job.vehicle?.model || "").toLowerCase();
  
  // Title scoring
  if (title === queryFull) {
    score += SCORE_EXACT_TITLE;
  } else if (title.startsWith(queryFull)) {
    score += SCORE_TITLE_PREFIX;
  } else if (title.includes(queryFull)) {
    score += SCORE_TITLE_CONTAINS;
  } else {
    // Token matching in title
    const matchingTokens = queryTokens.filter(t => title.includes(t));
    score += matchingTokens.length * (SCORE_TITLE_CONTAINS / queryTokens.length);
  }
  
  // Code scoring
  if (code && queryTokens.some(t => code.includes(t))) {
    score += SCORE_CODE_MATCH;
  }
  
  // Description scoring
  const descTokenMatches = queryTokens.filter(t => description.includes(t)).length;
  score += (descTokenMatches / Math.max(queryTokens.length, 1)) * SCORE_DESCRIPTION;
  
  // Y/M/M boosting - prioritize jobs from same vehicle type
  if (year && jobYear === year) {
    score += SCORE_YEAR_MATCH;
  }
  if (make && jobMake === make.toLowerCase()) {
    score += SCORE_MAKE_MATCH;
  }
  if (model && jobModel.includes(model.toLowerCase())) {
    score += SCORE_MODEL_MATCH;
  }
  
  return score;
}

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
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const db = await getDb();
    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    let mosShopId: number | null = null;
    
    if (smsShopId) {
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
    
    console.log(`[Jobs Search] Query: "${query}", Y/M/M: ${year}/${make}/${model}, limit: ${limit}`);

    const jobsCollection = db.collection("job_index");

    // Use regex search instead of $text (no text index required)
    const searchRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const searchQuery: Record<string, any> = {
      $or: [
        { "job.title": searchRegex },
        { "title": searchRegex },
        { "job.description": searchRegex },
        { "job.code": searchRegex }
      ]
    };

    if (mosShopId) {
      searchQuery.shopId = mosShopId;
    } else if (!isPlatformAdmin) {
      searchQuery.shopId = { $in: userShopIds };
    }

    // Fetch more candidates for proper scoring
    const jobs: any[] = await jobsCollection
      .find(searchQuery)
      .limit(limit * 5)
      .toArray();

    // Prepare query for scoring
    const queryFull = query.toLowerCase().trim();
    const queryTokens = queryFull.split(/\s+/).filter(t => t.length > 1);

    // Score each job using weighted algorithm
    const scoredJobs = jobs.map((job: any) => {
      const matchScore = scoreJob(job, queryTokens, queryFull, year || undefined, make || undefined, model || undefined);
      return { ...job, matchScore };
    });

    // Sort by relevance score (highest first)
    scoredJobs.sort((a: any, b: any) => b.matchScore - a.matchScore);

    const formattedJobs = scoredJobs.slice(0, limit).map((job: any) => ({
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
      source: job.source || "protractor"
    }));

    return NextResponse.json({ 
      jobs: formattedJobs,
      total: formattedJobs.length,
      query
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Jobs Search] Error:", error);
    return NextResponse.json(
      { error: "Search failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}
