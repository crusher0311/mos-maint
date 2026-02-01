import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = String(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const startDateStr = searchParams.get("startDate");
    const endDateStr = searchParams.get("endDate");

    let dateFilter = "";
    const params: any[] = [shopId];
    
    if (startDateStr && endDateStr) {
      dateFilter = ` AND created_at >= $2 AND created_at <= $3`;
      params.push(new Date(startDateStr), new Date(endDateStr));
    } else if (startDateStr) {
      dateFilter = ` AND created_at >= $2`;
      params.push(new Date(startDateStr));
    } else if (endDateStr) {
      dateFilter = ` AND created_at <= $2`;
      params.push(new Date(endDateStr));
    }

    const events = await sql`
      SELECT 
        event_type,
        recommendation_type,
        COUNT(*)::int as count,
        SUM(COALESCE(total_price, 0))::float as total_revenue,
        SUM(COALESCE(labor_price, 0))::float as labor_revenue,
        SUM(COALESCE(parts_price, 0))::float as parts_revenue
      FROM recommendation_events
      WHERE shop_id = ${shopId}
        ${startDateStr ? sql`AND created_at >= ${new Date(startDateStr)}` : sql``}
        ${endDateStr ? sql`AND created_at <= ${new Date(endDateStr)}` : sql``}
      GROUP BY event_type, recommendation_type
    `;

    let jobsAdded = 0;
    let jobsSold = 0;
    let totalRevenue = 0;
    let laborRevenue = 0;
    let partsRevenue = 0;

    const byType: Record<string, { added: number; sold: number; revenue: number }> = {};

    for (const event of events) {
      const e = event as any;
      const { event_type, recommendation_type } = e;
      
      if (!byType[recommendation_type]) {
        byType[recommendation_type] = { added: 0, sold: 0, revenue: 0 };
      }

      if (event_type === "recommendation_added") {
        jobsAdded += e.count;
        byType[recommendation_type].added += e.count;
      } else if (event_type === "recommendation_sold") {
        jobsSold += e.count;
        totalRevenue += e.total_revenue || 0;
        laborRevenue += e.labor_revenue || 0;
        partsRevenue += e.parts_revenue || 0;
        byType[recommendation_type].sold += e.count;
        byType[recommendation_type].revenue += e.total_revenue || 0;
      }
    }

    const dailyData = await sql`
      SELECT 
        DATE(created_at) as date,
        event_type,
        COUNT(*)::int as count,
        SUM(COALESCE(total_price, 0))::float as revenue
      FROM recommendation_events
      WHERE shop_id = ${shopId}
        ${startDateStr ? sql`AND created_at >= ${new Date(startDateStr)}` : sql``}
        ${endDateStr ? sql`AND created_at <= ${new Date(endDateStr)}` : sql``}
      GROUP BY DATE(created_at), event_type
      ORDER BY date DESC
      LIMIT 60
    `;

    const dailyMap: Record<string, { date: string; added: number; sold: number; revenue: number }> = {};
    
    for (const d of dailyData) {
      const dd = d as any;
      const date = dd.date?.toISOString?.()?.split("T")?.[0] || String(dd.date);
      if (!dailyMap[date]) {
        dailyMap[date] = { date, added: 0, sold: 0, revenue: 0 };
      }
      if (dd.event_type === "recommendation_added") {
        dailyMap[date].added += dd.count;
      } else if (dd.event_type === "recommendation_sold") {
        dailyMap[date].sold += dd.count;
        dailyMap[date].revenue += dd.revenue || 0;
      }
    }

    const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    const viewCountResult = await sql`
      SELECT COUNT(*)::int as count FROM viewed_vins
      WHERE shop_id = ${shopId}
        ${startDateStr ? sql`AND first_viewed_at >= ${new Date(startDateStr)}` : sql``}
        ${endDateStr ? sql`AND first_viewed_at <= ${new Date(endDateStr)}` : sql``}
    `;
    const viewCount = (viewCountResult[0] as any)?.count ?? 0;

    const usageStats = await sql`
      SELECT 
        SUM(COALESCE(estimated_cost, 0))::float as total_cost,
        COUNT(*)::int as total_requests,
        COUNT(DISTINCT vin) as unique_vins
      FROM usage_logs
      WHERE shop_id = ${shopId}
        ${startDateStr ? sql`AND created_at >= ${new Date(startDateStr)}` : sql``}
        ${endDateStr ? sql`AND created_at <= ${new Date(endDateStr)}` : sql``}
    `;

    const aiCost = (usageStats[0] as any)?.total_cost || 0;
    const aiRequests = (usageStats[0] as any)?.total_requests || 0;
    const uniqueVinsProcessed = (usageStats[0] as any)?.unique_vins || 0;

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
