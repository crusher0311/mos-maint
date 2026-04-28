/**
 * Smoke test for the backfill chunk-speed alerter pure logic.
 *
 * Run: `npx tsx tests/backfill-chunk-speed-health.smoke.ts`
 *
 * Covers the two pieces the cron's correctness hinges on:
 *
 *   1. Threshold evaluation in `evaluateShop` — per-reason firing
 *      (slow_p95, high_backoff, low_*_cache), plus the gating rules
 *      (MIN_CHUNK_SAMPLES for chunk-level reasons, LOW_CACHE_MIN_LOOKUPS
 *      for cache-rate reasons, and the completed-shop short-circuit).
 *
 *   2. Dedup classification in `classifyDedup` — first-page on insert,
 *      re-page on reasons change, no re-page when reasons stable, and
 *      auto-clear on recovery.
 *
 * No DB or network — both helpers are pure and live in
 * `app/api/cron/backfill-chunk-speed-health/lib.ts`.
 */

import {
  HIGH_BACKOFF_AVG_MS,
  LOW_CACHE_HIT_RATE,
  LOW_CACHE_MIN_LOOKUPS,
  MIN_CHUNK_SAMPLES,
  P95_BASELINE_LOOKBACK,
  P95_BASELINE_MIN_SAMPLES,
  P95_HISTORY_CAP,
  P95_REGRESSION_MULTIPLIER,
  P95_REGRESSION_NOISE_FLOOR_MS,
  P95Snapshot,
  PROVIDERS,
  ProviderConfig,
  SLOW_P95_THRESHOLD_MS,
  SlowShop,
  appendP95Snapshot,
  classifyDedup,
  computeP95Baseline,
  evaluateShop,
} from "../app/api/cron/backfill-chunk-speed-health/lib";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const TEKMETRIC = PROVIDERS.find((p) => p.key === "tekmetric") as ProviderConfig;
const PROTRACTOR = PROVIDERS.find((p) => p.key === "protractor") as ProviderConfig;
const SHOPWARE = PROVIDERS.find((p) => p.key === "shopware") as ProviderConfig;

const NAMES = new Map<number, string>([
  [1, "Acme Auto"],
  [2, "Bay Area Motors"],
  [3, "Capitol Service"],
]);

/**
 * Build a `recentChunkMetrics` array of `count` entries. All scalar fields
 * default to "perfectly healthy" so each test only has to override the
 * specific reason it cares about firing. Caches default to a high hit rate
 * with enough lookups to clear LOW_CACHE_MIN_LOOKUPS.
 */
function chunks(
  count: number,
  override: Partial<{
    durationMs: number;
    backoff429Ms: number;
    jobsCacheHits: number;
    jobsCacheMisses: number;
    vehiclesCacheHits: number;
    vehiclesCacheMisses: number;
    customersCacheHits: number;
    customersCacheMisses: number;
  }> = {},
): any[] {
  const base = {
    durationMs: 1000,
    backoff429Ms: 0,
    jobsCacheHits: 90,
    jobsCacheMisses: 10,
    vehiclesCacheHits: 90,
    vehiclesCacheMisses: 10,
    customersCacheHits: 90,
    customersCacheMisses: 10,
    ...override,
  };
  return Array.from({ length: count }, () => ({ ...base }));
}

function row(shopId: number, recentChunkMetrics: any[], completed = false) {
  return { shopId, completed, recentChunkMetrics };
}

async function run() {
  console.log("backfill-chunk-speed-health smoke");

  // ---- Threshold evaluation -----------------------------------------

  // (1) Healthy shop → no reasons → null
  {
    const r = evaluateShop(TEKMETRIC, row(1, chunks(5)), NAMES);
    ok("healthy shop returns null", r === null);
  }

  // (2) Completed shop is skipped even if it would breach
  {
    const r = evaluateShop(
      TEKMETRIC,
      row(1, chunks(5, { durationMs: SLOW_P95_THRESHOLD_MS * 2 }), true),
      NAMES,
    );
    ok("completed shop short-circuits to null", r === null);
  }

  // (3) Empty / missing rollup → null
  {
    ok(
      "empty recentChunkMetrics returns null",
      evaluateShop(TEKMETRIC, row(1, []), NAMES) === null,
    );
    ok(
      "missing recentChunkMetrics returns null",
      evaluateShop(TEKMETRIC, { shopId: 1, completed: false } as any, NAMES) === null,
    );
  }

  // (4) slow_p95 fires only above threshold AND with enough samples
  {
    const tooFew = evaluateShop(
      TEKMETRIC,
      row(1, chunks(MIN_CHUNK_SAMPLES - 1, { durationMs: SLOW_P95_THRESHOLD_MS * 2 })),
      NAMES,
    );
    ok("slow_p95 gated by MIN_CHUNK_SAMPLES", tooFew === null);

    const exactlyAtThreshold = evaluateShop(
      TEKMETRIC,
      row(1, chunks(MIN_CHUNK_SAMPLES, { durationMs: SLOW_P95_THRESHOLD_MS })),
      NAMES,
    );
    ok(
      "slow_p95 strictly greater-than (equality does not fire)",
      exactlyAtThreshold === null,
    );

    const fires = evaluateShop(
      TEKMETRIC,
      row(1, chunks(MIN_CHUNK_SAMPLES, { durationMs: SLOW_P95_THRESHOLD_MS + 1 })),
      NAMES,
    );
    ok("slow_p95 fires when p95 > threshold", fires?.reasons.includes("slow_p95") === true);
    ok("slow_p95 reasonsKey == 'slow_p95'", fires?.reasonsKey === "slow_p95");
    ok("evaluateShop carries provider key", fires?.provider === "tekmetric");
    ok("evaluateShop resolves shop name", fires?.name === "Acme Auto");
  }

  // (5) high_backoff fires only above threshold AND with enough samples
  {
    const fires = evaluateShop(
      TEKMETRIC,
      row(2, chunks(MIN_CHUNK_SAMPLES, { backoff429Ms: HIGH_BACKOFF_AVG_MS + 1 })),
      NAMES,
    );
    ok("high_backoff fires when avg > threshold", fires?.reasons.includes("high_backoff") === true);

    const tooFew = evaluateShop(
      TEKMETRIC,
      row(
        2,
        chunks(MIN_CHUNK_SAMPLES - 1, { backoff429Ms: HIGH_BACKOFF_AVG_MS * 5 }),
      ),
      NAMES,
    );
    ok("high_backoff gated by MIN_CHUNK_SAMPLES", tooFew === null);
  }

  // (6) low_*_cache reasons gate on min lookups and on per-cache rate
  {
    // Below LOW_CACHE_MIN_LOOKUPS → no cache reason even if rate is bad.
    const tinySample = evaluateShop(
      TEKMETRIC,
      row(
        3,
        chunks(MIN_CHUNK_SAMPLES, {
          // 1 hit + 1 miss per chunk × 3 chunks = 6 lookups < 50
          jobsCacheHits: 1,
          jobsCacheMisses: 1,
          vehiclesCacheHits: 1,
          vehiclesCacheMisses: 1,
          customersCacheHits: 1,
          customersCacheMisses: 1,
        }),
      ),
      NAMES,
    );
    ok("low cache reasons gated by LOW_CACHE_MIN_LOOKUPS", tinySample === null);

    // Enough lookups, only jobs cache below floor → exactly low_jobs_cache
    const onlyJobs = evaluateShop(
      TEKMETRIC,
      row(
        3,
        chunks(MIN_CHUNK_SAMPLES, {
          // jobs: 10 hits / 90 misses per chunk * 3 = 30/270 → 10% < 50%, total 300
          jobsCacheHits: 10,
          jobsCacheMisses: 90,
          // vehicles & customers stay healthy at 90% with 100 lookups/chunk
        }),
      ),
      NAMES,
    );
    ok(
      "only low_jobs_cache fires when only jobs cache is bad",
      onlyJobs?.reasonsKey === "low_jobs_cache",
    );

    // Multiple caches under floor → reasonsKey is sorted, comma-joined
    const multi = evaluateShop(
      TEKMETRIC,
      row(
        3,
        chunks(MIN_CHUNK_SAMPLES, {
          jobsCacheHits: 10,
          jobsCacheMisses: 90,
          vehiclesCacheHits: 10,
          vehiclesCacheMisses: 90,
          customersCacheHits: 10,
          customersCacheMisses: 90,
        }),
      ),
      NAMES,
    );
    ok(
      "all three low_*_cache reasons fire and reasonsKey is sorted",
      multi?.reasonsKey === "low_customers_cache,low_jobs_cache,low_vehicles_cache",
    );

    // Rate exactly at LOW_CACHE_HIT_RATE should NOT fire (strict <).
    const exactly = evaluateShop(
      TEKMETRIC,
      row(
        3,
        chunks(MIN_CHUNK_SAMPLES, {
          jobsCacheHits: 50,
          jobsCacheMisses: 50,
        }),
      ),
      NAMES,
    );
    ok(
      "cache rate equal to floor does not fire (strict <)",
      exactly === null && LOW_CACHE_HIT_RATE === 0.5,
    );
  }

  // (7) Multi-reason: slow_p95 + high_backoff together produce sorted key
  {
    const r = evaluateShop(
      TEKMETRIC,
      row(
        1,
        chunks(MIN_CHUNK_SAMPLES, {
          durationMs: SLOW_P95_THRESHOLD_MS + 1,
          backoff429Ms: HIGH_BACKOFF_AVG_MS + 1,
        }),
      ),
      NAMES,
    );
    ok(
      "multi-reason produces sorted comma-joined reasonsKey",
      r?.reasonsKey === "high_backoff,slow_p95",
    );
  }

  // (8) Unknown shop falls back to "Shop {id}" placeholder name
  {
    const r = evaluateShop(
      TEKMETRIC,
      row(999, chunks(MIN_CHUNK_SAMPLES, { durationMs: SLOW_P95_THRESHOLD_MS + 1 })),
      NAMES,
    );
    ok(
      "unknown shopId falls back to 'Shop N' name",
      r?.name === "Shop 999",
    );
  }

  // ---- Dedup classification -----------------------------------------

  function makeSlow(
    provider: ProviderConfig,
    shopId: number,
    reasons: string[],
  ): SlowShop {
    const sorted = [...reasons].sort();
    return {
      provider: provider.key,
      providerLabel: provider.label,
      shopId,
      name: `Shop ${shopId}`,
      reasons,
      reasonsKey: sorted.join(","),
      rollup: {
        chunkSampleCount: 5,
        p95DurationMs: 0,
        avgBackoff429Ms: 0,
        jobsCacheHitRate: 1,
        jobsCacheTotal: 100,
        vehiclesCacheHitRate: 1,
        vehiclesCacheTotal: 100,
        customersCacheHitRate: 1,
        customersCacheTotal: 100,
      },
      p95Baseline: null,
    };
  }

  // (9) New alert: no prior row → newlySlow
  {
    const slow = [makeSlow(TEKMETRIC, 1, ["slow_p95"])];
    const c = classifyDedup(slow, []);
    ok("new alert routed to newlySlow", c.newlySlow.length === 1 && c.newlySlow[0].shopId === 1);
    ok("new alert: reasonsChanged empty", c.reasonsChanged.length === 0);
    ok("new alert: unchanged empty", c.unchanged.length === 0);
    ok("new alert: resolved empty", c.resolved.length === 0);
  }

  // (10) Stable reasons: same key as existing → unchanged, NOT re-paged
  {
    const slow = [makeSlow(TEKMETRIC, 1, ["slow_p95"])];
    const existing = [{ provider: TEKMETRIC.key, shopId: 1, reasonsKey: "slow_p95" }];
    const c = classifyDedup(slow, existing);
    ok("stable reasons routed to unchanged", c.unchanged.length === 1);
    ok("stable reasons: newlySlow empty", c.newlySlow.length === 0);
    ok("stable reasons: reasonsChanged empty", c.reasonsChanged.length === 0);
  }

  // (11) Reasons changed: existing key differs → reasonsChanged → re-page
  {
    const slow = [makeSlow(TEKMETRIC, 1, ["slow_p95", "high_backoff"])];
    const existing = [{ provider: TEKMETRIC.key, shopId: 1, reasonsKey: "slow_p95" }];
    const c = classifyDedup(slow, existing);
    ok("reasons-change routed to reasonsChanged", c.reasonsChanged.length === 1);
    ok(
      "reasons-change carries new sorted reasonsKey",
      c.reasonsChanged[0].reasonsKey === "high_backoff,slow_p95",
    );
    ok("reasons-change: newlySlow empty", c.newlySlow.length === 0);
    ok("reasons-change: unchanged empty", c.unchanged.length === 0);
  }

  // (12) Recovery: existing row with no current breach → resolved (auto-clear)
  {
    const existing = [
      { provider: TEKMETRIC.key, shopId: 1, reasonsKey: "slow_p95" },
      { provider: PROTRACTOR.key, shopId: 2, reasonsKey: "high_backoff" },
    ];
    const c = classifyDedup([], existing);
    ok("recovery: both rows queued for auto-clear", c.resolved.length === 2);
    ok(
      "recovery: resolved entries carry provider+numeric shopId",
      c.resolved.some((r) => r.provider === "tekmetric" && r.shopId === 1) &&
        c.resolved.some((r) => r.provider === "protractor" && r.shopId === 2),
    );
  }

  // (13) Dedup keying is per (provider, shopId): same shopId across two
  // providers must not be conflated.
  {
    const slow = [
      makeSlow(TEKMETRIC, 1, ["slow_p95"]),
      makeSlow(PROTRACTOR, 1, ["high_backoff"]),
    ];
    // Tekmetric row already exists with matching reasons; Protractor row is new.
    const existing = [{ provider: TEKMETRIC.key, shopId: 1, reasonsKey: "slow_p95" }];
    const c = classifyDedup(slow, existing);
    ok(
      "same shopId on different providers is not conflated",
      c.unchanged.length === 1 &&
        c.unchanged[0].provider === "tekmetric" &&
        c.newlySlow.length === 1 &&
        c.newlySlow[0].provider === "protractor",
    );
    ok("cross-provider keying: nothing resolved", c.resolved.length === 0);
  }

  // (14) Mixed scenario: one new, one stable, one changed, one resolved
  {
    const slow = [
      makeSlow(TEKMETRIC, 1, ["slow_p95"]), // new
      makeSlow(PROTRACTOR, 2, ["high_backoff"]), // stable
      makeSlow(SHOPWARE, 3, ["slow_p95", "low_jobs_cache"]), // changed
    ];
    const existing = [
      { provider: PROTRACTOR.key, shopId: 2, reasonsKey: "high_backoff" },
      { provider: SHOPWARE.key, shopId: 3, reasonsKey: "slow_p95" },
      { provider: TEKMETRIC.key, shopId: 99, reasonsKey: "slow_p95" }, // recovered
    ];
    const c = classifyDedup(slow, existing);
    ok("mixed: 1 new", c.newlySlow.length === 1 && c.newlySlow[0].shopId === 1);
    ok("mixed: 1 unchanged", c.unchanged.length === 1 && c.unchanged[0].shopId === 2);
    ok(
      "mixed: 1 reasons-changed",
      c.reasonsChanged.length === 1 && c.reasonsChanged[0].shopId === 3,
    );
    ok(
      "mixed: 1 resolved (and only the recovered shop)",
      c.resolved.length === 1 &&
        c.resolved[0].provider === "tekmetric" &&
        c.resolved[0].shopId === 99,
    );
  }

  // (15) Existing rows can store shopId as a string (older docs) and still
  // be classified correctly via numeric coercion.
  {
    const slow = [makeSlow(TEKMETRIC, 1, ["slow_p95"])];
    const existing = [
      { provider: TEKMETRIC.key, shopId: "1" as any, reasonsKey: "slow_p95" },
    ];
    const c = classifyDedup(slow, existing);
    ok(
      "existing shopId stored as string still matches",
      c.unchanged.length === 1 && c.newlySlow.length === 0 && c.resolved.length === 0,
    );
  }

  // ---- p95 regression rule -----------------------------------------

  function snapshots(p95Values: number[]): P95Snapshot[] {
    // Stable ascending timestamps so the helper's sort is a no-op.
    return p95Values.map((p95Ms, i) => ({
      at: new Date(2026, 0, 1 + i),
      p95Ms,
      sampleCount: 5,
    }));
  }

  // (16) computeP95Baseline: too few snapshots returns null
  {
    ok(
      "baseline null when below MIN_SAMPLES",
      computeP95Baseline(snapshots(Array(P95_BASELINE_MIN_SAMPLES - 1).fill(60_000))) === null,
    );
  }

  // (17) computeP95Baseline: exact median for odd count
  {
    const baseline = computeP95Baseline(snapshots([10, 20, 30]));
    ok("baseline = median (odd count)", baseline === 20);
  }

  // (18) computeP95Baseline: average of two middles for even count
  {
    const baseline = computeP95Baseline(snapshots([10, 20, 30, 40]));
    ok("baseline = avg of middles (even count)", baseline === 25);
  }

  // (19) computeP95Baseline: only the most recent LOOKBACK snapshots count
  {
    // 1 ancient huge snapshot followed by LOOKBACK low ones — the ancient
    // value must be excluded from the median window.
    const hist = snapshots([
      9_999_999,
      ...Array(P95_BASELINE_LOOKBACK).fill(60_000),
    ]);
    ok(
      "baseline ignores entries beyond LOOKBACK window",
      computeP95Baseline(hist) === 60_000,
    );
  }

  // (20) appendP95Snapshot: trims to cap (oldest dropped)
  {
    const seed = snapshots(Array.from({ length: P95_HISTORY_CAP }, (_, i) => i));
    const updated = appendP95Snapshot(seed, {
      at: new Date(2030, 0, 1),
      p95Ms: 9999,
      sampleCount: 5,
    });
    ok("appendP95Snapshot caps length at P95_HISTORY_CAP", updated.length === P95_HISTORY_CAP);
    ok("appendP95Snapshot keeps newest entry", updated[updated.length - 1].p95Ms === 9999);
    ok(
      "appendP95Snapshot drops oldest entry when capped",
      updated[0].p95Ms === 1,
    );
  }

  // (21) regressed_p95 fires when current p95 > MULTIPLIER × baseline AND
  //      above noise floor, even when well below the absolute slow_p95 limit.
  {
    // Baseline median = 1m. Current = 5m → 5×, above the 2m noise floor,
    // and below the 10m absolute slow_p95 limit (so this is the case the
    // task brief explicitly targets).
    const baseMs = 60_000;
    const currentMs = 5 * 60_000;
    const hist = snapshots(Array(P95_BASELINE_MIN_SAMPLES).fill(baseMs));
    const r = evaluateShop(
      TEKMETRIC,
      row(1, chunks(MIN_CHUNK_SAMPLES, { durationMs: currentMs })),
      NAMES,
      hist,
    );
    ok(
      "regressed_p95 fires when p95 climbs sharply against own baseline",
      r?.reasons.includes("regressed_p95") === true,
    );
    ok(
      "regressed_p95 alone does NOT also trigger slow_p95 below absolute limit",
      r?.reasonsKey === "regressed_p95",
    );
    ok(
      "regressed_p95 carries the baseline value used",
      r?.p95Baseline === baseMs,
    );
    ok(
      "evaluateShop carries current p95 in rollup",
      r?.rollup.p95DurationMs === currentMs,
    );
  }

  // (22) regressed_p95 does NOT fire when current p95 is below the noise floor
  {
    const baseMs = 1_000;
    const currentMs = P95_REGRESSION_NOISE_FLOOR_MS - 1;
    const hist = snapshots(Array(P95_BASELINE_MIN_SAMPLES).fill(baseMs));
    const r = evaluateShop(
      TEKMETRIC,
      row(1, chunks(MIN_CHUNK_SAMPLES, { durationMs: currentMs })),
      NAMES,
      hist,
    );
    ok(
      "regressed_p95 gated by noise floor (no fire near zero baseline)",
      r === null,
    );
  }

  // (23) regressed_p95 does NOT fire without enough history
  {
    const baseMs = 60_000;
    const currentMs = 10 * 60_000; // 10× baseline, way over noise floor
    const hist = snapshots(Array(P95_BASELINE_MIN_SAMPLES - 1).fill(baseMs));
    const r = evaluateShop(
      TEKMETRIC,
      row(1, chunks(MIN_CHUNK_SAMPLES, { durationMs: currentMs })),
      NAMES,
      hist,
    );
    ok(
      "regressed_p95 not fired when history is too thin",
      r?.reasons.includes("regressed_p95") !== true,
    );
  }

  // (24) regressed_p95 does NOT fire when current p95 is exactly MULTIPLIER × baseline
  {
    const baseMs = P95_REGRESSION_NOISE_FLOOR_MS; // 2m baseline so noise floor passes
    const currentMs = baseMs * P95_REGRESSION_MULTIPLIER; // exactly 3×
    const hist = snapshots(Array(P95_BASELINE_MIN_SAMPLES).fill(baseMs));
    const r = evaluateShop(
      TEKMETRIC,
      row(1, chunks(MIN_CHUNK_SAMPLES, { durationMs: currentMs })),
      NAMES,
      hist,
    );
    // Strict greater-than: equal-to should not fire (matches slow_p95 behaviour).
    ok(
      "regressed_p95 strict > MULTIPLIER × baseline (equality does not fire)",
      r?.reasons.includes("regressed_p95") !== true,
    );
  }

  // (25) regressed_p95 + slow_p95 fire together when current crosses both
  //      (sorted reasonsKey lets the dedup row track the combined state).
  {
    const baseMs = 60_000;
    const currentMs = SLOW_P95_THRESHOLD_MS + 1; // above absolute and >> 3× baseline
    const hist = snapshots(Array(P95_BASELINE_MIN_SAMPLES).fill(baseMs));
    const r = evaluateShop(
      TEKMETRIC,
      row(1, chunks(MIN_CHUNK_SAMPLES, { durationMs: currentMs })),
      NAMES,
      hist,
    );
    ok(
      "regressed_p95 and slow_p95 co-fire when both rules trip",
      r?.reasonsKey === "regressed_p95,slow_p95",
    );
    ok(
      "p95Baseline still populated when both rules fire",
      r?.p95Baseline === baseMs,
    );
  }

  // (26) When evaluateShop is called with no history (legacy callers /
  //      brand-new shops) it must not crash and must skip regressed_p95.
  {
    const r = evaluateShop(
      TEKMETRIC,
      row(1, chunks(MIN_CHUNK_SAMPLES, { durationMs: SLOW_P95_THRESHOLD_MS + 1 })),
      NAMES,
      // no history arg → defaults to []
    );
    ok(
      "no history → regressed_p95 does not fire, slow_p95 still does",
      r?.reasonsKey === "slow_p95" && r?.p95Baseline === null,
    );
  }

  if (failed > 0) {
    console.error(`\nFAILED ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(2);
});
