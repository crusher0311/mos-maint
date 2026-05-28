/**
 * Smoke test for the per-shop backfill queue feature flag (task #513).
 *
 * Locks in the precedence order documented in `lib/queue/feature-flag.ts`:
 *   kill switch > redis-missing > per-shop allow > global enabled > default off
 *
 * Regression target: a future "simplification" that reorders these
 * branches could silently enable the queue path before Redis is
 * provisioned (the redis-missing branch must short-circuit even when
 * the per-shop or global flag is on), or could let the kill switch be
 * overridden by a per-shop opt-in (which would defeat the rollback
 * runbook).
 */

import assert from "node:assert";

// `decideQueueFor` reads `process.env` on every call (see
// `lib/queue/feature-flag.ts` and `lib/queue/connection.ts`
// `isQueueEnabled`), so a single import is enough — each test just
// mutates env and calls the function fresh.
import { decideQueueFor } from "../lib/queue/feature-flag";

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main() {
  // Default off — no REDIS_URL, no flags set → in-process path.
  await withEnv(
    {
      REDIS_URL: undefined,
      BACKFILL_QUEUE_DISABLED: undefined,
      BACKFILL_QUEUE_ENABLED: undefined,
      BACKFILL_QUEUE_SHOPS: undefined,
    },
    () => {
      const d = decideQueueFor(42);
      assert.strictEqual(d.useQueue, false, "default should be off");
      assert.strictEqual(d.reason, "redis_missing");
    },
  );

  // Per-shop allowlist requires Redis to actually count.
  withEnv(
    {
      REDIS_URL: undefined,
      BACKFILL_QUEUE_SHOPS: "42,99",
      BACKFILL_QUEUE_ENABLED: undefined,
      BACKFILL_QUEUE_DISABLED: undefined,
    },
    () => {
      const d = decideQueueFor(42);
      assert.strictEqual(
        d.useQueue,
        false,
        "per-shop allow must short-circuit when Redis missing",
      );
      assert.strictEqual(d.reason, "redis_missing");
    },
  );

  // With Redis set, per-shop allowlist wins over global default-off.
  withEnv(
    {
      REDIS_URL: "redis://localhost:6379",
      BACKFILL_QUEUE_SHOPS: "42,99",
      BACKFILL_QUEUE_ENABLED: undefined,
      BACKFILL_QUEUE_DISABLED: undefined,
    },
    () => {
      assert.strictEqual(decideQueueFor(42).useQueue, true, "shop 42 allowed");
      assert.strictEqual(decideQueueFor(42).reason, "per_shop_allow");
      assert.strictEqual(decideQueueFor(7).useQueue, false, "shop 7 not allowed");
      assert.strictEqual(decideQueueFor(7).reason, "default_off");
    },
  );

  // Global enabled covers everyone.
  withEnv(
    {
      REDIS_URL: "redis://localhost:6379",
      BACKFILL_QUEUE_ENABLED: "true",
      BACKFILL_QUEUE_SHOPS: undefined,
      BACKFILL_QUEUE_DISABLED: undefined,
    },
    () => {
      assert.strictEqual(decideQueueFor(7).useQueue, true);
      assert.strictEqual(decideQueueFor(7).reason, "global_enabled");
    },
  );

  // Kill switch wins over everything.
  withEnv(
    {
      REDIS_URL: "redis://localhost:6379",
      BACKFILL_QUEUE_ENABLED: "true",
      BACKFILL_QUEUE_SHOPS: "42",
      BACKFILL_QUEUE_DISABLED: "true",
    },
    () => {
      const d42 = decideQueueFor(42);
      assert.strictEqual(
        d42.useQueue,
        false,
        "kill switch must override per-shop allow",
      );
      assert.strictEqual(d42.reason, "kill_switch");
      const d7 = decideQueueFor(7);
      assert.strictEqual(
        d7.useQueue,
        false,
        "kill switch must override global enabled",
      );
      assert.strictEqual(d7.reason, "kill_switch");
    },
  );

  console.log("queue-feature-flag.smoke.ts: OK");
}

main().catch((err) => {
  console.error("queue-feature-flag.smoke.ts FAILED:", err);
  process.exit(1);
});
