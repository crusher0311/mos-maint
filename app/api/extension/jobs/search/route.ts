import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";

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
    const shopId = searchParams.get("shopId");
    const year = searchParams.get("year");
    const make = searchParams.get("make");
    const model = searchParams.get("model");
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);

    const auth = await validateExtensionToken(request, shopId || undefined);
    if (!auth.authorized) {
      const status = auth.error === "Unauthorized shop access" ? 403 : 401;
      return NextResponse.json({ error: auth.error }, { status, headers: corsHeaders });
    }

    if (!query.trim()) {
      return NextResponse.json({ jobs: [] }, { headers: corsHeaders });
    }

    const db = await getDb();
    const jobsCollection = db.collection("job_index");

    const searchQuery: Record<string, any> = {
      $text: { $search: query }
    };

    if (shopId) {
      searchQuery.shopId = parseInt(shopId);
    } else {
      const userShopIds = getUserShopIds(auth.user);
      if (userShopIds.length > 0) {
        searchQuery.shopId = { $in: userShopIds.map(id => parseInt(id)) };
      }
    }

    const jobs: any[] = await jobsCollection
      .aggregate([
        { $match: searchQuery },
        { $addFields: { score: { $meta: "textScore" } } },
        { $sort: { score: -1 } },
        { $limit: limit * 3 }
      ])
      .toArray();

    const scoredJobs = jobs.map((job: any) => {
      let matchScore = 0;
      
      if (year && job.vehicle?.year === parseInt(year)) matchScore += 3;
      if (make && job.vehicle?.make?.toLowerCase() === make.toLowerCase()) matchScore += 2;
      if (model && job.vehicle?.model?.toLowerCase().includes(model.toLowerCase())) matchScore += 1;
      
      return { ...job, matchScore };
    });

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
