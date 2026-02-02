import { NextRequest, NextResponse } from "next/server";
import { getPushToROStats } from "@/lib/extension-analytics";
import { getDb } from "@/lib/mongo";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const shopId = searchParams.get("shopId");
    const enterpriseId = searchParams.get("enterpriseId");
    const dateFilter = searchParams.get("dateFilter");
    const days = parseInt(searchParams.get("days") || "30");
    
    let startDate: Date;
    let endDate: Date | undefined;
    
    if (dateFilter === "today") {
      startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
    } else if (dateFilter === "yesterday") {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date();
      endDate.setHours(0, 0, 0, 0);
    } else {
      startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
    }

    const stats = await getPushToROStats({
      shopId: shopId ? Number(shopId) : undefined,
      enterpriseId: enterpriseId || undefined,
      startDate,
      endDate,
    });

    const db = await getDb();
    
    const timestampQuery: any = { $gte: startDate };
    if (endDate) timestampQuery.$lt = endDate;
    
    const matchStage: any = { 
      eventType: "push_to_ro",
      timestamp: timestampQuery
    };
    if (shopId) matchStage.shopId = Number(shopId);
    if (enterpriseId) matchStage.enterpriseId = enterpriseId;

    const [recentEvents, topUsers] = await Promise.all([
      db.collection("extension_analytics")
        .find({ eventType: "push_to_ro" })
        .sort({ timestamp: -1 })
        .limit(50)
        .toArray(),
      db.collection("extension_analytics").aggregate([
        { $match: matchStage },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]).toArray(),
    ]);

    return NextResponse.json({
      stats,
      topUsers: topUsers
        .filter(u => u._id)
        .map(u => ({ userId: u._id, count: u.count })),
      recentEvents: recentEvents.map(e => ({
        shopId: e.shopId,
        userId: e.userId,
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
