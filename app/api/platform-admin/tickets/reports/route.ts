import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();

    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") || "30");

    const db = await getDb();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const tickets = await db.collection("support_tickets")
      .find({ createdAt: { $gte: startDate } })
      .toArray();

    const statusCounts = {
      open: 0,
      inProgress: 0,
      resolved: 0,
      closed: 0
    };

    const byCategory: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    const byUser: Record<string, { count: number; shopName: string | null }> = {};
    let totalResolutionTime = 0;
    let resolvedCount = 0;

    for (const ticket of tickets) {
      if (ticket.status === "open") statusCounts.open++;
      else if (ticket.status === "in_progress") statusCounts.inProgress++;
      else if (ticket.status === "resolved") statusCounts.resolved++;
      else if (ticket.status === "closed") statusCounts.closed++;

      const cat = ticket.category || "general";
      byCategory[cat] = (byCategory[cat] || 0) + 1;

      const pri = ticket.priority || "medium";
      byPriority[pri] = (byPriority[pri] || 0) + 1;

      const dayKey = new Date(ticket.createdAt).toISOString().split("T")[0];
      byDay[dayKey] = (byDay[dayKey] || 0) + 1;

      const email = ticket.userEmail;
      if (!byUser[email]) {
        byUser[email] = { count: 0, shopName: ticket.shopName || null };
      }
      byUser[email].count++;

      if ((ticket.status === "resolved" || ticket.status === "closed") && ticket.resolvedAt) {
        const createdAt = new Date(ticket.createdAt).getTime();
        const resolvedAt = new Date(ticket.resolvedAt).getTime();
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
      .map(([email, data]) => ({ email, shopName: data.shopName, count: data.count }))
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
