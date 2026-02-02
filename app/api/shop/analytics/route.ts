import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const startDateStr = searchParams.get("startDate");
    const endDateStr = searchParams.get("endDate");

    const db = await getDb();

    const dateFilter: any = {};
    if (startDateStr) dateFilter.$gte = new Date(startDateStr);
    if (endDateStr) dateFilter.$lte = new Date(endDateStr);

    const matchStage: any = { shopId };
    if (startDateStr || endDateStr) {
      matchStage.createdAt = dateFilter;
    }

    const eventsPipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: {
            eventType: "$eventType",
            recommendationType: "$recommendationType"
          },
          count: { $sum: 1 },
          totalRevenue: { $sum: { $ifNull: ["$totalPrice", 0] } },
          laborRevenue: { $sum: { $ifNull: ["$laborPrice", 0] } },
          partsRevenue: { $sum: { $ifNull: ["$partsPrice", 0] } }
        }
      }
    ];

    const events = await db.collection("recommendation_events")
      .aggregate(eventsPipeline)
      .toArray();

    let jobsAdded = 0;
    let jobsSold = 0;
    let totalRevenue = 0;
    let laborRevenue = 0;
    let partsRevenue = 0;

    const byType: Record<string, { added: number; sold: number; revenue: number }> = {};

    for (const event of events) {
      const { eventType, recommendationType } = event._id;
      
      if (!byType[recommendationType]) {
        byType[recommendationType] = { added: 0, sold: 0, revenue: 0 };
      }

      if (eventType === "recommendation_added") {
        jobsAdded += event.count;
        byType[recommendationType].added += event.count;
      } else if (eventType === "recommendation_sold") {
        jobsSold += event.count;
        totalRevenue += event.totalRevenue;
        laborRevenue += event.laborRevenue;
        partsRevenue += event.partsRevenue;
        byType[recommendationType].sold += event.count;
        byType[recommendationType].revenue += event.totalRevenue;
      }
    }

    const dailyPipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            eventType: "$eventType"
          },
          count: { $sum: 1 },
          revenue: { $sum: { $ifNull: ["$totalPrice", 0] } }
        }
      },
      { $sort: { "_id.date": -1 } },
      { $limit: 60 }
    ];

    const dailyData = await db.collection("recommendation_events")
      .aggregate(dailyPipeline)
      .toArray();

    const dailyMap: Record<string, { date: string; added: number; sold: number; revenue: number }> = {};
    
    for (const d of dailyData) {
      const date = d._id.date;
      if (!dailyMap[date]) {
        dailyMap[date] = { date, added: 0, sold: 0, revenue: 0 };
      }
      if (d._id.eventType === "recommendation_added") {
        dailyMap[date].added += d.count;
      } else if (d._id.eventType === "recommendation_sold") {
        dailyMap[date].sold += d.count;
        dailyMap[date].revenue += d.revenue;
      }
    }

    const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    const viewMatch: any = { shopId };
    if (startDateStr || endDateStr) {
      viewMatch.firstViewedAt = {};
      if (startDateStr) viewMatch.firstViewedAt.$gte = new Date(startDateStr);
      if (endDateStr) viewMatch.firstViewedAt.$lte = new Date(endDateStr);
    }
    const viewCount = await db.collection("viewed_vins").countDocuments(viewMatch);

    const usageMatch: any = { 
      $or: [
        { shopId: shopId },
        { shopId: String(shopId) }
      ]
    };
    if (startDateStr || endDateStr) {
      usageMatch.createdAt = dateFilter;
    }

    const usageStats = await db.collection("usage_logs").aggregate([
      { $match: usageMatch },
      {
        $group: {
          _id: null,
          totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
          totalRequests: { $sum: 1 },
          uniqueVins: { $addToSet: "$vin" }
        }
      }
    ]).toArray();

    const aiCost = usageStats[0]?.totalCost || 0;
    const aiRequests = usageStats[0]?.totalRequests || 0;
    const uniqueVinsProcessed = usageStats[0]?.uniqueVins?.filter(Boolean)?.length || 0;

    const costPerVin = uniqueVinsProcessed > 0 ? aiCost / uniqueVinsProcessed : 0;
    const costPerView = viewCount > 0 ? aiCost / viewCount : 0;

    const conversionRate = jobsAdded > 0 ? Math.round((jobsSold / jobsAdded) * 100) : 0;

    return NextResponse.json({
      ok: true,
      summary: {
        jobsAdded,
        jobsSold,
        totalRevenue,
        laborRevenue,
        partsRevenue,
        conversionRate,
        plansViewed: viewCount,
        aiCost,
        aiRequests,
        uniqueVinsProcessed,
        costPerVin,
        costPerView
      },
      byRecommendationType: Object.entries(byType).map(([type, data]) => ({
        type,
        ...data,
        conversionRate: data.added > 0 ? Math.round((data.sold / data.added) * 100) : 0
      })),
      daily
    });

  } catch (err: any) {
    console.error("Shop analytics error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
