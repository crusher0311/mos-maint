import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getPushToROStats } from "@/lib/extension-analytics";
import { getDb as getPg } from "@/lib/db/drizzle";
import { extensionAnalytics } from "@/lib/db/schema/wave1";
import { sql, eq, and, gte, lte, desc, type SQL } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();
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

    // Wave 1 (task #342): extension_analytics is canonical in Postgres.
    const conds: SQL[] = [eq(extensionAnalytics.eventType, "push_to_ro")];
    if (shopId) conds.push(eq(extensionAnalytics.shopId, Number(shopId)));
    if (enterpriseId) conds.push(eq(extensionAnalytics.enterpriseId, enterpriseId));
    if (startDate) conds.push(gte(extensionAnalytics.timestamp, startDate));
    if (endDate) conds.push(lte(extensionAnalytics.timestamp, endDate));
    const where = and(...conds);
    const pg = getPg();
    const [recentEvents, topUsers] = await Promise.all([
      pg
        .select()
        .from(extensionAnalytics)
        .where(eq(extensionAnalytics.eventType, "push_to_ro"))
        .orderBy(desc(extensionAnalytics.timestamp))
        .limit(50),
      pg
        .select({
          _id: extensionAnalytics.userId,
          count: sql<number>`count(*)::int`,
        })
        .from(extensionAnalytics)
        .where(where)
        .groupBy(extensionAnalytics.userId)
        .orderBy(desc(sql`count(*)`))
        .limit(20),
    ]);

    return NextResponse.json({
      stats,
      topUsers: topUsers
        .filter((u) => u._id)
        .map((u) => ({ userId: u._id, count: u.count })),
      recentEvents: recentEvents.map((e) => ({
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
  } catch (error) {
    console.error("Error fetching extension analytics:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
