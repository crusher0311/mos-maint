/**
 * Task #1147 — off-peak guard for the plan-warm cron.
 *
 * Plan builds run on the WEB process (see the plan-pregen storm incident), so
 * the every-4h plan-warm ticks that land inside business hours must not spend
 * the full warm budget while real users are on the box. This module decides,
 * for a given tick, whether to run full-budget, run throttled, or skip.
 *
 * Design constraints:
 *   - The cached_plans TTL is ~4h, so warming ONLY at night would let plans
 *     expire before daytime report loads. Default is therefore `throttle`
 *     (concurrency 1, small per-shop VIN cap) during peak hours, not `skip`.
 *   - Pure/env-driven so it can be unit-tested without the route (route files
 *     export handlers only — test seams live in siblings).
 *
 * Env:
 *   PLAN_WARM_PEAK_HOURS_UTC   "start-end" UTC hours, end exclusive, wraps
 *                              midnight (default "13-23" ≈ 8am–6pm ET).
 *   PLAN_WARM_PEAK_MODE        "throttle" (default) | "skip" | "off".
 *   PLAN_WARM_PEAK_MAX_VINS_PER_SHOP  per-shop VIN cap while throttled
 *                              (default 10; never raises the off-peak cap).
 */

export interface PeakPolicy {
  /** True when `now` falls inside the configured peak window. */
  peak: boolean;
  /** "full" = run untouched; "throttle" = clamp budgets; "skip" = don't run. */
  action: "full" | "throttle" | "skip";
  /** Effective caps after applying the policy. */
  maxVinsPerShop: number;
  concurrency: number;
}

export function parsePeakHours(raw: string | undefined): { start: number; end: number } | null {
  const value = (raw ?? "13-23").trim();
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(value);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start < 0 || start > 23 || end < 0 || end > 24 || start === end) return null;
  return { start, end };
}

export function isPeakHourUtc(
  now: Date,
  window: { start: number; end: number } | null,
): boolean {
  if (!window) return false;
  const h = now.getUTCHours();
  const { start, end } = window;
  // Wraps midnight when start > end (e.g. "22-4").
  return start < end ? h >= start && h < end : h >= start || h < end;
}

export function resolvePeakPolicy(
  now: Date,
  offPeakCaps: { maxVinsPerShop: number; concurrency: number },
  env: Record<string, string | undefined> = process.env,
): PeakPolicy {
  const full: PeakPolicy = {
    peak: false,
    action: "full",
    maxVinsPerShop: offPeakCaps.maxVinsPerShop,
    concurrency: offPeakCaps.concurrency,
  };

  const mode = (env.PLAN_WARM_PEAK_MODE || "throttle").toLowerCase();
  if (mode === "off") return full;

  const window = parsePeakHours(env.PLAN_WARM_PEAK_HOURS_UTC);
  if (!isPeakHourUtc(now, window)) return full;

  if (mode === "skip") {
    return { ...full, peak: true, action: "skip" };
  }

  // throttle (default, also the fallback for unknown modes): concurrency 1
  // and a small per-shop VIN cap, never above the operator's off-peak cap.
  const peakVinCap = Math.max(
    1,
    Number(env.PLAN_WARM_PEAK_MAX_VINS_PER_SHOP || "10"),
  );
  return {
    peak: true,
    action: "throttle",
    maxVinsPerShop: Math.min(offPeakCaps.maxVinsPerShop, peakVinCap),
    concurrency: 1,
  };
}
