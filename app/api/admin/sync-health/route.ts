import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function GET() {
  try {
    await requirePlatformAdmin();

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      tekmetricBackfillProgress,
      protractorBackfillProgress,
      unresolvedErrors,
      recentSyncMetrics,
      normalizedStats
    ] = await Promise.all([
      sql`SELECT * FROM tekmetric_backfill_progress`,
      sql`SELECT * FROM backfill_progress`,
      sql`SELECT * FROM ingestion_errors WHERE resolved = false ORDER BY created_at DESC LIMIT 50`,
      sql`SELECT * FROM sync_metrics WHERE created_at >= ${since24h} ORDER BY created_at DESC LIMIT 100`,
      sql`SELECT sms_type, COUNT(*) as count, MAX(updated_at) as last_updated FROM normalized_work_orders GROUP BY sms_type`
    ]);

    const tekmetricShopsComplete = tekmetricBackfillProgress.filter((p) => p.completed).length;
    const tekmetricShopsTotal = tekmetricBackfillProgress.length;
    const protractorShopsComplete = protractorBackfillProgress.filter((p) => p.completed).length;
    const protractorShopsTotal = protractorBackfillProgress.length;

    const syncSuccessRate = recentSyncMetrics.length > 0
      ? (recentSyncMetrics.filter((m) => m.success).length / recentSyncMetrics.length * 100).toFixed(1)
      : "N/A";

    const avgSyncDuration = recentSyncMetrics.length > 0
      ? Math.round(recentSyncMetrics.reduce((sum: number, m) => sum + (Number(m.duration_ms) || 0), 0) / recentSyncMetrics.length)
      : 0;

    return NextResponse.json({
      backfill: {
        tekmetric: {
          complete: tekmetricShopsComplete,
          total: tekmetricShopsTotal,
          progress: tekmetricBackfillProgress.map((p) => ({
            shopId: p.shop_id,
            completed: p.completed,
            currentChunkEnd: p.current_chunk_end,
            totalJobsIndexed: p.total_jobs_indexed,
            lastRunAt: p.last_run_at
          }))
        },
        protractor: {
          complete: protractorShopsComplete,
          total: protractorShopsTotal,
          progress: protractorBackfillProgress.map((p) => ({
            shopId: p.shop_id,
            completed: p.completed,
            currentChunkEnd: p.current_chunk_end,
            totalJobsIndexed: p.total_jobs_indexed,
            lastRunAt: p.last_run_at
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
        recent: unresolvedErrors.slice(0, 10).map((e) => ({
          workerType: e.worker_type,
          entityType: e.entity_type,
          entityId: e.entity_id,
          error: e.error,
          retryCount: e.retry_count,
          createdAt: e.created_at
        }))
      },
      normalized: {
        workOrdersBySms: normalizedStats.map((s) => ({
          smsType: s.sms_type,
          count: Number(s.count),
          lastUpdated: s.last_updated
        }))
      }
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Admin SyncHealth] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
