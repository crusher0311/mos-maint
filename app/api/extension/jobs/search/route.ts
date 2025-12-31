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

    const jobs: any[] = await jobsCollection
      .find(searchQuery)
      .sort({ createdAt: -1 })
      .limit(limit * 3)
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
