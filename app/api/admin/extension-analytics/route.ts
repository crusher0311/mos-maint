import { NextRequest, NextResponse } from "next/server";
import { getPushToROStats } from "@/lib/extension-analytics";
import sql from "@/lib/db/postgres";

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

    let recentEvents;
    let topUsers;

    if (shopId && endDate) {
      recentEvents = await sql`
        SELECT * FROM extension_analytics 
        WHERE event_type = 'push_to_ro' AND shop_id = ${shopId}
        AND timestamp >= ${startDate} AND timestamp < ${endDate}
        ORDER BY timestamp DESC LIMIT 50
      `;
      topUsers = await sql`
        SELECT user_id, COUNT(*) as count FROM extension_analytics
        WHERE event_type = 'push_to_ro' AND shop_id = ${shopId}
        AND timestamp >= ${startDate} AND timestamp < ${endDate}
        GROUP BY user_id ORDER BY count DESC LIMIT 20
      `;
    } else if (shopId) {
      recentEvents = await sql`
        SELECT * FROM extension_analytics 
        WHERE event_type = 'push_to_ro' AND shop_id = ${shopId}
        AND timestamp >= ${startDate}
        ORDER BY timestamp DESC LIMIT 50
      `;
      topUsers = await sql`
        SELECT user_id, COUNT(*) as count FROM extension_analytics
        WHERE event_type = 'push_to_ro' AND shop_id = ${shopId}
        AND timestamp >= ${startDate}
        GROUP BY user_id ORDER BY count DESC LIMIT 20
      `;
    } else {
      recentEvents = await sql`
        SELECT * FROM extension_analytics 
        WHERE event_type = 'push_to_ro'
        ORDER BY timestamp DESC LIMIT 50
      `;
      topUsers = await sql`
        SELECT user_id, COUNT(*) as count FROM extension_analytics
        WHERE event_type = 'push_to_ro' AND timestamp >= ${startDate}
        GROUP BY user_id ORDER BY count DESC LIMIT 20
      `;
    }

    return NextResponse.json({
      stats,
      topUsers: topUsers
        .filter(u => u.user_id)
        .map(u => ({ userId: u.user_id, count: Number(u.count) })),
      recentEvents: recentEvents.map(e => ({
        shopId: e.shop_id,
        userId: e.user_id,
        jobTitle: e.job_title,
        jobSource: e.job_source,
        vehicleYear: e.vehicle_year,
        vehicleMake: e.vehicle_make,
        vehicleModel: e.vehicle_model,
        timestamp: e.timestamp,
      })),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Error fetching extension analytics:", message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
