import { NextRequest, NextResponse } from "next/server";
import { getPushToROStats } from "@/lib/extension-analytics";
import { getDb } from "@/lib/mongo";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const shopId = searchParams.get("shopId");
    const enterpriseId = searchParams.get("enterpriseId");
    const days = parseInt(searchParams.get("days") || "30");
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const stats = await getPushToROStats({
      shopId: shopId ? Number(shopId) : undefined,
      enterpriseId: enterpriseId || undefined,
      startDate,
    });

    const db = await getDb();
    const recentEvents = await db.collection("extension_analytics")
      .find({ eventType: "push_to_ro" })
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray();

    return NextResponse.json({
      stats,
      recentEvents: recentEvents.map(e => ({
        shopId: e.shopId,
        jobTitle: e.jobTitle,
        jobSource: e.jobSource,
        vehicleYear: e.vehicleYear,
        vehicleMake: e.vehicleMake,
        vehicleModel: e.vehicleModel,
        timestamp: e.timestamp,
      })),
    });
  } catch (error: any) {
    console.error("Error fetching extension analytics:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
