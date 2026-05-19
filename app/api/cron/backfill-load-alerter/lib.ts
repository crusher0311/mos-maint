/**
 * Pure helpers for the backfill load alerter (task #465).
 *
 * The alerter cron reads the per-chunk metric and host-load sampler
 * collections that task #460 ships, evaluates them against the safe
 * band documented in `docs/backfill-cadence-measurement.md`, and pages
 * platform admins (the existing on-call channel — same one the
 * stuck-shop and chunk-speed alerters use) when a regression breaches
 * the band.
 *
 * The threshold evaluation and state-based dedup classification live
 * here so they can be unit-tested without spinning up Mongo or
 * Next.js. The route handler owns all I/O.
 *
 * Three rules fire today (mapped 1:1 to the task brief):
 *
 *   - rate_limiter_timeouts — any chunk in the recent window with
 *     `rateLimiterTimeouts > 0`. Task brief: "sustained
 *     rateLimiterTimeouts > 0". A single chunk timeout already means
 *     the shared Tekmetric per-second cap was breached and a caller
 *     either fell open or backed off — both worth a heads-up.
 *
 *   - event_loop_lag — any host-load sample in the recent window with
 *     event-loop p99 lag above EVENT_LOOP_P99_MS_THRESHOLD. Task brief:
 *     "event-loop lag > 100ms". The Render Node service responsiveness
 *     budget in the cadence doc is 200ms; the alerter uses the tighter
 *     100ms call-out from the task brief so a regression is caught
 *     before responsiveness actually breaks.
 *
 *   - p95_doubled — per-provider chunk p95 in the recent window is at
 *     least P95_DOUBLE_MULTIPLIER × the prior baseline window's p95,
 *     and above P95_DOUBLE_NOISE_FLOOR_MS so a baseline of seconds
 *     doesn't trigger on the next window's seconds-ish blip. Task
 *     brief: "p95 chunk duration doubling". Complements the per-shop
 *     regression in backfill-chunk-speed-health by catching
 *     fleet-wide cadence regressions where no single shop crosses the
 *     3× per-shop multiplier but the aggregate p95 still doubles.
 */

// --- Thresholds (also documented in docs/backfill-cadence-measurement.md) -

/** Event-loop p99 lag above which we page (ms). Task brief. */
export const EVENT_LOOP_P99_MS_THRESHOLD = 100;

/** Multiplier for fleet-wide per-provider p95 chunk duration doubling. */
export const P95_DOUBLE_MULTIPLIER = 2;

/**
 * Noise floor for the p95-doubling rule (ms). A baseline of seconds
 * shouldn't fire on the next window's seconds-ish blip. Matches the
 * per-shop noise floor in `backfill-chunk-speed-health/lib.ts`.
 */
export const P95_DOUBLE_NOISE_FLOOR_MS = 2 * 60 * 1000;

/** Minimum chunk samples per provider before p95 comparison is trusted. */
export const P95_MIN_SAMPLES = 5;

/**
 * Recent window for chunk + host-load reads. Daily cron cadence means the
 * window only needs to cover one full day of activity to catch a regression
 * before the next digest fires.
 */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Baseline window for the p95-doubling rule. Compared against the recent
 * window: a regression is "recent p95 ≥ 2× the prior 7-day p95".
 */
export const BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type BackfillProvider =
  | "tekmetric"
  | "tekmetric-fullpage"
  | "protractor"
  | "shopware";

export type LoadAlertReason =
  | "rate_limiter_timeouts"
  | "event_loop_lag"
  | "p95_doubled";

export interface ChunkMetricRow {
  provider: BackfillProvider;
  shopId?: number | string;
  chunkEndedAt: Date;
  durationMs: number;
  writes?: {
    rateLimiterTimeouts?: number;
    rateLimiterFallbacks?: number;
  } | null;
}

export interface HostLoadRow {
  sampledAt: Date;
  eventLoopLagMs?: {
    p50?: number | null;
    p95?: number | null;
    p99?: number | null;
    max?: number | null;
  } | null;
}

// --- Pure helpers ---------------------------------------------------------

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

export interface RateLimiterTimeoutHit {
  reason: "rate_limiter_timeouts";
  provider: BackfillProvider;
  /** Total timeouts summed across the recent window. */
  totalTimeouts: number;
  /** Total fallbacks (limiter fail-open events) summed across the window. */
  totalFallbacks: number;
  /** Number of chunks in the window that had ≥1 timeout. */
  chunksWithTimeouts: number;
  /** Total chunks observed for the provider in the window. */
  chunkCount: number;
  windowMs: number;
}

export function findRateLimiterTimeoutHits(
  chunks: ChunkMetricRow[],
  windowMs: number = RECENT_WINDOW_MS,
): RateLimiterTimeoutHit[] {
  const byProvider = new Map<
    BackfillProvider,
    {
      totalTimeouts: number;
      totalFallbacks: number;
      chunksWithTimeouts: number;
      chunkCount: number;
    }
  >();
  for (const c of chunks) {
    const slot = byProvider.get(c.provider) ?? {
      totalTimeouts: 0,
      totalFallbacks: 0,
      chunksWithTimeouts: 0,
      chunkCount: 0,
    };
    slot.chunkCount += 1;
    const to = Number(c.writes?.rateLimiterTimeouts || 0);
    const fb = Number(c.writes?.rateLimiterFallbacks || 0);
    if (Number.isFinite(to) && to > 0) {
      slot.totalTimeouts += to;
      slot.chunksWithTimeouts += 1;
    }
    if (Number.isFinite(fb) && fb > 0) slot.totalFallbacks += fb;
    byProvider.set(c.provider, slot);
  }
  const out: RateLimiterTimeoutHit[] = [];
  for (const [provider, s] of byProvider) {
    if (s.totalTimeouts > 0 || s.totalFallbacks > 0) {
      out.push({
        reason: "rate_limiter_timeouts",
        provider,
        totalTimeouts: s.totalTimeouts,
        totalFallbacks: s.totalFallbacks,
        chunksWithTimeouts: s.chunksWithTimeouts,
        chunkCount: s.chunkCount,
        windowMs,
      });
    }
  }
  // Stable ordering so the dedup key is deterministic across runs.
  out.sort((a, b) => a.provider.localeCompare(b.provider));
  return out;
}

export interface EventLoopLagHit {
  reason: "event_loop_lag";
  /** Number of samples in the window over the threshold. */
  breachCount: number;
  /** Total samples observed in the window. */
  sampleCount: number;
  /** Worst observed p99 lag in the window (ms). */
  worstP99Ms: number;
  /** p99 lag of the most recent breaching sample (ms). */
  latestBreachP99Ms: number;
  thresholdMs: number;
  windowMs: number;
}

export function findEventLoopLagHits(
  samples: HostLoadRow[],
  thresholdMs: number = EVENT_LOOP_P99_MS_THRESHOLD,
  windowMs: number = RECENT_WINDOW_MS,
): EventLoopLagHit | null {
  let breachCount = 0;
  let worstP99 = 0;
  let latestBreachAt = -Infinity;
  let latestBreachP99 = 0;
  for (const s of samples) {
    const p99 = Number(s.eventLoopLagMs?.p99 ?? NaN);
    if (!Number.isFinite(p99)) continue;
    if (p99 > worstP99) worstP99 = p99;
    if (p99 > thresholdMs) {
      breachCount += 1;
      const t = s.sampledAt.getTime();
      if (t > latestBreachAt) {
        latestBreachAt = t;
        latestBreachP99 = p99;
      }
    }
  }
  if (breachCount === 0) return null;
  return {
    reason: "event_loop_lag",
    breachCount,
    sampleCount: samples.length,
    worstP99Ms: Math.round(worstP99 * 100) / 100,
    latestBreachP99Ms: Math.round(latestBreachP99 * 100) / 100,
    thresholdMs,
    windowMs,
  };
}

export interface P95DoubledHit {
  reason: "p95_doubled";
  provider: BackfillProvider;
  recentP95Ms: number;
  baselineP95Ms: number;
  multiplier: number;
  recentSampleCount: number;
  baselineSampleCount: number;
}

export function findP95DoubledHits(
  recentChunks: ChunkMetricRow[],
  baselineChunks: ChunkMetricRow[],
  opts: {
    multiplier?: number;
    noiseFloorMs?: number;
    minSamples?: number;
  } = {},
): P95DoubledHit[] {
  const multiplier = opts.multiplier ?? P95_DOUBLE_MULTIPLIER;
  const noiseFloor = opts.noiseFloorMs ?? P95_DOUBLE_NOISE_FLOOR_MS;
  const minSamples = opts.minSamples ?? P95_MIN_SAMPLES;

  const groupBy = (rows: ChunkMetricRow[]) => {
    const m = new Map<BackfillProvider, number[]>();
    for (const r of rows) {
      if (!Number.isFinite(r.durationMs)) continue;
      const arr = m.get(r.provider) ?? [];
      arr.push(r.durationMs);
      m.set(r.provider, arr);
    }
    return m;
  };

  const recentByProvider = groupBy(recentChunks);
  const baselineByProvider = groupBy(baselineChunks);

  const hits: P95DoubledHit[] = [];
  for (const [provider, recent] of recentByProvider) {
    const baseline = baselineByProvider.get(provider);
    if (!baseline || baseline.length < minSamples) continue;
    if (recent.length < minSamples) continue;
    const recentSorted = [...recent].sort((a, b) => a - b);
    const baselineSorted = [...baseline].sort((a, b) => a - b);
    const recentP95 = percentile(recentSorted, 95);
    const baselineP95 = percentile(baselineSorted, 95);
    if (recentP95 == null || baselineP95 == null) continue;
    if (recentP95 < noiseFloor) continue;
    if (baselineP95 <= 0) continue;
    if (recentP95 < multiplier * baselineP95) continue;
    hits.push({
      reason: "p95_doubled",
      provider,
      recentP95Ms: Math.round(recentP95),
      baselineP95Ms: Math.round(baselineP95),
      multiplier: Math.round((recentP95 / baselineP95) * 100) / 100,
      recentSampleCount: recent.length,
      baselineSampleCount: baseline.length,
    });
  }
  hits.sort((a, b) => a.provider.localeCompare(b.provider));
  return hits;
}

export type LoadAlertHit =
  | RateLimiterTimeoutHit
  | EventLoopLagHit
  | P95DoubledHit;

/**
 * Build the dedup key for a set of currently-breaching hits. State-based:
 * same set of reasons + per-reason scope → same key → no re-page. Different
 * key → new email. Mirrors the chunk-speed alerter's reasons-key approach.
 */
export function buildAlertKey(hits: LoadAlertHit[]): string {
  const parts: string[] = [];
  for (const h of hits) {
    if (h.reason === "rate_limiter_timeouts") {
      parts.push(`rate_limiter_timeouts:${h.provider}`);
    } else if (h.reason === "event_loop_lag") {
      parts.push(`event_loop_lag`);
    } else if (h.reason === "p95_doubled") {
      parts.push(`p95_doubled:${h.provider}`);
    }
  }
  parts.sort();
  return parts.join("|");
}
