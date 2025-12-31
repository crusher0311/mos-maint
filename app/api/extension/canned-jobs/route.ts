import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken } from "@/lib/extension-auth";

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
    const shopId = searchParams.get("shopId");

    if (!shopId) {
      return NextResponse.json(
        { error: "shopId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const auth = await validateExtensionToken(request, shopId);
    if (!auth.authorized) {
      const status = auth.error === "Unauthorized shop access" ? 403 : 401;
      return NextResponse.json({ error: auth.error }, { status, headers: corsHeaders });
    }

    const db = await getDb();

    const cannedJobs = await db.collection("canned_jobs")
      .find({ 
        shopId: parseInt(shopId),
        enriched: true 
      })
      .limit(100)
      .toArray();

    const shop = await db.collection("shops").findOne({ 
      shopId: parseInt(shopId) 
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
