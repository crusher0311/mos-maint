import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

type DateRange = { startDate: Date; endDate?: Date };

function resolveDateRange(searchParams: URLSearchParams): DateRange {
  const dateFilter = searchParams.get("dateFilter");
  const days = Math.max(1, Math.min(365, parseInt(searchParams.get("days") || "30", 10) || 30));

  if (dateFilter === "today") {
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    return { startDate };
  }
  if (dateFilter === "yesterday") {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 1);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date();
    endDate.setHours(0, 0, 0, 0);
    return { startDate, endDate };
  }
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  return { startDate };
}

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const { searchParams } = new URL(request.url);
    const { startDate, endDate } = resolveDateRange(searchParams);
    const shopIdParam = searchParams.get("shopId");
    const status = (searchParams.get("status") || "all").toLowerCase();

    const createdAt: Record<string, Date> = { $gte: startDate };
    if (endDate) createdAt.$lt = endDate;

    const baseMatch: Record<string, unknown> = {
      action: "build_ro_from_vhi",
      createdAt,
    };
    if (shopIdParam) {
      const n = Number(shopIdParam);
      baseMatch.targetShopId = Number.isFinite(n) && shopIdParam !== "" ? n : shopIdParam;
    }
    if (status === "success") {
      baseMatch["details.summary.failed"] = { $in: [0, null] };
      baseMatch["details.summary.added"] = { $gt: 0 };
    } else if (status === "failure") {
      baseMatch["details.summary.failed"] = { $gt: 0 };
    } else if (status === "skipped") {
      baseMatch["details.summary.failed"] = { $in: [0, null] };
      baseMatch["details.summary.added"] = { $in: [0, null] };
      baseMatch["details.summary.skipped"] = { $gt: 0 };
    }

    const db = await getDb();
    const coll = db.collection("admin_audit_logs");

    const failedExpr = { $ifNull: ["$details.summary.failed", 0] };
    const addedExpr = { $ifNull: ["$details.summary.added", 0] };
    const skippedExpr = { $ifNull: ["$details.summary.skipped", 0] };

    const [totalsAgg, byDayAgg, topShopsAgg, topAdvisorsAgg, recentLogs] = await Promise.all([
      coll.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: null,
            totalAttempts: { $sum: 1 },
            totalAdded: { $sum: addedExpr },
            totalSkipped: { $sum: skippedExpr },
            totalFailed: { $sum: failedExpr },
            attemptsWithFailure: {
              $sum: { $cond: [{ $gt: [failedExpr, 0] }, 1, 0] },
            },
            attemptsAllSkipped: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: [addedExpr, 0] },
                      { $eq: [failedExpr, 0] },
                      { $gt: [skippedExpr, 0] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]).toArray(),
      coll.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
            attempts: { $sum: 1 },
            added: { $sum: addedExpr },
            failed: { $sum: failedExpr },
          },
        },
        { $sort: { _id: -1 } },
      ]).toArray(),
      coll.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: "$targetShopId",
            shopName: { $first: "$targetShopName" },
            count: { $sum: 1 },
            failed: { $sum: { $cond: [{ $gt: [failedExpr, 0] }, 1, 0] } },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]).toArray(),
      coll.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: "$adminEmail",
            count: { $sum: 1 },
            failed: { $sum: { $cond: [{ $gt: [failedExpr, 0] }, 1, 0] } },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]).toArray(),
      coll.find(baseMatch).sort({ createdAt: -1 }).limit(200).toArray(),
    ]);

    const byDay = byDayAgg.map((d: any) => ({
      date: d._id,
      attempts: d.attempts || 0,
      added: d.added || 0,
      failed: d.failed || 0,
    }));

    const topShops = topShopsAgg.map((s: any) => ({
      shopId: s._id,
      shopName: s.shopName,
      count: s.count || 0,
      failed: s.failed || 0,
    }));

    const topAdvisors = topAdvisorsAgg.map((u: any) => ({
      email: u._id || "unknown",
      count: u.count || 0,
      failed: u.failed || 0,
    }));

    const t = totalsAgg[0] || {};
    const totalAttempts = t.totalAttempts || 0;
    const attemptsWithFailure = t.attemptsWithFailure || 0;
    const attemptsAllSkipped = t.attemptsAllSkipped || 0;
    const errorRate = totalAttempts > 0 ? attemptsWithFailure / totalAttempts : 0;
    const successRate = totalAttempts > 0 ? 1 - errorRate : 0;

    const stats = {
      totalAttempts,
      totalAdded: t.totalAdded || 0,
      totalSkipped: t.totalSkipped || 0,
      totalFailed: t.totalFailed || 0,
      attemptsWithFailure,
      attemptsAllSkipped,
      attemptsFullySuccessful: Math.max(0, totalAttempts - attemptsWithFailure - attemptsAllSkipped),
      errorRate,
      successRate,
      byDay,
    };

    const recentEvents = (recentLogs as any[]).map((log) => ({
      id: log._id?.toString?.() || null,
      createdAt: log.createdAt,
      adminEmail: log.adminEmail,
      shopId: log.targetShopId,
      shopName: log.targetShopName,
      provider: log.details?.provider,
      roId: log.details?.roId ?? null,
      roNumber: log.details?.roNumber ?? null,
      vin: log.details?.vin ?? null,
      summary: log.details?.summary || {},
      items: Array.isArray(log.details?.items) ? log.details.items : [],
    }));

    return NextResponse.json({
      stats,
      topShops,
      topAdvisors,
      recentEvents,
      recentEventsLimited: recentLogs.length >= 200,
    });
  } catch (error: any) {
    console.error("Error fetching VHI analytics:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
