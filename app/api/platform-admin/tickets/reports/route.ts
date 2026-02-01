import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();

    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") || "30");

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const tickets = await sql`
      SELECT * FROM support_tickets WHERE created_at >= ${startDate}
    `;

    const statusCounts = {
      open: 0,
      inProgress: 0,
      resolved: 0,
      closed: 0
    };

    const byCategory: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    const byUser: Record<string, { count: number; shopName: string | null; locationIdentifier: string | null }> = {};
    let totalResolutionTime = 0;
    let resolvedCount = 0;

    for (const ticket of tickets) {
      const t = ticket as any;
      if (t.status === "open") statusCounts.open++;
      else if (t.status === "in_progress") statusCounts.inProgress++;
      else if (t.status === "resolved") statusCounts.resolved++;
      else if (t.status === "closed") statusCounts.closed++;

      const cat = t.category || "general";
      byCategory[cat] = (byCategory[cat] || 0) + 1;

      const pri = t.priority || "medium";
      byPriority[pri] = (byPriority[pri] || 0) + 1;

      const dayKey = new Date(t.created_at).toISOString().split("T")[0];
      byDay[dayKey] = (byDay[dayKey] || 0) + 1;

      const email = t.user_email;
      if (email) {
        if (!byUser[email]) {
          byUser[email] = { count: 0, shopName: t.shop_name || null, locationIdentifier: t.location_identifier || null };
        }
        byUser[email].count++;
      }

      if ((t.status === "resolved" || t.status === "closed") && t.resolved_at) {
        const createdAt = new Date(t.created_at).getTime();
        const resolvedAt = new Date(t.resolved_at).getTime();
        totalResolutionTime += (resolvedAt - createdAt) / (1000 * 60 * 60);
        resolvedCount++;
      }
    }

    const byDayArray = [];
    const current = new Date(startDate);
    const end = new Date();
    while (current <= end) {
      const key = current.toISOString().split("T")[0];
      byDayArray.push({ date: key, count: byDay[key] || 0 });
      current.setDate(current.getDate() + 1);
    }

    const topUsers = Object.entries(byUser)
      .map(([email, data]) => ({ email, shopName: data.shopName, locationIdentifier: data.locationIdentifier, count: data.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const stats = {
      total: tickets.length,
      open: statusCounts.open,
      inProgress: statusCounts.inProgress,
      resolved: statusCounts.resolved,
      closed: statusCounts.closed,
      avgResolutionTimeHours: resolvedCount > 0 ? totalResolutionTime / resolvedCount : 0,
      byCategory,
      byPriority,
      byDay: byDayArray,
      topUsers
    };

    return NextResponse.json({ ok: true, stats });
  } catch (error: any) {
    console.error("Error fetching ticket reports:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to fetch reports" }, { status: 500 });
  }
}
