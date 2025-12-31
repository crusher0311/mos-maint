import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken } from "@/lib/extension-auth";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const shopId = searchParams.get("shopId");

    if (!shopId) {
      return NextResponse.json(
        { error: "shopId is required" },
        { status: 400 }
      );
    }

    // Validate token AND shop access
    const auth = await validateExtensionToken(request, shopId);
    if (!auth.authorized) {
      const status = auth.error === "Unauthorized shop access" ? 403 : 401;
      return NextResponse.json({ error: auth.error }, { status });
    }

    const db = await getDb();

    // Get MOS enriched canned jobs for this shop
    const cannedJobs = await db.collection("canned_jobs")
      .find({ 
        shopId: parseInt(shopId),
        enriched: true 
      })
      .limit(100)
      .toArray();

    // Also get shop's custom maintenance intervals
    const shop = await db.collection("shops").findOne({ 
      shopId: parseInt(shopId) 
    });

    const shopIntervals = shop?.maintenanceIntervals || [];

    // Combine and format
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
    });

  } catch (error: any) {
    console.error("[Extension Canned Jobs] Error:", error);
    return NextResponse.json(
      { error: "Failed to load canned jobs" },
      { status: 500 }
    );
  }
}
