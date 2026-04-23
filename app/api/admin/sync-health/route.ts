import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requirePlatformAdmin } from "@/lib/auth";

const STALE_RUN_HOURS = 48;
const FROZEN_CURSOR_DAYS = 3;

function computeStuckDiagnostics(progressRows: any[]) {
  const now = Date.now();
  const diagnostics = progressRows
    .filter((p: any) => !p.completed)
    .map((p: any) => {
      const lastRunMs = p.lastRunAt ? new Date(p.lastRunAt).getTime() : null;
      const hoursSinceRun =
        lastRunMs == null ? null : (now - lastRunMs) / (60 * 60 * 1000);
      // Cursor freshness: prefer the explicit `lastCursorMoveAt` timestamp
      // written by the cron whenever currentChunkEnd actually changes. For
      // pre-existing rows / providers that don't have this field yet, fall
      // back to lastRunAt (best available signal until they next run).
      const cursorMoveMs = p.lastCursorMoveAt
        ? new Date(p.lastCursorMoveAt).getTime()
        : lastRunMs;
      const daysCursorFrozen =
        cursorMoveMs == null ? null : (now - cursorMoveMs) / (24 * 60 * 60 * 1000);

      const reasons: string[] = [];
      if (lastRunMs == null) reasons.push("never_started");
      if (hoursSinceRun != null && hoursSinceRun > STALE_RUN_HOURS) reasons.push("stale_run");
      if (daysCursorFrozen != null && daysCursorFrozen > FROZEN_CURSOR_DAYS) reasons.push("frozen_cursor");
      if (p.lastError) reasons.push("last_error");

      return {
        shopId: p.shopId,
        completed: !!p.completed,
        stuck: reasons.length > 0,
        reasons,
        lastRunAt: p.lastRunAt || null,
        hoursSinceLastRun: hoursSinceRun == null ? null : Number(hoursSinceRun.toFixed(1)),
        currentChunkEnd: p.currentChunkEnd || null,
        previousChunkEnd: p.previousChunkEnd || null,
        lastCursorMoveAt: p.lastCursorMoveAt || null,
        daysCursorFrozen: daysCursorFrozen == null ? null : Number(daysCursorFrozen.toFixed(1)),
        lastError: p.lastError || null,
        lastErrorAt: p.lastErrorAt || null,
        autoClearedErrorAt: p.autoClearedErrorAt || null,
        totalJobsIndexed: p.totalJobsIndexed || 0,
        logicVersion: p.logicVersion || null,
      };
    })
    .sort((a: any, b: any) => {
      // Surface the most-stuck shops first.
      if (a.stuck !== b.stuck) return a.stuck ? -1 : 1;
      const aDays = a.daysCursorFrozen ?? -1;
      const bDays = b.daysCursorFrozen ?? -1;
      return bDays - aDays;
    });
  return diagnostics;
}

export async function GET() {
  try {
    await requirePlatformAdmin();

    const db = await getDb();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      tekmetricBackfillProgress,
      protractorBackfillProgress,
      shopwareBackfillProgress,
      unresolvedErrors,
      recentSyncMetrics,
      normalizedStats
    ] = await Promise.all([
      db.collection("tekmetric_backfill_progress").find({}).toArray(),
      db.collection("backfill_progress").find({}).toArray(),
      db.collection("shopware_backfill_progress").find({}).toArray(),
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
    const shopwareShopsComplete = shopwareBackfillProgress.filter((p: any) => p.completed).length;
    const shopwareShopsTotal = shopwareBackfillProgress.length;

    // Stuck-shop diagnostics. A shop is "stuck" if:
    //   - it has never run despite being in the queue (no lastRunAt), OR
    //   - it hasn't run in more than 48h, OR
    //   - its cursor hasn't moved in more than 3 days, OR
    //   - it has a current lastError.
    const tekmetricDiagnostics = computeStuckDiagnostics(tekmetricBackfillProgress);
    const protractorDiagnostics = computeStuckDiagnostics(protractorBackfillProgress);
    const shopwareDiagnostics = computeStuckDiagnostics(shopwareBackfillProgress);

    // Force-skipped windows are written by the Tekmetric backfill cron after 3
    // consecutive failures on the same chunk. They represent unrecovered data
    // gaps and persist on the progress row even after the shop completes, so
    // we surface them independently of the stuck-shop diagnostics (which only
    // consider in-flight rows).
    const tekmetricForceSkippedWindows = tekmetricBackfillProgress
      .filter((p: any) => p.lastForceSkippedWindow && p.lastForceSkippedWindow.start && p.lastForceSkippedWindow.end)
      .map((p: any) => {
        const w = p.lastForceSkippedWindow;
        const startMs = new Date(w.start).getTime();
        const endMs = new Date(w.end).getTime();
        const spanDays = Number.isFinite(startMs) && Number.isFinite(endMs)
          ? Math.max(0, (endMs - startMs) / (24 * 60 * 60 * 1000))
          : null;
        return {
          shopId: p.shopId,
          start: w.start,
          end: w.end,
          at: w.at || null,
          spanDays: spanDays == null ? null : Number(spanDays.toFixed(1)),
          completed: !!p.completed,
        };
      })
      .sort((a: any, b: any) => {
        const aAt = a.at ? new Date(a.at).getTime() : 0;
        const bAt = b.at ? new Date(b.at).getTime() : 0;
        return bAt - aAt;
      });
    const tekmetricForceSkippedTotalSpanDays = Number(
      tekmetricForceSkippedWindows
        .reduce((sum: number, w: any) => sum + (w.spanDays || 0), 0)
        .toFixed(1)
    );

    const tekmetricStuckCount = tekmetricDiagnostics.filter((d: any) => d.stuck).length;
    const protractorStuckCount = protractorDiagnostics.filter((d: any) => d.stuck).length;
    const shopwareStuckCount = shopwareDiagnostics.filter((d: any) => d.stuck).length;

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
          stuck: tekmetricStuckCount,
          progress: tekmetricBackfillProgress.map((p: any) => ({
            shopId: p.shopId,
            completed: p.completed,
            currentChunkEnd: p.currentChunkEnd,
            totalJobsIndexed: p.totalJobsIndexed,
            lastRunAt: p.lastRunAt
          })),
          diagnostics: tekmetricDiagnostics,
          forceSkippedWindows: tekmetricForceSkippedWindows,
          forceSkippedShopCount: tekmetricForceSkippedWindows.length,
          forceSkippedTotalSpanDays: tekmetricForceSkippedTotalSpanDays,
        },
        protractor: {
          complete: protractorShopsComplete,
          total: protractorShopsTotal,
          stuck: protractorStuckCount,
          progress: protractorBackfillProgress.map((p: any) => ({
            shopId: p.shopId,
            completed: p.completed,
            currentChunkEnd: p.currentChunkEnd,
            totalJobsIndexed: p.totalJobsIndexed,
            lastRunAt: p.lastRunAt
          })),
          diagnostics: protractorDiagnostics,
        },
        shopware: {
          complete: shopwareShopsComplete,
          total: shopwareShopsTotal,
          stuck: shopwareStuckCount,
          progress: shopwareBackfillProgress.map((p: any) => ({
            shopId: p.shopId,
            completed: p.completed,
            currentChunkEnd: p.currentChunkEnd,
            totalJobsIndexed: p.totalJobsIndexed,
            lastRunAt: p.lastRunAt
          })),
          diagnostics: shopwareDiagnostics,
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
