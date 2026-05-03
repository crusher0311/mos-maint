import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requirePlatformAdmin } from "@/lib/auth";

// Lightweight overview slice of the sync-health payload — sync metrics,
// unresolved-error sample, normalized-WO breakdown by SMS type. The heavy
// per-provider backfill aggregations now live on dedicated sub-routes
// (`./tekmetric`, `./protractor`, `./shopware`) and the page fetches all
// four in parallel. Originally these all lived on this single endpoint and
// took >30s on prod, blowing past the platform's request budget and leaving
// the page rendering as skeleton placeholders forever (task #288).
//
// Task #287's per-shop catch-up coverage panel is rendered from data shipped
// on the Tekmetric sub-route (`./tekmetric`) — it lives there alongside the
// rest of the Tekmetric backfill state so the page still receives it under
// `data.backfill.tekmetric.catchupCoverage`, which is where the renderer
// expects it.
export async function GET() {
  try {
    await requirePlatformAdmin();

    const db = await getDb();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [unresolvedErrors, recentSyncMetrics, normalizedStats] =
      await Promise.all([
        db
          .collection("ingestion_errors")
          .find({ resolved: false })
          .sort({ createdAt: -1 })
          .limit(50)
          .toArray(),
        db
          .collection("sync_metrics")
          .find({ createdAt: { $gte: since24h } })
          .sort({ createdAt: -1 })
          .limit(100)
          .toArray(),
        db
          .collection("normalized_work_orders")
          .aggregate([
            {
              $group: {
                _id: "$smsType",
                count: { $sum: 1 },
                lastUpdated: { $max: "$updatedAt" },
              },
            },
          ])
          .toArray(),
      ]);

    const syncSuccessRate =
      recentSyncMetrics.length > 0
        ? (
            (recentSyncMetrics.filter((m: any) => m.success).length /
              recentSyncMetrics.length) *
            100
          ).toFixed(1)
        : "N/A";

    const avgSyncDuration =
      recentSyncMetrics.length > 0
        ? Math.round(
            recentSyncMetrics.reduce(
              (sum: number, m: any) => sum + (m.durationMs || 0),
              0,
            ) / recentSyncMetrics.length,
          )
        : 0;

    return NextResponse.json({
      sync: {
        last24h: {
          total: recentSyncMetrics.length,
          successRate: syncSuccessRate + "%",
          avgDurationMs: avgSyncDuration,
        },
      },
      errors: {
        unresolved: unresolvedErrors.length,
        recent: unresolvedErrors.slice(0, 10).map((e: any) => ({
          workerType: e.workerType,
          entityType: e.entityType,
          entityId: e.entityId,
          error: e.error,
          retryCount: e.retryCount,
          createdAt: e.createdAt,
        })),
      },
      normalized: {
        workOrdersBySms: normalizedStats.map((s: any) => ({
          smsType: s._id,
          count: s.count,
          lastUpdated: s.lastUpdated,
        })),
      },
    });
  } catch (error: any) {
    console.error("[Admin SyncHealth] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
