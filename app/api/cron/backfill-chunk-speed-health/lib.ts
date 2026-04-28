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

export function evaluateShop(
  provider: ProviderConfig,
  progressRow: any,
  shopNamesById: Map<number, string>,
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
