import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { getTekmetricUsageStats, getUsageWarningLevel } from "@/lib/tekmetric-usage-tracker";

export const dynamic = "force-dynamic";

async function isPlatformAdmin(): Promise<boolean> {
  const store = await cookies();
  const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
  if (!sid) return false;

  const db = await getDb();
  const now = new Date();
  const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: now } });
  if (!sess) return false;

  const user = await db.collection("users").findOne({ _id: sess.userId });
  return user?.isPlatformAdmin === true;
}

export async function GET(request: NextRequest) {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const stats = await getTekmetricUsageStats();
    const warningLevel = await getUsageWarningLevel();

    const db = await getDb();
    
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    const hourlyUsage = await db.collection("tekmetric_api_usage").aggregate([
      { $match: { timestamp: { $gte: oneDayAgo } } },
      { 
        $group: { 
          _id: { 
            $dateToString: { format: "%Y-%m-%dT%H:00:00Z", date: "$timestamp" } 
          },
          count: { $sum: 1 },
          errors429: { $sum: { $cond: ["$is429", 1, 0] } },
          avgLatency: { $avg: "$latencyMs" }
        } 
      },
      { $sort: { _id: 1 } }
    ]).toArray();

    const endpointBreakdown = await db.collection("tekmetric_api_usage").aggregate([
      { $match: { timestamp: { $gte: oneDayAgo } } },
      { 
        $group: { 
          _id: "$endpoint",
          count: { $sum: 1 },
          avgLatency: { $avg: "$latencyMs" }
        } 
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]).toArray();

    return NextResponse.json({
      current: {
        requestsPerMinute: stats.currentMinuteRequests,
        limit: stats.requestsPerMinuteLimit,
        usagePercent: stats.usagePercent,
        warningLevel,
        last5Minutes: stats.last5MinutesRequests,
        last60Minutes: stats.last60MinutesRequests,
        avgRequestsPerMinute: Math.round(stats.last60MinutesRequests / 60)
      },
      alerts: {
        is429Count: stats.is429Count,
        recentErrors: stats.recentErrors
      },
      topShops: stats.topShops,
      hourlyUsage: hourlyUsage.map(h => ({
        hour: h._id,
        requests: h.count,
        errors429: h.errors429,
        avgLatencyMs: Math.round(h.avgLatency || 0)
      })),
      endpointBreakdown: endpointBreakdown.map(e => ({
        endpoint: e._id,
        count: e.count,
        avgLatencyMs: Math.round(e.avgLatency || 0)
      }))
    });
  } catch (error: any) {
    console.error("[Platform Admin] Tekmetric usage error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
