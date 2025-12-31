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
    const smsShopId = searchParams.get("shopId");
    const provider = searchParams.get("provider") || "tekmetric";

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

    const db = await getDb();
    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    let mosShopId: number | null = null;
    
    if (provider === "tekmetric") {
      const query: any = { "tekmetric.shopId": parseInt(smsShopId) };
      if (!isPlatformAdmin) {
        query.shopId = { $in: userShopIds };
      }
      const shop = await db.collection("shops").findOne(query);
      if (shop) {
        mosShopId = shop.shopId;
      }
    } else if (provider === "protractor") {
      const query: any = { "protractor.connectionId": smsShopId };
      if (!isPlatformAdmin) {
        query.shopId = { $in: userShopIds };
      }
      const shop = await db.collection("shops").findOne(query);
      if (shop) {
        mosShopId = shop.shopId;
      }
    }

    if (!mosShopId) {
      return NextResponse.json(
        { error: `No accessible shop configured for ${provider}` },
        { status: 404, headers: corsHeaders }
      );
    }

    const cannedJobs = await db.collection("canned_jobs")
      .find({ 
        shopId: mosShopId,
        enriched: true 
      })
      .limit(100)
      .toArray();

    const shop = await db.collection("shops").findOne({ 
      shopId: mosShopId 
    });

    const shopIntervals = shop?.maintenanceIntervals || [];

    const jobs = [
      ...cannedJobs.map((job: any) => ({
        id: job._id.toString(),
        name: job.title || job.name,
        description: job.description,
        code: job.code,
        chapter: job.chapter,
        interval: job.maintenanceInterval,
        source: "mos",
        laborItems: job.laborLines || [],
        parts: job.partLines || [],
        amount: job.totalAmount || 0
      })),
      ...shopIntervals.map((interval: any) => ({
        id: `interval_${interval.service}`,
        name: interval.service,
        description: `Due every ${interval.miles?.toLocaleString()} miles or ${interval.months} months`,
        interval: interval.miles,
        source: "shop_interval",
        laborItems: [],
        parts: [],
        amount: 0
      }))
    ];

    return NextResponse.json({ 
      jobs,
      total: jobs.length
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Canned Jobs] Error:", error);
    return NextResponse.json(
      { error: "Failed to load canned jobs" },
      { status: 500, headers: corsHeaders }
    );
  }
}
