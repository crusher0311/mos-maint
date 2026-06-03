/**
 * Smoke test for the pre-cutover readiness check and retry-from-failed
 * action (task #567).
 *
 * Runs in CI with NO Redis, so it locks in the deterministic
 * Redis-absent behavior:
 *   - readiness reports a hard blocker and ok=false when REDIS_URL is
 *     unset (the most common "did the operator forget to provision?"
 *     state),
 *   - the flag posture is reported correctly (kill switch / canary /
 *     fleet / off) regardless of Redis,
 *   - retryFailedJob fails closed with `queue_unavailable` rather than
 *     throwing when the queue can't be constructed.
 *
 * Regression target: a refactor that makes the readiness check throw on
 * a missing/unreachable Redis (instead of returning a structured
 * blocker) would break the operator's go/no-go and the admin dashboard.
 */

import assert from "node:assert";

import { getQueueReadiness } from "../lib/queue/readiness";
import { retryFailedJob } from "../lib/queue/actions";

function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function main() {
  // No REDIS_URL → not ready, hard blocker, but never throws.
  await withEnv(
    {
      REDIS_URL: undefined,
      BACKFILL_QUEUE_DISABLED: undefined,
      BACKFILL_QUEUE_ENABLED: undefined,
      BACKFILL_QUEUE_SHOPS: undefined,
    },
    async () => {
      const r = await getQueueReadiness();
      assert.strictEqual(r.ok, false, "should not be ready without Redis");
      assert.strictEqual(r.redis.urlSet, false, "urlSet false");
      assert.strictEqual(r.redis.reachable, false, "not reachable");
      assert.ok(
        r.blockers.some((b) => /REDIS_URL/.test(b)),
        "blocker should mention REDIS_URL",
      );
      assert.strictEqual(
        r.flags.effectiveMode,
        "redis_missing",
        "mode is redis_missing when no Redis even if no kill switch",
      );
      // Every queue is reported with zero consumers.
      assert.ok(
        r.workers.perQueue.length >= 4,
        "all queues reported",
      );
      assert.strictEqual(r.workers.totalConsuming, 0, "no workers");
    },
  );

  // Kill switch ON is reported as a warning + effectiveMode, regardless
  // of Redis being absent.
  await withEnv(
    {
      REDIS_URL: undefined,
      BACKFILL_QUEUE_DISABLED: "true",
      BACKFILL_QUEUE_ENABLED: "true",
      BACKFILL_QUEUE_SHOPS: "42",
    },
    async () => {
      const r = await getQueueReadiness();
      assert.strictEqual(r.flags.killSwitch, true, "kill switch detected");
      assert.strictEqual(
        r.flags.effectiveMode,
        "kill_switch",
        "kill switch wins the effective mode",
      );
      assert.ok(
        r.warnings.some((w) => /kill switch/i.test(w)),
        "kill switch surfaced as a warning",
      );
    },
  );

  // Flag posture: per-shop list + global flag are parsed/reported even
  // when Redis is missing (the actual routing decision still resolves to
  // redis_missing, which is the safe behavior).
  await withEnv(
    {
      REDIS_URL: undefined,
      BACKFILL_QUEUE_DISABLED: undefined,
      BACKFILL_QUEUE_ENABLED: undefined,
      BACKFILL_QUEUE_SHOPS: "7, 42 ,bad,99",
    },
    async () => {
      const r = await getQueueReadiness();
      assert.deepStrictEqual(
        r.flags.perShopAllow,
        [7, 42, 99],
        "allowlist parsed, junk dropped",
      );
      // Each allowlisted shop + one synthetic "other" decision reported.
      assert.ok(
        r.flags.decisions.length >= 4,
        "decisions include each allowlisted shop and an 'other' sample",
      );
      for (const d of r.flags.decisions) {
        assert.strictEqual(
          d.reason,
          "redis_missing",
          "without Redis every decision short-circuits to redis_missing",
        );
        assert.strictEqual(d.useQueue, false, "redis_missing never routes");
      }
    },
  );

  // retryFailedJob fails closed (no throw) when the queue can't be built.
  await withEnv({ REDIS_URL: undefined }, async () => {
    const res = await retryFailedJob("tekmetric-fullpage", "tekmetric-fullpage:42");
    assert.strictEqual(res.ok, false, "retry not ok without Redis");
    if (!res.ok) {
      assert.strictEqual(
        res.reason,
        "queue_unavailable",
        "retry reports queue_unavailable, not a throw",
      );
    }
  });

  console.log("queue-readiness.smoke.ts: OK");
}

main().catch((err) => {
  console.error("queue-readiness.smoke.ts FAILED:", err);
  process.exit(1);
});
