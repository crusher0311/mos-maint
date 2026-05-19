/**
 * Smoke test for the backfill load alerter pure logic (task #465).
 *
 * Run: `npx tsx tests/backfill-load-alerter.smoke.ts`
 *
 * Covers the three rule detectors and the dedup-key builder. The route
 * handler does only orchestration on top of these — DB I/O, email send,
 * and state-based upsert — so testing the pure logic gives us the bulk
 * of the safety net without spinning up Mongo or Resend.
 */

import {
  BackfillProvider,
  EVENT_LOOP_P99_MS_THRESHOLD,
  buildAlertKey,
  findEventLoopLagHits,
  findP95DoubledHits,
  findRateLimiterTimeoutHits,
} from "../app/api/cron/backfill-load-alerter/lib";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const now = Date.now();
function chunk(
  provider: BackfillProvider,
  durationMs: number,
  opts: { rateLimiterTimeouts?: number; rateLimiterFallbacks?: number; ageMs?: number } = {},
) {
  return {
    provider,
    chunkEndedAt: new Date(now - (opts.ageMs ?? 0)),
    durationMs,
    writes: {
      rateLimiterTimeouts: opts.rateLimiterTimeouts ?? 0,
      rateLimiterFallbacks: opts.rateLimiterFallbacks ?? 0,
    },
  };
}

function sample(p99Ms: number, ageMs = 0) {
  return {
    sampledAt: new Date(now - ageMs),
    eventLoopLagMs: { p99: p99Ms },
  };
}

// (1) Rate-limiter timeout detector --------------------------------------
{
  console.log("findRateLimiterTimeoutHits");
  const hits = findRateLimiterTimeoutHits([
    chunk("tekmetric", 1000),
    chunk("tekmetric", 1000, { rateLimiterTimeouts: 2 }),
    chunk("tekmetric", 1000, { rateLimiterFallbacks: 1 }),
    chunk("protractor", 1000),
  ]);
  ok("emits one hit per provider with any timeout/fallback", hits.length === 1);
  ok("includes totals + chunk counts", hits[0]?.totalTimeouts === 2 && hits[0]?.totalFallbacks === 1);
  ok("counts chunks with timeouts vs total chunks", hits[0]?.chunksWithTimeouts === 1 && hits[0]?.chunkCount === 3);

  const clean = findRateLimiterTimeoutHits([chunk("tekmetric", 1000), chunk("protractor", 1000)]);
  ok("no hits when no timeouts/fallbacks", clean.length === 0);

  const multiProvider = findRateLimiterTimeoutHits([
    chunk("tekmetric", 1, { rateLimiterTimeouts: 1 }),
    chunk("shopware", 1, { rateLimiterFallbacks: 3 }),
  ]);
  ok("one hit per provider", multiProvider.length === 2);
  ok(
    "stable ordering for dedup key",
    multiProvider[0].provider < multiProvider[1].provider,
  );
}

// (2) Event-loop lag detector ---------------------------------------------
{
  console.log("findEventLoopLagHits");
  const noBreach = findEventLoopLagHits([sample(50), sample(80), sample(99)]);
  ok("null when no sample crosses threshold", noBreach === null);

  const oneBreach = findEventLoopLagHits([sample(50), sample(120)]);
  ok("hit when any sample crosses threshold", oneBreach !== null);
  ok("breachCount counts breaching samples only", oneBreach?.breachCount === 1);
  ok("sampleCount = total samples observed", oneBreach?.sampleCount === 2);
  ok("worstP99Ms captures peak", oneBreach?.worstP99Ms === 120);
  ok(
    `threshold default matches EVENT_LOOP_P99_MS_THRESHOLD (${EVENT_LOOP_P99_MS_THRESHOLD})`,
    oneBreach?.thresholdMs === EVENT_LOOP_P99_MS_THRESHOLD,
  );

  // latestBreach should reflect chronologically newest breaching sample.
  const latest = findEventLoopLagHits([sample(150, 60_000), sample(120, 0)]);
  ok("latestBreachP99Ms is the most recent breaching p99", latest?.latestBreachP99Ms === 120);

  // Empty + missing eventLoopLagMs handled.
  ok("null on empty input", findEventLoopLagHits([]) === null);
  const missing = [{ sampledAt: new Date(), eventLoopLagMs: null as any }];
  ok("null when no usable p99 values", findEventLoopLagHits(missing) === null);
}

// (3) P95 doubling detector ----------------------------------------------
{
  console.log("findP95DoubledHits");
  // Baseline p95 around 60s, recent p95 around 200s — clear doubling.
  const baseline = Array.from({ length: 20 }, (_, i) =>
    chunk("tekmetric", 30_000 + i * 1500),
  );
  const recent = Array.from({ length: 20 }, (_, i) =>
    chunk("tekmetric", 150_000 + i * 5_000),
  );
  const hits = findP95DoubledHits(recent, baseline);
  ok("fires on clear 2× regression above noise floor", hits.length === 1);
  ok("includes recent + baseline p95 + multiplier", hits[0]?.multiplier >= 2);
  ok("includes sample counts", hits[0]?.recentSampleCount === 20 && hits[0]?.baselineSampleCount === 20);

  // No hit when recent < 2× baseline. Baseline p95 here is ~58s, so a recent
  // p95 of ~90s sits at ~1.5× — below the 2× multiplier.
  const mild = findP95DoubledHits(
    Array.from({ length: 20 }, () => chunk("tekmetric", 90_000)),
    baseline,
  );
  ok("no hit when regression below multiplier", mild.length === 0);

  // No hit below noise floor (baseline 5s → recent 15s wouldn't matter).
  const noisy = findP95DoubledHits(
    Array.from({ length: 20 }, () => chunk("tekmetric", 15_000)),
    Array.from({ length: 20 }, () => chunk("tekmetric", 5_000)),
  );
  ok("no hit below noise floor even with 3×", noisy.length === 0);

  // No hit when insufficient samples.
  const thin = findP95DoubledHits(
    [chunk("tekmetric", 999_999)],
    Array.from({ length: 20 }, () => chunk("tekmetric", 60_000)),
  );
  ok("no hit when recent sample count below min", thin.length === 0);

  const thinBaseline = findP95DoubledHits(
    Array.from({ length: 20 }, () => chunk("tekmetric", 200_000)),
    [chunk("tekmetric", 60_000)],
  );
  ok("no hit when baseline sample count below min", thinBaseline.length === 0);

  // Per-provider scoping.
  const perProvider = findP95DoubledHits(
    [
      ...Array.from({ length: 10 }, () => chunk("tekmetric", 200_000)),
      ...Array.from({ length: 10 }, () => chunk("protractor", 60_000)),
    ],
    [
      ...Array.from({ length: 10 }, () => chunk("tekmetric", 60_000)),
      ...Array.from({ length: 10 }, () => chunk("protractor", 50_000)),
    ],
  );
  ok("scopes regression check per provider", perProvider.length === 1 && perProvider[0].provider === "tekmetric");
}

// (4) Dedup key --------------------------------------------------------
{
  console.log("buildAlertKey");
  ok("empty hit set → empty key", buildAlertKey([]) === "");

  const a = buildAlertKey([
    { reason: "rate_limiter_timeouts", provider: "tekmetric" } as any,
    { reason: "event_loop_lag" } as any,
  ]);
  const b = buildAlertKey([
    { reason: "event_loop_lag" } as any,
    { reason: "rate_limiter_timeouts", provider: "tekmetric" } as any,
  ]);
  ok("key order-independent (sorted)", a === b);

  const c = buildAlertKey([
    { reason: "rate_limiter_timeouts", provider: "tekmetric" } as any,
    { reason: "rate_limiter_timeouts", provider: "protractor" } as any,
  ]);
  ok("multi-provider rate-limiter has stable key", c === "rate_limiter_timeouts:protractor|rate_limiter_timeouts:tekmetric");

  const same = buildAlertKey([{ reason: "rate_limiter_timeouts", provider: "tekmetric" } as any]);
  const different = buildAlertKey([
    { reason: "rate_limiter_timeouts", provider: "tekmetric" } as any,
    { reason: "p95_doubled", provider: "tekmetric" } as any,
  ]);
  ok("adding a reason changes the key (re-page)", same !== different);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll backfill-load-alerter smoke checks passed.");
