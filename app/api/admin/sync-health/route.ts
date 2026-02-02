import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requirePlatformAdmin } from "@/lib/auth";

export async function GET() {
  try {
    await requirePlatformAdmin();

    const db = await getDb();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since1h = new Date(Date.now() - 60 * 60 * 1000);

    const [
      tekmetricBackfillProgress,
      protractorBackfillProgress,
      unresolvedErrors,
      recentSyncMetrics,
      normalizedStats
    ] = await Promise.all([
      db.collection("tekmetric_backfill_progress").find({}).toArray(),
      db.collection("backfill_progress").find({}).toArray(),
      db.collection("ingestion_errors")
        .find({ resolved: false })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray(),
      db.collection("sync_metrics")
        .find({ createdAt: { $gte: since24h } })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray(),
      db.collection("normalized_work_orders").aggregate([
        {
          $group: {
            _id: "$smsType",
            count: { $sum: 1 },
            lastUpdated: { $max: "$updatedAt" }
          }
        }
      ]).toArray()
    ]);

    const tekmetricShopsComplete = tekmetricBackfillProgress.filter((p: any) => p.completed).length;
    const tekmetricShopsTotal = tekmetricBackfillProgress.length;
    const protractorShopsComplete = protractorBackfillProgress.filter((p: any) => p.completed).length;
    const protractorShopsTotal = protractorBackfillProgress.length;

    const syncSuccessRate = recentSyncMetrics.length > 0
      ? (recentSyncMetrics.filter((m: any) => m.success).length / recentSyncMetrics.length * 100).toFixed(1)
      : "N/A";

    const avgSyncDuration = recentSyncMetrics.length > 0
      ? Math.round(recentSyncMetrics.reduce((sum: number, m: any) => sum + (m.durationMs || 0), 0) / recentSyncMetrics.length)
      : 0;

    return NextResponse.json({
      backfill: {
        tekmetric: {
          complete: tekmetricShopsComplete,
          total: tekmetricShopsTotal,
          progress: tekmetricBackfillProgress.map((p: any) => ({
            shopId: p.shopId,
            completed: p.completed,
            currentChunkEnd: p.currentChunkEnd,
            totalJobsIndexed: p.totalJobsIndexed,
            lastRunAt: p.lastRunAt
          }))
        },
        protractor: {
          complete: protractorShopsComplete,
          total: protractorShopsTotal,
          progress: protractorBackfillProgress.map((p: any) => ({
            shopId: p.shopId,
            completed: p.completed,
            currentChunkEnd: p.currentChunkEnd,
            totalJobsIndexed: p.totalJobsIndexed,
            lastRunAt: p.lastRunAt
          }))
        }
      },
      sync: {
        last24h: {
          total: recentSyncMetrics.length,
          successRate: syncSuccessRate + "%",
          avgDurationMs: avgSyncDuration
        }
      },
      errors: {
        unresolved: unresolvedErrors.length,
        recent: unresolvedErrors.slice(0, 10).map((e: any) => ({
          workerType: e.workerType,
          entityType: e.entityType,
          entityId: e.entityId,
          error: e.error,
          retryCount: e.retryCount,
          createdAt: e.createdAt
        }))
      },
      normalized: {
        workOrdersBySms: normalizedStats.map((s: any) => ({
          smsType: s._id,
          count: s.count,
          lastUpdated: s.lastUpdated
        }))
      }
    });
  } catch (error: any) {
    console.error("[Admin SyncHealth] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
