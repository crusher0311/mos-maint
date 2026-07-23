/**
 * Smoke test: Protractor retry vs concurrency-limiter deadlock guard (Task #929).
 *
 * Run: `npx tsx tests/protractor-retry-limiter-deadlock.smoke.ts`
 *
 * Background (Task #917): the 500/429 retry used to recursively re-enter the
 * shared pLimit(3) concurrency pool while the failing call still HELD its
 * slot. Three simultaneous retryable responses then deadlocked the whole
 * client forever. The fix loops inside the held slot. This test pins that
 * behavior: it fires more concurrent requests than the pool size against an
 * upstream that returns 500 to every in-flight request simultaneously, and
 * asserts every request completes (retry exhausts and returns ok:false, or a
 * later attempt succeeds) within a hard timeout. A regression re-introducing
 * recursive limiter re-entry hangs, trips the timeout, and fails fast.
 */

import {
  __protractorClientTestHooks,
  protractorFetch,
  type ProtractorConfig,
} from "../lib/integrations/protractor/client";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const HARD_TIMEOUT_MS = 30_000;
const POOL_SIZE = 3; // mirrors pLimit(3) in client.ts

const config: ProtractorConfig = {
  connectionId: "test-conn",
  apiKey: "test-key",
  authentication: "test-auth",
  configured: true,
};

// Stub out Mongo-backed collaborators and shrink retry backoff so the
// test runs in seconds. The concurrency pool, rate-limit queue, and the
// retry loop under test are the REAL production code paths.
__protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
  acquired: true,
  waitedMs: 0,
});
__protractorClientTestHooks.trackApiRequest = async () => {};
__protractorClientTestHooks.retryBaseDelayMs = 5;

function withHardTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          `HANG DETECTED: ${label} did not complete within ${HARD_TIMEOUT_MS}ms — ` +
            `the retry/limiter deadlock (Task #917) has likely regressed`,
        ),
      );
    }, HARD_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function main() {
  console.log("Scenario 1: simultaneous always-500 burst (> pool size) all complete");
  {
    let calls = 0;
    __protractorClientTestHooks.httpsRequest = async () => {
      calls += 1;
      return { statusCode: 500, body: "nginx: upstream error" };
    };

    const n = POOL_SIZE + 2; // strictly more requests than concurrency slots
    const results = await withHardTimeout(
      Promise.all(
        Array.from({ length: n }, (_, i) =>
          protractorFetch(`/Invoice/burst-${i}`, config, {}, 0, 1),
        ),
      ),
      `${n} concurrent always-500 requests`,
    );

    ok(`all ${n} requests completed (no deadlock)`, results.length === n);
    ok(
      "every request resolved ok:false after retries exhausted",
      results.every((r) => r.ok === false && /HTTP 500/.test(r.error || "")),
      JSON.stringify(results),
    );
    // GET maxRetries default is 3 → 4 attempts per request.
    ok(
      `upstream saw ${n} × 4 attempts (retries looped inside the held slot)`,
      calls === n * 4,
      `calls=${calls}`,
    );
  }

  console.log("Scenario 2: 500 burst then recovery — retries succeed, not just fail");
  {
    const attemptsByEndpoint = new Map<string, number>();
    __protractorClientTestHooks.httpsRequest = async (url: string) => {
      const key = new URL(url).pathname;
      const attempt = (attemptsByEndpoint.get(key) || 0) + 1;
      attemptsByEndpoint.set(key, attempt);
      if (attempt <= 2) return { statusCode: 500, body: "transient" };
      return { statusCode: 200, body: JSON.stringify({ recovered: true, attempt }) };
    };

    const n = POOL_SIZE + 1;
    const results = await withHardTimeout(
      Promise.all(
        Array.from({ length: n }, (_, i) =>
          protractorFetch<{ recovered: boolean }>(`/Invoice/recover-${i}`, config, {}, 0, 1),
        ),
      ),
      `${n} concurrent 500-then-200 requests`,
    );

    ok(
      "all requests eventually succeeded after in-slot retries",
      results.every((r) => r.ok === true && r.data?.recovered === true),
      JSON.stringify(results),
    );
  }

  console.log("Scenario 3: opts.maxRetries=0 fails fast under a full-pool 500 burst");
  {
    let calls = 0;
    __protractorClientTestHooks.httpsRequest = async () => {
      calls += 1;
      return { statusCode: 500, body: "boom" };
    };

    const n = POOL_SIZE;
    const results = await withHardTimeout(
      Promise.all(
        Array.from({ length: n }, (_, i) =>
          protractorFetch(`/Invoice/fast-${i}`, config, {}, 0, 1, { maxRetries: 0 }),
        ),
      ),
      `${n} concurrent no-retry requests`,
    );

    ok(
      "no-retry requests all completed with ok:false",
      results.every((r) => r.ok === false),
    );
    ok("exactly one upstream attempt each", calls === n, `calls=${calls}`);
  }

  console.log("Scenario 4: pool stays usable after the burst (slots were released)");
  {
    __protractorClientTestHooks.httpsRequest = async () => ({
      statusCode: 200,
      body: JSON.stringify({ fine: true }),
    });

    const result = await withHardTimeout(
      protractorFetch<{ fine: boolean }>("/Invoice/after", config, {}, 0, 1),
      "post-burst request",
    );
    ok("follow-up request succeeds (all slots freed)", result.ok === true && result.data?.fine === true);
  }
}

const overall = setTimeout(() => {
  console.error(`✗ OVERALL HANG: test did not finish within ${HARD_TIMEOUT_MS * 2}ms`);
  process.exit(1);
}, HARD_TIMEOUT_MS * 2);

main()
  .then(() => {
    clearTimeout(overall);
    if (failed > 0) {
      console.error(`\n${failed} check(s) failed`);
      process.exit(1);
    }
    console.log("\nAll protractor retry/limiter deadlock checks passed");
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(overall);
    console.error(`\n✗ ${err?.message || err}`);
    process.exit(1);
  });
