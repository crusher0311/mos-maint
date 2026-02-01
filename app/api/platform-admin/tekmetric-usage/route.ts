import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";
import { getTekmetricUsageStats, getUsageWarningLevel } from "@/lib/tekmetric-usage-tracker";

export const dynamic = "force-dynamic";

async function isPlatformAdmin(): Promise<boolean> {
  const store = await cookies();
  const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
  if (!sid) return false;

  const now = new Date();
  const sessRows = await sql`SELECT * FROM sessions WHERE token = ${sid} AND expires_at > ${now}`;
  const sess = sessRows[0] as any;
  if (!sess) return false;

  const userRows = await sql`SELECT * FROM users WHERE id = ${sess.user_id}`;
  const user = userRows[0] as any;
  return user?.is_platform_admin === true || user?.platform_admin === true;
}

export async function GET(request: NextRequest) {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const stats = await getTekmetricUsageStats();
    const warningLevel = await getUsageWarningLevel();

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    const hourlyUsage = await sql`
      SELECT 
        date_trunc('hour', timestamp) as hour,
        COUNT(*)::int as count,
        SUM(CASE WHEN is_429 THEN 1 ELSE 0 END)::int as errors_429,
        AVG(latency_ms)::float as avg_latency
      FROM tekmetric_api_usage
      WHERE timestamp >= ${oneDayAgo}
      GROUP BY date_trunc('hour', timestamp)
      ORDER BY hour
    `;

    const endpointBreakdown = await sql`
      SELECT 
        endpoint as _id,
        COUNT(*)::int as count,
        AVG(latency_ms)::float as avg_latency
      FROM tekmetric_api_usage
      WHERE timestamp >= ${oneDayAgo}
      GROUP BY endpoint
      ORDER BY count DESC
      LIMIT 10
    `;

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
      hourlyUsage: hourlyUsage.map((h: any) => ({
        hour: h.hour?.toISOString(),
        requests: h.count,
        errors429: h.errors_429,
        avgLatencyMs: Math.round(h.avg_latency || 0)
      })),
      endpointBreakdown: endpointBreakdown.map((e: any) => ({
        endpoint: e._id,
        count: e.count,
        avgLatencyMs: Math.round(e.avg_latency || 0)
      }))
    });
  } catch (error: any) {
    console.error("[Platform Admin] Tekmetric usage error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
