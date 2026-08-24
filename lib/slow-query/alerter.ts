/**
 * Slow-query spike alerter (task #1161).
 *
 * Called from the slow-query-monitor cron: compares the recent window's
 * slow-query volume and worst-case latency against a rolling baseline and
 * pages via the shared ops-alert helper when it regresses. Incident and
 * cooldown state live in the shared `slow_query_alert_state` PG row and are
 * claimed/cleared atomically, so a sustained incident pages exactly once per
 * repeat window even when successive cron runs land on different autoscaled
 * replicas, and exactly one instance emits the all-clear on recovery.
 *
 * Env tuning:
 *   SLOW_QUERY_ALERT_WINDOW_MIN     — recent window size (default 15)
 *   SLOW_QUERY_ALERT_BASELINE_HOURS — baseline lookback (default 24)
 *   SLOW_QUERY_ALERT_MIN_COUNT      — absolute floor before volume can page (default 30)
 *   SLOW_QUERY_ALERT_MULTIPLIER     — window count must exceed baseline × this (default 3)
 *   SLOW_QUERY_ALERT_MAX_MS         — worst-case latency that pages regardless (default 30000)
 *   SLOW_QUERY_ALERT_REPEAT_MIN     — re-page cooldown (default 60)
 */
import { sendOpsAlert } from "@/lib/alerts/notify";
import {
  claimSlowQueryAlert,
  clearSlowQueryAlert,
  slowQueryWindowStats,
} from "@/lib/data/repositories/slow-queries";

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Test seams.
export const __deps = {
  stats: slowQueryWindowStats,
  alert: sendOpsAlert,
  claim: claimSlowQueryAlert,
  clear: clearSlowQueryAlert,
};

export interface SpikeCheckResult {
  windowCount: number;
  windowMaxMs: number;
  baselinePerWindow: number;
  spiking: boolean;
  reason: string | null;
  alerted: boolean;
  cleared: boolean;
}

export async function checkSlowQuerySpike(): Promise<SpikeCheckResult> {
  const windowMin = envInt("SLOW_QUERY_ALERT_WINDOW_MIN", 15);
  const baselineHours = envInt("SLOW_QUERY_ALERT_BASELINE_HOURS", 24);
  const minCount = envInt("SLOW_QUERY_ALERT_MIN_COUNT", 30);
  const multiplier = envInt("SLOW_QUERY_ALERT_MULTIPLIER", 3);
  const maxMs = envInt("SLOW_QUERY_ALERT_MAX_MS", 30000);
  const repeatMs = envInt("SLOW_QUERY_ALERT_REPEAT_MIN", 60) * 60 * 1000;

  const stats = await __deps.stats(windowMin, baselineHours);

  let reason: string | null = null;
  if (
    stats.windowCount >= minCount &&
    stats.windowCount > stats.baselinePerWindow * multiplier
  ) {
    reason = `volume spike: ${stats.windowCount} slow queries in ${windowMin}min (baseline ~${stats.baselinePerWindow.toFixed(1)}/window)`;
  } else if (stats.windowMaxMs >= maxMs) {
    reason = `worst-case latency ${Math.round(stats.windowMaxMs)}ms ≥ ${maxMs}ms`;
  }
  const spiking = reason !== null;

  let alerted = false;
  let cleared = false;

  if (spiking) {
    // Atomic shared-state claim: only the winner pages, and a sustained
    // incident re-pages at most once per repeat window fleet-wide.
    if (await __deps.claim(repeatMs)) {
      alerted = true;
      await __deps.alert({
        title: "Slow-query spike",
        severity: "critical",
        summary: `Database slowness detected — ${reason}.`,
        fields: {
          windowMinutes: windowMin,
          slowQueriesInWindow: stats.windowCount,
          baselinePerWindow: stats.baselinePerWindow.toFixed(1),
          worstDurationMs: Math.round(stats.windowMaxMs),
          worstTarget: stats.worstTarget ?? "(unknown)",
          dashboard: "/platform-admin/slow-queries",
        },
        source: "slow-query-monitor",
        dedupKey: "slow-query-spike",
      });
    }
  } else if (await __deps.clear()) {
    // Only the instance that actually flipped active→inactive announces.
    cleared = true;
    await __deps.alert({
      title: "Slow-query spike cleared",
      severity: "info",
      summary: `Slow-query volume/latency back under baseline (${stats.windowCount} in last ${windowMin}min).`,
      source: "slow-query-monitor",
      dedupKey: "slow-query-spike",
    });
  }

  return {
    windowCount: stats.windowCount,
    windowMaxMs: stats.windowMaxMs,
    baselinePerWindow: stats.baselinePerWindow,
    spiking,
    reason,
    alerted,
    cleared,
  };
}
