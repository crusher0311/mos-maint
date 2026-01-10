import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getApiUsageStats, getHourlyUsage, ApiProvider, API_PROVIDER_CONFIGS } from "@/lib/api-usage-tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get('provider') as ApiProvider | null;

    const providersToFetch = provider 
      ? [provider] 
      : Object.keys(API_PROVIDER_CONFIGS) as ApiProvider[];
    
    // Fetch stats and hourly data in parallel for all providers
    const [stats, ...hourlyResults] = await Promise.all([
      getApiUsageStats(provider || undefined),
      ...providersToFetch.map(p => getHourlyUsage(p, 24))
    ]);
    
    const hourlyData: Record<string, any[]> = {};
    providersToFetch.forEach((p, i) => {
      hourlyData[p] = hourlyResults[i];
    });

    const hasWarnings = stats.some(s => s.warningLevel !== 'ok');
    const hasCritical = stats.some(s => s.warningLevel === 'critical' || s.warningLevel === 'stopped');

    const totalRequests = stats.reduce((sum, s) => sum + s.last60Minutes, 0);
    const totalErrors = stats.reduce((sum, s) => sum + s.errorCount, 0);
    const totalRateLimits = stats.reduce((sum, s) => sum + s.rateLimitCount, 0);

    return NextResponse.json({
      summary: {
        totalRequestsLastHour: totalRequests,
        totalErrorsLastHour: totalErrors,
        totalRateLimitsLastHour: totalRateLimits,
        overallStatus: hasCritical ? 'critical' : hasWarnings ? 'warning' : 'ok'
      },
      providers: stats.map(s => ({
        ...s,
        hourlyUsage: hourlyData[s.provider] || []
      })),
      lastUpdated: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("[Platform Admin] API usage error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
