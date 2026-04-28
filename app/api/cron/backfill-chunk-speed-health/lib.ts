/**
 * Pure helpers for the backfill chunk-speed health cron.
 *
 * Extracted from `route.ts` so the threshold evaluation and dedup
 * classification can be unit-tested without spinning up Mongo or Next.js.
 *
 * The route handler still owns all I/O (DB reads/writes, email send) — this
 * file deliberately has no side effects and no DB / network imports.
 */

// Slow chunk p95 threshold. Matches `SLOW_P95_THRESHOLD_MS` in
// `app/api/admin/sync-health/route.ts` so the alert and the dashboard's
// "slow" badge can never disagree on which shops are slow.
export const SLOW_P95_THRESHOLD_MS = 10 * 60 * 1000;

// Average per-chunk 429-backoff threshold. A shop that is consistently
// being rate-limited spends real wall-clock waiting on retries; an average
// over a minute per chunk indicates persistent backpressure that the cache
// can't absorb. Note: 429 backoff is approximate when multiple shops run
// concurrently (one shop's backoff can leak into another's chunk delta), so
// we deliberately use a high threshold to keep false positives down.
export const HIGH_BACKOFF_AVG_MS = 60 * 1000;

// Cache hit rate floor. The chunk-speed roll-up exposes per-cache hit rates
// (jobs, vehicles, customers) as fractions in [0..1]. A healthy backfill
// runs at >70% on every cache; below 50% means the cache layer is missing
// most lookups and the chunk is largely API-bound. Page when any cache
// drops below this floor.
export const LOW_CACHE_HIT_RATE = 0.5;

// Minimum samples in a cache before low-hit-rate is considered. A shop
// that just started will have a tiny sample and shouldn't page. The
// chunk-speed roll-up sums hits+misses across the rolling 25-chunk window
// so 50 lookups is roughly "two real chunks worth of API calls".
export const LOW_CACHE_MIN_LOOKUPS = 50;

// Avoid paging on a single anomalous chunk. Min sample count before any
// chunk-level threshold (slow_p95, high_backoff) is allowed to fire. The
// rolling window cap is 25, so 3 is enough to make p95 / averages
// meaningful without blocking detection on shops that are still ramping up.
export const MIN_CHUNK_SAMPLES = 3;

// --- Relative p95 regression detection ----------------------------------
// The absolute `slow_p95` rule above only fires once a shop's p95 crosses
// 10 minutes. A shop that climbs from 1m to 8m has degraded 8× but stays
// silent — yet that's a real regression worth catching before it crosses
// 10m and starts losing the race with the daily cron cadence.
//
// The relative rule pages when a shop's current p95 is at least
// `P95_REGRESSION_MULTIPLIER` times its own rolling baseline (median of the
// prior runs' p95 snapshots). It only fires once the current p95 is also
// meaningfully above background noise (`P95_REGRESSION_NOISE_FLOOR_MS`),
// otherwise a shop whose baseline is 5s would page on a 20s blip.
//
// Snapshot history is persisted day-over-day in a separate Mongo collection
// (`backfill_chunk_p95_history`) so it survives the alert collection's
// auto-clear-on-resolve behaviour. The pattern mirrors `countHistory` on
// the perm-failed RO alerts.
export const P95_REGRESSION_MULTIPLIER = 3;
export const P95_REGRESSION_NOISE_FLOOR_MS = 2 * 60 * 1000;
// History cap (~2 weeks at one run/day). Bounded storage; older snapshots
// stop influencing the median anyway because of the lookback window.
export const P95_HISTORY_CAP = 14;
// Baseline = median of up to the last N prior snapshots. One week of
// recent runs gives the median enough signal to be stable while still
// reflecting the shop's "current normal" rather than ancient history.
export const P95_BASELINE_LOOKBACK = 7;
// Need at least this many prior snapshots before we trust the median.
// With 1–2 prior runs the "median" would be unstable and could fire on
// random noise. Three matches the chunk-sample floor used elsewhere.
export const P95_BASELINE_MIN_SAMPLES = 3;

export type ProviderKey = "tekmetric" | "protractor" | "shopware";

export type ProviderConfig = {
  key: ProviderKey;
  label: string;
  collectionName: string;
};

export const PROVIDERS: ProviderConfig[] = [
  { key: "tekmetric", label: "Tekmetric", collectionName: "tekmetric_backfill_progress" },
  { key: "protractor", label: "Protractor", collectionName: "backfill_progress" },
  { key: "shopware", label: "Shop-Ware", collectionName: "shopware_backfill_progress" },
];

export type ChunkRollup = {
  chunkSampleCount: number;
  p95DurationMs: number | null;
  avgBackoff429Ms: number | null;
  jobsCacheHitRate: number | null;
  jobsCacheTotal: number;
  vehiclesCacheHitRate: number | null;
  vehiclesCacheTotal: number;
  customersCacheHitRate: number | null;
  customersCacheTotal: number;
};

export type SlowShop = {
  provider: ProviderKey;
  providerLabel: string;
  shopId: number;
  name: string;
  reasons: string[];
  reasonsKey: string;
  rollup: ChunkRollup;
  // Set only when the `regressed_p95` reason fires. Carries the shop's own
  // rolling baseline (median of prior p95 snapshots) so the alert payload
  // can show "current p95 = 8m, baseline = 1.5m, 5.3× regression".
  p95Baseline: number | null;
};

/**
 * Per-shop p95 snapshot persisted day-over-day in
 * `backfill_chunk_p95_history`. One entry per cron run, capped at
 * P95_HISTORY_CAP. Used to compute the rolling baseline that powers the
 * relative `regressed_p95` rule.
 */
export type P95Snapshot = {
  at: Date;
  p95Ms: number;
  sampleCount: number;
};

// Inclusive percentile from a sorted-ascending array. Matches the
// implementation in `app/api/admin/sync-health/route.ts` so the alert
// thresholds and the admin "slow shop" badge always agree.
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

export function summarize(recent: any[]): ChunkRollup | null {
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
  }
  durations.sort((a, b) => a - b);
  const p95 = percentile(durations, 95);
  const jobsTotal = jobsHits + jobsMisses;
  const vehTotal = vehHits + vehMisses;
  const custTotal = custHits + custMisses;
  return {
    chunkSampleCount: recent.length,
    p95DurationMs: p95 == null ? null : Math.round(p95),
    avgBackoff429Ms: backoffSampleCount > 0
      ? Math.round(backoffMsTotal / backoffSampleCount)
      : null,
    jobsCacheHitRate: jobsTotal > 0 ? jobsHits / jobsTotal : null,
    jobsCacheTotal: jobsTotal,
    vehiclesCacheHitRate: vehTotal > 0 ? vehHits / vehTotal : null,
    vehiclesCacheTotal: vehTotal,
    customersCacheHitRate: custTotal > 0 ? custHits / custTotal : null,
    customersCacheTotal: custTotal,
  };
}

/**
 * Compute the shop's rolling baseline p95 from prior snapshots.
 *
 * Returns the median of the last `P95_BASELINE_LOOKBACK` snapshots so
 * recent runs dominate (a shop's "current normal" can shift over time
 * as load patterns and cache warmth evolve). Returns `null` when there
 * aren't enough samples — the regression rule must not fire on a thin
 * baseline because the median would be unstable.
 *
 * History is expected sorted ascending by `at`; callers that read from
 * Mongo should sort first to be safe. Snapshots with non-finite p95Ms
 * are dropped defensively.
 */
export function computeP95Baseline(history: P95Snapshot[]): number | null {
  const window = history
    .slice(-P95_BASELINE_LOOKBACK)
    .map((h) => h.p95Ms)
    .filter((v) => Number.isFinite(v));
  if (window.length < P95_BASELINE_MIN_SAMPLES) return null;
  const sorted = [...window].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Append the latest p95 snapshot to the shop's history and trim to the
 * cap. Snapshots are immutable; older entries are dropped from the front
 * once the cap is reached. Returns a new array (never mutates input).
 */
export function appendP95Snapshot(
  history: P95Snapshot[],
  snapshot: P95Snapshot,
): P95Snapshot[] {
  return [...history, snapshot].slice(-P95_HISTORY_CAP);
}

export function evaluateShop(
  provider: ProviderConfig,
  progressRow: any,
  shopNamesById: Map<number, string>,
  priorP95History: P95Snapshot[] = [],
): SlowShop | null {
  // Only evaluate in-flight shops. A completed shop legitimately stops
  // running and its stale roll-up isn't actionable.
  if (progressRow.completed) return null;

  const rollup = summarize(progressRow.recentChunkMetrics);
  if (!rollup) return null;

  const reasons: string[] = [];

  if (
    rollup.chunkSampleCount >= MIN_CHUNK_SAMPLES &&
    rollup.p95DurationMs != null &&
    rollup.p95DurationMs > SLOW_P95_THRESHOLD_MS
  ) {
    reasons.push("slow_p95");
  }

  // Relative regression check: page when p95 has degraded sharply against
  // the shop's own rolling baseline. Gated by the same chunk-sample floor
  // as slow_p95 (so a thin window of measurements can't mis-fire) and by
  // a noise floor so a baseline of seconds doesn't trigger on the next
  // run's seconds-ish blip. Carries `p95Baseline` on the result so the
  // alert payload can show both the current p95 and the baseline it
  // regressed from.
  let p95Baseline: number | null = null;
  if (
    rollup.chunkSampleCount >= MIN_CHUNK_SAMPLES &&
    rollup.p95DurationMs != null &&
    rollup.p95DurationMs > P95_REGRESSION_NOISE_FLOOR_MS
  ) {
    const baseline = computeP95Baseline(priorP95History);
    if (
      baseline != null &&
      baseline > 0 &&
      rollup.p95DurationMs > P95_REGRESSION_MULTIPLIER * baseline
    ) {
      reasons.push("regressed_p95");
      p95Baseline = baseline;
    }
  }

  if (
    rollup.chunkSampleCount >= MIN_CHUNK_SAMPLES &&
    rollup.avgBackoff429Ms != null &&
    rollup.avgBackoff429Ms > HIGH_BACKOFF_AVG_MS
  ) {
    reasons.push("high_backoff");
  }

  // Cache hit rate check: only fire when the cache has been used enough
  // for the rate to be meaningful. We check each cache independently and
  // emit one reason per offender so the alert payload makes the offender
  // explicit (e.g. "low_jobs_cache+low_vehicles_cache").
  if (
    rollup.jobsCacheHitRate != null &&
    rollup.jobsCacheTotal >= LOW_CACHE_MIN_LOOKUPS &&
    rollup.jobsCacheHitRate < LOW_CACHE_HIT_RATE
  ) {
    reasons.push("low_jobs_cache");
  }
  if (
    rollup.vehiclesCacheHitRate != null &&
    rollup.vehiclesCacheTotal >= LOW_CACHE_MIN_LOOKUPS &&
    rollup.vehiclesCacheHitRate < LOW_CACHE_HIT_RATE
  ) {
    reasons.push("low_vehicles_cache");
  }
  if (
    rollup.customersCacheHitRate != null &&
    rollup.customersCacheTotal >= LOW_CACHE_MIN_LOOKUPS &&
    rollup.customersCacheHitRate < LOW_CACHE_HIT_RATE
  ) {
    reasons.push("low_customers_cache");
  }

  if (reasons.length === 0) return null;

  const shopId = Number(progressRow.shopId);
  return {
    provider: provider.key,
    providerLabel: provider.label,
    shopId,
    name: shopNamesById.get(shopId) || `Shop ${shopId}`,
    reasons,
    reasonsKey: [...reasons].sort().join(","),
    rollup,
    p95Baseline,
  };
}

/**
 * Existing dedup row shape stored in `backfill_chunk_speed_alerts`.
 * Only fields the dedup classifier inspects are required.
 */
export type ExistingAlertDoc = {
  provider: ProviderKey;
  shopId: number | string;
  reasonsKey: string;
};

export type DedupClassification = {
  /** Slow shops with no existing alert row — page on-call and insert. */
  newlySlow: SlowShop[];
  /** Slow shops whose reasonsKey differs from the stored row — re-page. */
  reasonsChanged: SlowShop[];
  /** Slow shops with the same reasons as last time — touch lastSeenAt only. */
  unchanged: SlowShop[];
  /** Existing alert rows with no current breach — auto-clear. */
  resolved: Array<{ provider: ProviderKey; shopId: number }>;
};

/**
 * Pure dedup classifier. Given the current set of breaching shops and the
 * existing alert documents, decide which buckets each falls into.
 *
 * Keying rule: `(provider, shopId)`. Re-page only on first detection or when
 * the sorted reasons key changes. Existing alerts whose key isn't in the
 * current breach set are flagged for auto-clear.
 */
export function classifyDedup(
  slow: SlowShop[],
  existing: ExistingAlertDoc[],
): DedupClassification {
  const slowKeySet = new Set(slow.map((s) => `${s.provider}:${s.shopId}`));
  const existingByKey = new Map<string, ExistingAlertDoc>();
  for (const d of existing) {
    existingByKey.set(`${d.provider}:${Number(d.shopId)}`, d);
  }

  const newlySlow: SlowShop[] = [];
  const reasonsChanged: SlowShop[] = [];
  const unchanged: SlowShop[] = [];

  for (const s of slow) {
    const key = `${s.provider}:${s.shopId}`;
    const ex = existingByKey.get(key);
    if (!ex) {
      newlySlow.push(s);
    } else if (ex.reasonsKey !== s.reasonsKey) {
      reasonsChanged.push(s);
    } else {
      unchanged.push(s);
    }
  }

  const resolved: Array<{ provider: ProviderKey; shopId: number }> = [];
  for (const d of existing) {
    const key = `${d.provider}:${Number(d.shopId)}`;
    if (!slowKeySet.has(key)) {
      resolved.push({ provider: d.provider, shopId: Number(d.shopId) });
    }
  }

  return { newlySlow, reasonsChanged, unchanged, resolved };
}
