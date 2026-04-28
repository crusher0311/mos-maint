import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requirePlatformAdmin } from "@/lib/auth";

const STALE_RUN_HOURS = 48;
const FROZEN_CURSOR_DAYS = 3;
// A shop that drops at least one RO in this many runs IN A ROW is flagged.
// One bad chunk happens; the same shop dropping ROs run after run is silent
// data loss and should page on-call.
const RECURRING_RO_SKIP_RUNS = 2;

// Percentile from a sorted ascending number array. Inclusive method
// (`(p/100) * (n-1)`) — matches what most observability tools display so
// "p95 chunk duration" here lines up with what on-call sees in Better Stack.
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

// Roll up the per-chunk metrics array on a progress row into a small summary
// the admin sync-health view can render directly. Returns null when the shop
// has no recorded chunks yet (pre-existing rows from before instrumentation).
function summarizeChunkMetrics(recent: any[]) {
  if (!Array.isArray(recent) || recent.length === 0) return null;
  const durations: number[] = [];
  let jobsHits = 0,
    jobsMisses = 0;
  let vehHits = 0,
    vehMisses = 0;
  let custHits = 0,
    custMisses = 0;
  let backoffMsTotal = 0;
  let backoffSampleCount = 0;
  let roCountTotal = 0;
  let lastChunkAt: string | null = null;
  for (const m of recent) {
    if (typeof m?.durationMs === "number" && Number.isFinite(m.durationMs)) {
      durations.push(m.durationMs);
    }
    jobsHits += Number(m?.jobsCacheHits || 0);
    jobsMisses += Number(m?.jobsCacheMisses || 0);
    vehHits += Number(m?.vehiclesCacheHits || 0);
    vehMisses += Number(m?.vehiclesCacheMisses || 0);
    custHits += Number(m?.customersCacheHits || 0);
    custMisses += Number(m?.customersCacheMisses || 0);
    if (typeof m?.backoff429Ms === "number") {
      backoffMsTotal += m.backoff429Ms;
      backoffSampleCount++;
    }
    roCountTotal += Number(m?.roCount || 0);
    if (m?.at && (!lastChunkAt || new Date(m.at).getTime() > new Date(lastChunkAt).getTime())) {
      lastChunkAt = m.at;
    }
  }
  durations.sort((a, b) => a - b);
  const median = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  const max = durations.length > 0 ? durations[durations.length - 1] : null;
  const jobsTotal = jobsHits + jobsMisses;
  const vehTotal = vehHits + vehMisses;
  const custTotal = custHits + custMisses;
  return {
    chunkSampleCount: recent.length,
    medianDurationMs: median == null ? null : Math.round(median),
    p95DurationMs: p95 == null ? null : Math.round(p95),
    maxDurationMs: max == null ? null : Math.round(max),
    avgRosPerChunk: recent.length > 0 ? Math.round(roCountTotal / recent.length) : 0,
    avgBackoff429Ms: backoffSampleCount > 0
      ? Math.round(backoffMsTotal / backoffSampleCount)
      : null,
    totalBackoff429Ms: backoffMsTotal,
    jobsCacheHitRate: jobsTotal > 0 ? Number((jobsHits / jobsTotal).toFixed(4)) : null,
    jobsCacheTotal: jobsTotal,
    vehiclesCacheHitRate: vehTotal > 0 ? Number((vehHits / vehTotal).toFixed(4)) : null,
    vehiclesCacheTotal: vehTotal,
    customersCacheHitRate: custTotal > 0 ? Number((custHits / custTotal).toFixed(4)) : null,
    customersCacheTotal: custTotal,
    lastChunkAt,
  };
}

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
      const consecutiveRoSkipRuns = Number(p.consecutiveRoSkipRuns || 0);
      if (consecutiveRoSkipRuns >= RECURRING_RO_SKIP_RUNS) {
        reasons.push("recurring_ro_skips");
      }

      const recentSkippedRosFull: any[] = Array.isArray(p.recentSkippedRos)
        ? p.recentSkippedRos
        : [];
      const recentSkippedRos = recentSkippedRosFull.slice(0, 10).map((s: any) => ({
        roId: s.roId,
        error: s.error || null,
        at: s.at || null,
        retryAttempts: Number(s.retryAttempts || 0),
        lastRetryAt: s.lastRetryAt || null,
        lastRetryError: s.lastRetryError || null,
        permanentlyFailed: !!s.permanentlyFailed,
      }));
      const stillFailingRoCount = recentSkippedRosFull.filter(
        (s: any) => !s.permanentlyFailed,
      ).length;
      const permanentlyFailedRoCount = Number(p.permanentlyFailedRoCount || 0);
      const recoveredRoCount = Number(p.recoveredRoCount || 0);

      // Probe fields are written by operational helpers (e.g.
      // scripts/restart-never-started-tekmetric-shops.ts) on dedicated
      // columns to avoid corrupting the cron's fair-queue ordering — see
      // the REGRESSION GUARD in that script. Surfaced here so on-call can
      // see whether a probe ran and whether it succeeded without having
      // to query Mongo. A failed probe is visually distinguishable from a
      // successful one even when `lastError` is null on the row.
      const lastProbedAt = p.lastProbedAt
        ? new Date(p.lastProbedAt).toISOString()
        : null;
      const lastProbeOk =
        typeof p.lastProbeOk === "boolean" ? p.lastProbeOk : null;
      const lastProbeError = p.lastProbeError
        ? String(p.lastProbeError).slice(0, 500)
        : null;
      const lastProbeNote = p.lastProbeNote
        ? String(p.lastProbeNote).slice(0, 500)
        : null;

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
        lastProbedAt,
        lastProbeOk,
        lastProbeError,
        lastProbeNote,
        totalJobsIndexed: p.totalJobsIndexed || 0,
        logicVersion: p.logicVersion || null,
        lastRoSkipCount: Number(p.lastRoSkipCount || 0),
        lastRoSkipAt: p.lastRoSkipAt || null,
        consecutiveRoSkipRuns,
        recentSkippedRos,
        stillFailingRoCount,
        permanentlyFailedRoCount,
        recoveredRoCount,
        lastRoRetryAt: p.lastRoRetryAt || null,
        lastRoRetryRecovered: Number(p.lastRoRetryRecovered || 0),
        lastRoRetryStillFailing: Number(p.lastRoRetryStillFailing || 0),
        lastRoRetryPermanentlyFailed: Number(p.lastRoRetryPermanentlyFailed || 0),
        lastSkippedRosResolvedAt: p.lastSkippedRosResolvedAt || null,
        roSkipsFullyRecoveredAt: p.roSkipsFullyRecoveredAt || null,
        resolvedSkippedRosTotal: Number(p.resolvedSkippedRosTotal || 0),
        chunkMetrics: summarizeChunkMetrics(p.recentChunkMetrics),
        lastChunkMetrics: p.lastChunkMetrics || null,
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

    const staleArchiveSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const [
      tekmetricBackfillProgress,
      protractorBackfillProgress,
      shopwareBackfillProgress,
      unresolvedErrors,
      recentSyncMetrics,
      normalizedStats,
      tekmetricStaleArchivedAgg,
      tekmetricShopDocs,
      protractorShopDocs,
      shopwareShopDocs,
      chunkSpeedAlertDocs,
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
      ]).toArray(),
      // Aggregate stale-archived entries (auto-archived after 30d without
      // re-fetch). Surfaces in the admin view as a separate "stale, never
      // re-fetched" bucket so cold leftovers stop polluting the live skipped
      // list. Limited to the last 14 days so the bucket stays focused on
      // recent sweep activity rather than historical buildup.
      db.collection("tekmetric_skipped_ro_archive").aggregate([
        { $match: { stale: true, archivedAt: { $gte: staleArchiveSince } } },
        {
          $group: {
            _id: "$shopId",
            entriesArchived: { $sum: 1 },
            lastArchivedAt: { $max: "$archivedAt" },
            oldestSkippedAt: { $min: "$skippedAt" },
            permanentlyFailedCount: {
              $sum: { $cond: [{ $eq: ["$permanentlyFailed", true] }, 1, 0] },
            },
          },
        },
        { $sort: { lastArchivedAt: -1 } },
        { $limit: 100 },
      ]).toArray(),
      // Pull just the fields we need for the jobs-cache-prewarm overlay.
      // Restricted to shops with a Tekmetric integration so the join
      // isn't paying for shops that will never have a prewarm record.
      db.collection("shops").find(
        { "tekmetric.shopId": { $exists: true, $ne: null } },
        {
          projection: {
            shopId: 1,
            "tekmetric.shopId": 1,
            "tekmetric.jobsCachePrewarm": 1,
            _id: 0,
          },
        },
      ).toArray(),
      // Per-shop Protractor invoice-cache pre-warm overlay. Stamped by
      // lib/protractor-jobs-prewarm.ts at onboarding under
      // `shops.protractor.invoiceCachePrewarm`. Restricted to shops with
      // a configured Protractor connection so we don't join against the
      // entire shops collection.
      db.collection("shops").find(
        { "protractor.configured": true },
        {
          projection: {
            shopId: 1,
            "protractor.connectionId": 1,
            "protractor.invoiceCachePrewarm": 1,
            _id: 0,
          },
        },
      ).toArray(),
      // Same overlay for Shop-Ware (task #72). Stamped by
      // lib/shopware-jobs-prewarm.ts on `shops.shopware.jobsCachePrewarm`.
      db.collection("shops").find(
        { "shopware.tenantId": { $exists: true, $ne: null } },
        {
          projection: {
            shopId: 1,
            "shopware.tenantId": 1,
            "shopware.swShopId": 1,
            "shopware.jobsCachePrewarm": 1,
            _id: 0,
          },
        },
      ).toArray(),
      // Per-shop chunk-speed alert dedup rows written by
      // `/api/cron/backfill-chunk-speed-health`. We surface them inline on
      // each provider's chunk-speed table so on-call can tell at a glance
      // which slow shops they've already been paged on (and since when) vs.
      // brand-new regressions, without context-switching to email. The badge
      // clears as soon as the dedup row clears (cron deletes the row when
      // the shop stops breaching), so this is always live state.
      db.collection("backfill_chunk_speed_alerts").find({}).toArray(),
    ]);

    // Build a `provider:shopId` -> alert map so each chunk-speed row can
    // attach its own alert state in O(1). Date fields are defensively
    // normalized so a malformed write into `backfill_chunk_speed_alerts`
    // (e.g. a hand-edited row) can't 500 the whole sync-health endpoint.
    const safeIso = (v: any): string | null => {
      if (!v) return null;
      const d = new Date(v);
      return Number.isFinite(d.getTime()) ? d.toISOString() : null;
    };
    const chunkSpeedAlertsByKey = new Map<
      string,
      { reasons: string[]; firstAlertedAt: string | null; lastAlertedAt: string | null }
    >();
    for (const a of chunkSpeedAlertDocs as any[]) {
      chunkSpeedAlertsByKey.set(`${a.provider}:${Number(a.shopId)}`, {
        reasons: Array.isArray(a.reasons) ? a.reasons : [],
        firstAlertedAt: safeIso(a.firstAlertedAt),
        lastAlertedAt: safeIso(a.lastAlertedAt),
      });
    }
    const lookupChunkSpeedAlert = (
      provider: "tekmetric" | "protractor" | "shopware",
      shopId: any,
    ) => chunkSpeedAlertsByKey.get(`${provider}:${Number(shopId)}`) ?? null;

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

    // Aggregate Tekmetric RO-skip stats. Distinct from force-skipped windows:
    // those are entire date ranges the cron jumped past, while these are
    // individual repair orders inside an otherwise-processed chunk that threw
    // and were silently dropped.
    const tekmetricRoSkipShops = tekmetricDiagnostics.filter(
      (d: any) => (d.consecutiveRoSkipRuns || 0) > 0,
    );
    const tekmetricRecurringRoSkipShops = tekmetricDiagnostics.filter((d: any) =>
      (d.reasons || []).includes("recurring_ro_skips"),
    );

    // Recovered = a shop that previously had silently-dropped ROs but is now
    // clean (no consecutive skip runs AND the rolling window has been cleared
    // by confirmed re-fetches). We surface these for ~14 days so on-call can
    // distinguish "currently dropping" from "historically dropped, now
    // recovered" instead of stale ids lingering on the live view forever.
    // Pulled from raw progress rows (not diagnostics) because completed shops
    // are filtered out of the stuck-diagnostics list but can still be
    // recently-recovered.
    const recoveredCutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const tekmetricRecoveredRoSkipShops = tekmetricBackfillProgress
      .filter((p: any) => {
        if ((Number(p.consecutiveRoSkipRuns) || 0) > 0) return false;
        if (Array.isArray(p.recentSkippedRos) && p.recentSkippedRos.length > 0) return false;
        const recoveredAt = p.roSkipsFullyRecoveredAt || p.lastSkippedRosResolvedAt;
        if (!recoveredAt) return false;
        return new Date(recoveredAt).getTime() >= recoveredCutoffMs;
      })
      .map((p: any) => ({
        shopId: p.shopId,
        completed: !!p.completed,
        roSkipsFullyRecoveredAt: p.roSkipsFullyRecoveredAt || null,
        lastSkippedRosResolvedAt: p.lastSkippedRosResolvedAt || null,
        resolvedSkippedRosTotal: Number(p.resolvedSkippedRosTotal || 0),
      }))
      .sort((a: any, b: any) => {
        const aAt = new Date(a.roSkipsFullyRecoveredAt || a.lastSkippedRosResolvedAt || 0).getTime();
        const bAt = new Date(b.roSkipsFullyRecoveredAt || b.lastSkippedRosResolvedAt || 0).getTime();
        return bAt - aAt;
      });

    const tekmetricStuckCount = tekmetricDiagnostics.filter((d: any) => d.stuck).length;
    const protractorStuckCount = protractorDiagnostics.filter((d: any) => d.stuck).length;
    const shopwareStuckCount = shopwareDiagnostics.filter((d: any) => d.stuck).length;

    // Per-shop chunk-speed summary. Built from raw progress rows (not the
    // diagnostics list) so completed shops keep their historical sample for
    // a few cron cycles after they finish — useful when on-call wants to ask
    // "did this shop slow down before completing?". Sorted slowest-p95 first
    // so a regression is visible at the top of the section.
    // SLOW_P95_THRESHOLD_MS aligns with the 14m43s/chunk that triggered task
    // #48; anything over this is considered slow enough to flag.
    const SLOW_P95_THRESHOLD_MS = 10 * 60 * 1000;
    const tekmetricChunkSpeed = tekmetricBackfillProgress
      .map((p: any) => ({
        shopId: p.shopId,
        completed: !!p.completed,
        ...(summarizeChunkMetrics(p.recentChunkMetrics) || {}),
        lastChunkMetrics: p.lastChunkMetrics
          ? {
              at: p.lastChunkMetrics.at || null,
              durationMs: p.lastChunkMetrics.durationMs || null,
              roCount: p.lastChunkMetrics.roCount || 0,
              jobsCacheHitRate: p.lastChunkMetrics.jobsCacheHitRate ?? null,
              vehiclesCacheHitRate: p.lastChunkMetrics.vehiclesCacheHitRate ?? null,
              customersCacheHitRate: p.lastChunkMetrics.customersCacheHitRate ?? null,
              backoff429Ms: p.lastChunkMetrics.backoff429Ms || 0,
              advanceMode: p.lastChunkMetrics.advanceMode || null,
            }
          : null,
        alert: lookupChunkSpeedAlert("tekmetric", p.shopId),
      }))
      .filter((s: any) => s.chunkSampleCount && s.chunkSampleCount > 0)
      .sort((a: any, b: any) => (b.p95DurationMs || 0) - (a.p95DurationMs || 0));
    const tekmetricSlowChunkShopCount = tekmetricChunkSpeed.filter(
      (s: any) => (s.p95DurationMs || 0) > SLOW_P95_THRESHOLD_MS,
    ).length;

    // Same chunk-speed roll-up for Protractor + Shop-Ware. They use a
    // shared metric shape (see `buildProtractorChunkMetrics` /
    // `buildShopwareChunkMetrics`), so the helper is reused as-is. The
    // Protractor cron persists vehicle + invoice-detail cache hits, while
    // Shop-Ware only has vehicle + customer association hits; unused slots
    // come back as null and the renderer hides them.
    const protractorChunkSpeed = protractorBackfillProgress
      .map((p: any) => ({
        shopId: p.shopId,
        completed: !!p.completed,
        ...(summarizeChunkMetrics(p.recentChunkMetrics) || {}),
        lastChunkMetrics: p.lastChunkMetrics
          ? {
              at: p.lastChunkMetrics.at || null,
              durationMs: p.lastChunkMetrics.durationMs || null,
              roCount: p.lastChunkMetrics.roCount || 0,
              jobsCacheHitRate: p.lastChunkMetrics.jobsCacheHitRate ?? null,
              vehiclesCacheHitRate: p.lastChunkMetrics.vehiclesCacheHitRate ?? null,
              customersCacheHitRate: p.lastChunkMetrics.customersCacheHitRate ?? null,
              backoff429Ms: p.lastChunkMetrics.backoff429Ms || 0,
              advanceMode: p.lastChunkMetrics.advanceMode || null,
            }
          : null,
        alert: lookupChunkSpeedAlert("protractor", p.shopId),
      }))
      .filter((s: any) => s.chunkSampleCount && s.chunkSampleCount > 0)
      .sort((a: any, b: any) => (b.p95DurationMs || 0) - (a.p95DurationMs || 0));
    const protractorSlowChunkShopCount = protractorChunkSpeed.filter(
      (s: any) => (s.p95DurationMs || 0) > SLOW_P95_THRESHOLD_MS,
    ).length;

    const shopwareChunkSpeed = shopwareBackfillProgress
      .map((p: any) => ({
        shopId: p.shopId,
        completed: !!p.completed,
        ...(summarizeChunkMetrics(p.recentChunkMetrics) || {}),
        lastChunkMetrics: p.lastChunkMetrics
          ? {
              at: p.lastChunkMetrics.at || null,
              durationMs: p.lastChunkMetrics.durationMs || null,
              roCount: p.lastChunkMetrics.roCount || 0,
              jobsCacheHitRate: p.lastChunkMetrics.jobsCacheHitRate ?? null,
              vehiclesCacheHitRate: p.lastChunkMetrics.vehiclesCacheHitRate ?? null,
              customersCacheHitRate: p.lastChunkMetrics.customersCacheHitRate ?? null,
              backoff429Ms: p.lastChunkMetrics.backoff429Ms || 0,
              advanceMode: p.lastChunkMetrics.advanceMode || null,
            }
          : null,
        alert: lookupChunkSpeedAlert("shopware", p.shopId),
      }))
      .filter((s: any) => s.chunkSampleCount && s.chunkSampleCount > 0)
      .sort((a: any, b: any) => (b.p95DurationMs || 0) - (a.p95DurationMs || 0));
    const shopwareSlowChunkShopCount = shopwareChunkSpeed.filter(
      (s: any) => (s.p95DurationMs || 0) > SLOW_P95_THRESHOLD_MS,
    ).length;

    // Per-shop jobs-cache pre-warm overlay. The prewarm record lives on
    // `shops.tekmetric.jobsCachePrewarm` (stamped by
    // lib/tekmetric-jobs-prewarm.ts at onboarding). Joining it onto the
    // backfill-progress universe lets on-call confirm at a glance which
    // freshly onboarded shops actually got their pre-warm vs which ones
    // were onboarded before the feature shipped (no record at all) and
    // would benefit from a one-shot manual warm. We key the join on
    // String(shopId) since the platform shopId is sometimes stored as a
    // string and sometimes as a number across collections.
    const tekmetricPrewarmByShopId = new Map<string, any>();
    for (const s of tekmetricShopDocs as any[]) {
      tekmetricPrewarmByShopId.set(String(s.shopId), {
        tekmetricShopId: s?.tekmetric?.shopId ?? null,
        record: s?.tekmetric?.jobsCachePrewarm || null,
      });
    }
    const tekmetricJobsCachePrewarm = tekmetricBackfillProgress
      .map((p: any) => {
        const entry = tekmetricPrewarmByShopId.get(String(p.shopId));
        const record = entry?.record || null;
        return {
          shopId: p.shopId,
          tekmetricShopId: entry?.tekmetricShopId ?? null,
          completed: !!p.completed,
          // `hasPrewarmRecord: false` is the visual "this shop was
          // onboarded before pre-warm rolled out" signal — it's the
          // primary thing on-call should be able to spot in the table.
          hasPrewarmRecord: !!record,
          completedAt: record?.completedAt || null,
          lookbackDays: record?.lookbackDays ?? null,
          rosScanned: record?.rosScanned ?? null,
          terminalRosFound: record?.terminalRosFound ?? null,
          alreadyCached: record?.alreadyCached ?? null,
          rosCached: record?.rosCached ?? null,
          jobsCached: record?.jobsCached ?? null,
          errors: record?.errors ?? null,
          capped: !!record?.capped,
          durationMs: record?.durationMs ?? null,
        };
      })
      .sort((a: any, b: any) => {
        // Surface "no prewarm record" rows first — they're the actionable
        // ones (legacy shops that never got warmed) — then capped /
        // errored, then most-recent prewarm.
        if (a.hasPrewarmRecord !== b.hasPrewarmRecord) {
          return a.hasPrewarmRecord ? 1 : -1;
        }
        const aProblem = (a.capped ? 1 : 0) + ((a.errors || 0) > 0 ? 1 : 0);
        const bProblem = (b.capped ? 1 : 0) + ((b.errors || 0) > 0 ? 1 : 0);
        if (aProblem !== bProblem) return bProblem - aProblem;
        const aAt = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        const bAt = b.completedAt ? new Date(b.completedAt).getTime() : 0;
        return bAt - aAt;
      });
    const tekmetricJobsCachePrewarmMissingCount = tekmetricJobsCachePrewarm
      .filter((p: any) => !p.hasPrewarmRecord).length;
    const tekmetricJobsCachePrewarmCappedCount = tekmetricJobsCachePrewarm
      .filter((p: any) => p.capped).length;
    const tekmetricJobsCachePrewarmErrorsCount = tekmetricJobsCachePrewarm
      .filter((p: any) => (p.errors ?? 0) > 0).length;

    // Per-shop Protractor invoice-cache prewarm overlay. Same join-by-shopId
    // logic as the Tekmetric overlay above. The prewarm record's shape is
    // defined by `PrewarmProtractorJobsCacheResult` in
    // lib/protractor-jobs-prewarm.ts (`invoicesScanned`, `invoicesCached`,
    // `alreadyCached`, `errors`, `capped`, etc.).
    const protractorPrewarmByShopId = new Map<string, any>();
    for (const s of protractorShopDocs as any[]) {
      protractorPrewarmByShopId.set(String(s.shopId), {
        connectionId: s?.protractor?.connectionId ?? null,
        record: s?.protractor?.invoiceCachePrewarm || null,
      });
    }
    const protractorInvoiceCachePrewarm = protractorBackfillProgress
      .map((p: any) => {
        const entry = protractorPrewarmByShopId.get(String(p.shopId));
        const record = entry?.record || null;
        return {
          shopId: p.shopId,
          connectionId: entry?.connectionId ?? null,
          completed: !!p.completed,
          // `hasPrewarmRecord: false` is the actionable "this shop was
          // onboarded before the Protractor prewarm rolled out" signal.
          hasPrewarmRecord: !!record,
          completedAt: record?.completedAt || null,
          lookbackDays: record?.lookbackDays ?? null,
          invoicesScanned: record?.invoicesScanned ?? null,
          alreadyCached: record?.alreadyCached ?? null,
          invoicesCached: record?.invoicesCached ?? null,
          errors: record?.errors ?? null,
          capped: !!record?.capped,
          durationMs: record?.durationMs ?? null,
        };
      })
      // Same sort priority as the Tekmetric overlay: never-warmed first,
      // then capped/errored, then most-recent prewarm.
      .sort((a: any, b: any) => {
        if (a.hasPrewarmRecord !== b.hasPrewarmRecord) {
          return a.hasPrewarmRecord ? 1 : -1;
        }
        const aProblem = (a.capped ? 1 : 0) + ((a.errors || 0) > 0 ? 1 : 0);
        const bProblem = (b.capped ? 1 : 0) + ((b.errors || 0) > 0 ? 1 : 0);
        if (aProblem !== bProblem) return bProblem - aProblem;
        const aAt = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        const bAt = b.completedAt ? new Date(b.completedAt).getTime() : 0;
        return bAt - aAt;
      });
    const protractorInvoiceCachePrewarmMissingCount = protractorInvoiceCachePrewarm
      .filter((p: any) => !p.hasPrewarmRecord).length;
    const protractorInvoiceCachePrewarmCappedCount = protractorInvoiceCachePrewarm
      .filter((p: any) => p.capped).length;
    const protractorInvoiceCachePrewarmErrorsCount = protractorInvoiceCachePrewarm
      .filter((p: any) => (p.errors ?? 0) > 0).length;

    // Same overlay for Shop-Ware (task #72). The SW prewarm result has a
    // different shape than Tekmetric's (no terminal-RO breakdown, but has
    // jobs-indexed/jobs-skipped + cursor-advanced status), so we map it
    // onto the same `JobsCachePrewarmShop` view-model the renderer uses:
    //   - rosCached  ← rosStored        (ROs upserted into shopware_repair_orders)
    //   - jobsCached ← jobsIndexed      (job_index rows written)
    //   - alreadyCached ← jobsSkipped   (job_index rows skipped via contentHash)
    //   - terminalRosFound / rosScanned ← rosFetched
    // This keeps the table columns ("ROs cached", "Jobs cached", "Already
    // cached") meaningful for both providers without forking the renderer.
    const shopwarePrewarmByShopId = new Map<string, any>();
    for (const s of shopwareShopDocs as any[]) {
      shopwarePrewarmByShopId.set(String(s.shopId), {
        tenantId: s?.shopware?.tenantId ?? null,
        swShopId: s?.shopware?.swShopId ?? null,
        record: s?.shopware?.jobsCachePrewarm || null,
      });
    }
    const shopwareJobsCachePrewarm = shopwareBackfillProgress
      .map((p: any) => {
        const entry = shopwarePrewarmByShopId.get(String(p.shopId));
        const record = entry?.record || null;
        return {
          shopId: p.shopId,
          // We don't have an external "tekmetricShopId" equivalent here;
          // expose the SW tenant + shop ids the prewarm worker needs in
          // case the UI ever wants to surface them.
          shopwareTenantId: entry?.tenantId ?? null,
          shopwareShopId: entry?.swShopId ?? null,
          completed: !!p.completed,
          hasPrewarmRecord: !!record,
          completedAt: record?.completedAt || null,
          lookbackDays: record?.lookbackDays ?? null,
          rosScanned: record?.rosFetched ?? null,
          terminalRosFound: record?.rosFetched ?? null,
          alreadyCached: record?.jobsSkipped ?? null,
          rosCached: record?.rosStored ?? null,
          jobsCached: record?.jobsIndexed ?? null,
          errors: record?.errors ?? null,
          capped: !!record?.capped,
          durationMs: record?.durationMs ?? null,
        };
      })
      .sort((a: any, b: any) => {
        if (a.hasPrewarmRecord !== b.hasPrewarmRecord) {
          return a.hasPrewarmRecord ? 1 : -1;
        }
        const aProblem = (a.capped ? 1 : 0) + ((a.errors || 0) > 0 ? 1 : 0);
        const bProblem = (b.capped ? 1 : 0) + ((b.errors || 0) > 0 ? 1 : 0);
        if (aProblem !== bProblem) return bProblem - aProblem;
        const aAt = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        const bAt = b.completedAt ? new Date(b.completedAt).getTime() : 0;
        return bAt - aAt;
      });
    const shopwareJobsCachePrewarmMissingCount = shopwareJobsCachePrewarm
      .filter((p: any) => !p.hasPrewarmRecord).length;
    const shopwareJobsCachePrewarmCappedCount = shopwareJobsCachePrewarm
      .filter((p: any) => p.capped).length;
    const shopwareJobsCachePrewarmErrorsCount = shopwareJobsCachePrewarm
      .filter((p: any) => (p.errors ?? 0) > 0).length;

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
          roSkipShopCount: tekmetricRoSkipShops.length,
          recurringRoSkipShopCount: tekmetricRecurringRoSkipShops.length,
          roSkipShops: tekmetricRoSkipShops.map((d: any) => ({
            shopId: d.shopId,
            consecutiveRoSkipRuns: d.consecutiveRoSkipRuns,
            lastRoSkipCount: d.lastRoSkipCount,
            lastRoSkipAt: d.lastRoSkipAt,
            recentSkippedRos: d.recentSkippedRos,
            stillFailingRoCount: d.stillFailingRoCount,
            permanentlyFailedRoCount: d.permanentlyFailedRoCount,
            recoveredRoCount: d.recoveredRoCount,
            lastRoRetryAt: d.lastRoRetryAt,
            lastRoRetryRecovered: d.lastRoRetryRecovered,
            lastRoRetryStillFailing: d.lastRoRetryStillFailing,
            lastRoRetryPermanentlyFailed: d.lastRoRetryPermanentlyFailed,
          })),
          roRecoveredTotal: tekmetricDiagnostics.reduce(
            (sum: number, d: any) => sum + (d.recoveredRoCount || 0),
            0,
          ),
          roPermanentlyFailedTotal: tekmetricDiagnostics.reduce(
            (sum: number, d: any) => sum + (d.permanentlyFailedRoCount || 0),
            0,
          ),
          roStillFailingTotal: tekmetricDiagnostics.reduce(
            (sum: number, d: any) => sum + (d.stillFailingRoCount || 0),
            0,
          ),
          recoveredRoSkipShops: tekmetricRecoveredRoSkipShops,
          recoveredRoSkipShopCount: tekmetricRecoveredRoSkipShops.length,
          // Stale-archived entries: ROs auto-archived after 30 days without
          // a re-fetch. Surfaced separately so on-call can spot cold leftovers
          // distinct from live actionable skips.
          staleArchivedSkippedRoShops: (tekmetricStaleArchivedAgg as any[]).map(
            (g: any) => ({
              shopId: g._id,
              entriesArchived: g.entriesArchived,
              lastArchivedAt: g.lastArchivedAt,
              oldestSkippedAt: g.oldestSkippedAt,
              permanentlyFailedCount: g.permanentlyFailedCount,
            }),
          ),
          staleArchivedSkippedRoShopCount: (tekmetricStaleArchivedAgg as any[])
            .length,
          staleArchivedSkippedRoTotal: (tekmetricStaleArchivedAgg as any[])
            .reduce(
              (sum: number, g: any) => sum + (g.entriesArchived || 0),
              0,
            ),
          // Per-chunk speed metrics. Median + p95 chunk duration and cache
          // hit rates per shop. Built from the rolling
          // `recentChunkMetrics` window persisted by the backfill cron so a
          // regression in chunk speed is visible without grepping cron logs.
          chunkSpeed: tekmetricChunkSpeed,
          chunkSpeedShopCount: tekmetricChunkSpeed.length,
          slowChunkShopCount: tekmetricSlowChunkShopCount,
          slowChunkP95ThresholdMs: SLOW_P95_THRESHOLD_MS,
          // Per-shop jobs-cache pre-warm status (task #59 / task #63).
          // `jobsCachePrewarmMissingCount` is the headline number on the
          // dashboard card — a non-zero value means there are legacy
          // Tekmetric shops onboarded before pre-warm shipped that
          // could be one-shot warmed manually for a faster first chunk.
          jobsCachePrewarm: tekmetricJobsCachePrewarm,
          jobsCachePrewarmShopCount: tekmetricJobsCachePrewarm.length,
          jobsCachePrewarmMissingCount: tekmetricJobsCachePrewarmMissingCount,
          jobsCachePrewarmCappedCount: tekmetricJobsCachePrewarmCappedCount,
          jobsCachePrewarmErrorsCount: tekmetricJobsCachePrewarmErrorsCount,
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
          chunkSpeed: protractorChunkSpeed,
          chunkSpeedShopCount: protractorChunkSpeed.length,
          slowChunkShopCount: protractorSlowChunkShopCount,
          slowChunkP95ThresholdMs: SLOW_P95_THRESHOLD_MS,
          // Per-shop Protractor invoice-cache pre-warm status
          // (lib/protractor-jobs-prewarm.ts). The "Jobs cache" column on
          // the Protractor chunk-speed table now also reflects this
          // cache's rolling per-chunk hit rate (see
          // `buildProtractorChunkMetrics`); this overlay lets on-call
          // see at a glance which shops were warmed at onboarding.
          invoiceCachePrewarm: protractorInvoiceCachePrewarm,
          invoiceCachePrewarmShopCount: protractorInvoiceCachePrewarm.length,
          invoiceCachePrewarmMissingCount:
            protractorInvoiceCachePrewarmMissingCount,
          invoiceCachePrewarmCappedCount:
            protractorInvoiceCachePrewarmCappedCount,
          invoiceCachePrewarmErrorsCount:
            protractorInvoiceCachePrewarmErrorsCount,
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
          chunkSpeed: shopwareChunkSpeed,
          chunkSpeedShopCount: shopwareChunkSpeed.length,
          slowChunkShopCount: shopwareSlowChunkShopCount,
          slowChunkP95ThresholdMs: SLOW_P95_THRESHOLD_MS,
          // Per-shop jobs-cache pre-warm status (task #72). Mirror of
          // Tekmetric's. `jobsCachePrewarmMissingCount` is the headline —
          // a non-zero value means there are legacy Shop-Ware shops
          // onboarded before pre-warm shipped that could be one-shot
          // bulk-warmed via /api/platform-admin/shopware-rewarm-jobs-cache-all.
          jobsCachePrewarm: shopwareJobsCachePrewarm,
          jobsCachePrewarmShopCount: shopwareJobsCachePrewarm.length,
          jobsCachePrewarmMissingCount: shopwareJobsCachePrewarmMissingCount,
          jobsCachePrewarmCappedCount: shopwareJobsCachePrewarmCappedCount,
          jobsCachePrewarmErrorsCount: shopwareJobsCachePrewarmErrorsCount,
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
