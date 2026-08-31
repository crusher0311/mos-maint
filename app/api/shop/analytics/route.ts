import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  summarizeRecommendationEvents,
  dailyRecommendationEvents,
} from "@/lib/data/repositories/plan-cache-store";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";

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
  const entitlements = await getFeatureEntitlements(shopId);
  if (!canAccessShopFeature(session, entitlements, "maintenance")) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const startDateStr = searchParams.get("startDate");
    const endDateStr = searchParams.get("endDate");

    const db = await getDb();

    const startDate = startDateStr ? new Date(startDateStr) : undefined;
    const endDate = endDateStr ? new Date(endDateStr) : undefined;

    // Task #998: flag-dispatched PG/Mongo facade aggregation.
    const events = await summarizeRecommendationEvents(shopId, startDate, endDate, db);

    let jobsAdded = 0;
    let jobsSold = 0;
    let totalRevenue = 0;
    let laborRevenue = 0;
    let partsRevenue = 0;

    const byType: Record<string, { added: number; sold: number; revenue: number }> = {};

    for (const event of events) {
      const { eventType, recommendationType } = event as {
        eventType: string | null;
        recommendationType: string;
      };
      
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

    // Task #998: flag-dispatched PG/Mongo facade aggregation.
    const dailyData = await dailyRecommendationEvents(shopId, startDate, endDate, 60, db);

    const dailyMap: Record<string, { date: string; added: number; sold: number; revenue: number }> = {};
    
    for (const d of dailyData) {
      const date = d.date;
      if (!dailyMap[date]) {
        dailyMap[date] = { date, added: 0, sold: 0, revenue: 0 };
      }
      if (d.eventType === "recommendation_added") {
        dailyMap[date].added += d.count;
      } else if (d.eventType === "recommendation_sold") {
        dailyMap[date].sold += d.count;
        dailyMap[date].revenue += d.revenue;
      }
    }

    const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    // Wave 1 (task #342): viewed_vins is canonical in Postgres.
    const { getDb: getPg } = await import("@/lib/db/drizzle");
    const { viewedVins } = await import("@/lib/db/schema/wave1");
    const { sql: sqlPg, eq: eqPg, and: andPg, gte: gtePg, lte: ltePg } =
      await import("drizzle-orm");
    const vConds: any[] = [eqPg(viewedVins.shopId, shopId)];
    if (startDateStr) vConds.push(gtePg(viewedVins.firstViewedAt, new Date(startDateStr)));
    if (endDateStr) vConds.push(ltePg(viewedVins.firstViewedAt, new Date(endDateStr)));
    const [vRow] = await getPg()
      .select({ c: sqlPg<number>`count(*)::int` })
      .from(viewedVins)
      .where(andPg(...vConds));
    const viewCount = Number(vRow?.c ?? 0);

    const usageMatch: any = { 
      $or: [
        { shopId: shopId },
        { shopId: String(shopId) }
      ]
    };
    if (startDateStr || endDateStr) {
      const dateFilter: Record<string, Date> = {};
      if (startDate) dateFilter.$gte = startDate;
      if (endDate) dateFilter.$lte = endDate;
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
