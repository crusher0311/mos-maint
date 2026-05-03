// Shared helpers + per-section builders for the sync-health endpoints.
//
// The sync-health page used to call a single `/api/admin/sync-health` route
// that ran ~15 Mongo aggregations serially before returning. On prod that
// blew past the platform's request budget and the page rendered as
// skeleton-forever (task #288). We split the endpoint into per-section
// sub-routes (`tekmetric`, `protractor`, `shopware`) plus a lightweight
// overview from the main route, and the client fetches them in parallel.
// All shared pure functions and per-provider builders live here so the
// sub-routes stay thin and the original behavior/shape is preserved.

import type { Db } from "mongodb";

export const STALE_RUN_HOURS = 48;
export const FROZEN_CURSOR_DAYS = 3;
// A shop that drops at least one RO in this many runs IN A ROW is flagged.
// One bad chunk happens; the same shop dropping ROs run after run is silent
// data loss and should page on-call.
export const RECURRING_RO_SKIP_RUNS = 2;
// SLOW_P95_THRESHOLD_MS aligns with the 14m43s/chunk that triggered task
// #48; anything over this is considered slow enough to flag.
export const SLOW_P95_THRESHOLD_MS = 10 * 60 * 1000;

// Percentile from a sorted ascending number array. Inclusive method
// (`(p/100) * (n-1)`) — matches what most observability tools display so
// "p95 chunk duration" here lines up with what on-call sees in Better Stack.
export function percentile(sorted: number[], p: number): number | null {
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
export function summarizeChunkMetrics(recent: any[]) {
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

export function computeStuckDiagnostics(progressRows: any[]) {
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

// Date fields are defensively normalized so a malformed write into
// `backfill_chunk_speed_alerts` (e.g. a hand-edited row) can't 500 the
// whole sync-health endpoint.
export function safeIso(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export type ChunkSpeedAlertEntry = {
  reasons: string[];
  firstAlertedAt: string | null;
  lastAlertedAt: string | null;
};

// Loads the per-shop chunk-speed alert dedup rows written by
// `/api/cron/backfill-chunk-speed-health` and returns a `provider:shopId`
// keyed map so each provider sub-route can look up its alert state in O(1).
// Each provider route loads this independently because it's tiny — the dedup
// collection only contains currently-breaching shops.
export async function loadChunkSpeedAlertsByKey(
  db: Db,
): Promise<Map<string, ChunkSpeedAlertEntry>> {
  const docs = await db
    .collection("backfill_chunk_speed_alerts")
    .find({})
    .toArray();
  const out = new Map<string, ChunkSpeedAlertEntry>();
  for (const a of docs as any[]) {
    out.set(`${a.provider}:${Number(a.shopId)}`, {
      reasons: Array.isArray(a.reasons) ? a.reasons : [],
      firstAlertedAt: safeIso(a.firstAlertedAt),
      lastAlertedAt: safeIso(a.lastAlertedAt),
    });
  }
  return out;
}

// Per-shop chunk-speed summary. Built from raw progress rows (not the
// diagnostics list) so completed shops keep their historical sample for
// a few cron cycles after they finish — useful when on-call wants to ask
// "did this shop slow down before completing?". Sorted slowest-p95 first
// so a regression is visible at the top of the section.
export function buildChunkSpeed(
  provider: "tekmetric" | "protractor" | "shopware",
  progressRows: any[],
  alertsByKey: Map<string, ChunkSpeedAlertEntry>,
) {
  const rows = progressRows
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
      alert: alertsByKey.get(`${provider}:${Number(p.shopId)}`) ?? null,
    }))
    .filter((s: any) => s.chunkSampleCount && s.chunkSampleCount > 0)
    .sort((a: any, b: any) => (b.p95DurationMs || 0) - (a.p95DurationMs || 0));
  const slowChunkShopCount = rows.filter(
    (s: any) => (s.p95DurationMs || 0) > SLOW_P95_THRESHOLD_MS,
  ).length;
  return { rows, slowChunkShopCount };
}
