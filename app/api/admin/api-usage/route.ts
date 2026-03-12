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
  if (!["owner", "admin"].includes(session.role || "")) {
    return NextResponse.json({ error: "Forbidden - admin access required" }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const provider = searchParams.get("provider") || "tekmetric";

    const db = await getDb();
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);

    const [
      lastMinuteCount,
      lastHourCount,
      last24hCount,
      lastHourErrors,
      last24hErrors,
      lastHourRateLimited,
      hourlyBreakdown,
      topEndpoints,
      topShops,
      recentCronRuns
    ] = await Promise.all([
      db.collection("api_usage").countDocuments({
        provider,
        timestamp: { $gte: oneMinuteAgo }
      }),
      db.collection("api_usage").countDocuments({
        provider,
        timestamp: { $gte: oneHourAgo }
      }),
      db.collection("api_usage").countDocuments({
        provider,
        timestamp: { $gte: twentyFourHoursAgo }
      }),
      db.collection("api_usage").countDocuments({
        provider,
        isError: true,
        timestamp: { $gte: oneHourAgo }
      }),
      db.collection("api_usage").countDocuments({
        provider,
        isError: true,
        timestamp: { $gte: twentyFourHoursAgo }
      }),
      db.collection("api_usage").countDocuments({
        provider,
        isRateLimited: true,
        timestamp: { $gte: oneHourAgo }
      }),
      db.collection("api_usage").aggregate([
        { $match: { provider, timestamp: { $gte: twentyFourHoursAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%dT%H:00:00Z", date: "$timestamp" } },
            count: { $sum: 1 },
            errors: { $sum: { $cond: ["$isError", 1, 0] } },
            rateLimited: { $sum: { $cond: ["$isRateLimited", 1, 0] } },
            avgLatency: { $avg: "$latencyMs" }
          }
        },
        { $sort: { _id: 1 } }
      ]).toArray(),
      db.collection("api_usage").aggregate([
        { $match: { provider, timestamp: { $gte: twentyFourHoursAgo } } },
        { $group: { _id: "$endpoint", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]).toArray(),
      db.collection("api_usage").aggregate([
        { $match: { provider, timestamp: { $gte: twentyFourHoursAgo }, shopId: { $exists: true } } },
        { $group: { _id: "$shopId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]).toArray(),
      db.collection("api_usage").aggregate([
        {
          $match: {
            provider,
            timestamp: { $gte: twentyFourHoursAgo },
            sourceWorker: { $regex: /cron|backfill|sync/i }
          }
        },
        {
          $group: {
            _id: "$sourceWorker",
            totalCalls: { $sum: 1 },
            errors: { $sum: { $cond: ["$isError", 1, 0] } },
            lastRun: { $max: "$timestamp" }
          }
        },
        { $sort: { lastRun: -1 } }
      ]).toArray()
    ]);

    const shopIds = topShops.map((s: any) => s._id).filter(Boolean);
    let shopNameMap: Record<number, string> = {};
    if (shopIds.length > 0) {
      const shops = await db.collection("shops").find(
        {
          $or: [
            { shopId: { $in: shopIds } },
            { "tekmetric.shopId": { $in: shopIds } }
          ]
        },
        { projection: { shopId: 1, name: 1, locationIdentifier: 1, "tekmetric.shopId": 1 } }
      ).toArray();

      for (const shop of shops) {
        const displayName = shop.locationIdentifier
          ? `${shop.name} (${shop.locationIdentifier})`
          : shop.name;
        if (shop.shopId) shopNameMap[shop.shopId] = displayName;
        if (shop.tekmetric?.shopId) shopNameMap[shop.tekmetric.shopId] = displayName;
      }
    }

    return NextResponse.json({
      ok: true,
      provider,
      generatedAt: now.toISOString(),
      summary: {
        lastMinute: lastMinuteCount,
        lastHour: lastHourCount,
        last24Hours: last24hCount,
        errorsLastHour: lastHourErrors,
        errorsLast24Hours: last24hErrors,
        rateLimitedLastHour: lastHourRateLimited,
        avgCallsPerMinute: Math.round(lastHourCount / 60),
        rateLimit: provider === "tekmetric" ? 600 : undefined,
        usagePercent: provider === "tekmetric" ? Math.round((lastMinuteCount / 600) * 100) : undefined
      },
      hourlyBreakdown: hourlyBreakdown.map((h: any) => ({
        hour: h._id,
        requests: h.count,
        errors: h.errors,
        rateLimited: h.rateLimited,
        avgLatencyMs: Math.round(h.avgLatency || 0)
      })),
      topEndpoints: topEndpoints.map((e: any) => ({
        endpoint: e._id,
        count: e.count
      })),
      topShops: topShops.map((s: any) => ({
        shopId: s._id,
        shopName: shopNameMap[s._id] || undefined,
        count: s.count
      })),
      cronRuns: recentCronRuns.map((r: any) => ({
        worker: r._id,
        totalCalls: r.totalCalls,
        errors: r.errors,
        lastRun: r.lastRun
      }))
    });
  } catch (err: any) {
    console.error("[AdminApiUsage] Error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
