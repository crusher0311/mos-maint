/**
 * Smoke test for the Postgres backend of the cross-process Tekmetric rate
 * limiter (task #557). Mirrors the Mongo smoke test
 * (`tekmetric-shared-rate-limiter.smoke.ts`) but drives the limiter with
 * `TEKMETRIC_SHARED_LIMITER_PG_CANONICAL=1` and an injected fake postgres-js
 * client (`pgOverride`). No real DB is touched.
 *
 * Pins that the PG backend preserves the same safety semantics:
 *   - under-cap calls acquire immediately,
 *   - over-cap callers release their slot and roll into the next second,
 *   - a crashed window self-heals on the next bucket,
 *   - priority lanes (background effectiveCap) are honored,
 *   - a PG error degrades to per-process fallback (acquired:true, fallback:true),
 *   - sustained over-cap pressure fails closed,
 *   - TEKMETRIC_SHARED_LIMITER_FAIL_OPEN flips the timeout to pass-through.
 */
import {
  acquireSharedTekmetricSlot,
  isSharedLimiterPgCanonical,
} from "../lib/integrations/tekmetric/shared-rate-limiter";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Fake postgres-js client implementing the three queries the PG bucket
 * backend issues against `tekmetric_rate_buckets`: increment (INSERT ...
 * ON CONFLICT ... RETURNING count), decrement (UPDATE ... count - 1), and
 * the opportunistic expiry sweep (DELETE ...). State is an in-memory map.
 */
function makeFakePgSql() {
  const buckets = new Map<string, { count: number }>();
  return {
    buckets,
    unsafe: async (query: string, params?: any[]) => {
      if (query.includes("INSERT INTO tekmetric_rate_buckets")) {
        const key = params![0];
        const row = buckets.get(key) ?? { count: 0 };
        row.count += 1;
        buckets.set(key, row);
        return [{ count: row.count }];
      }
      if (query.startsWith("UPDATE tekmetric_rate_buckets") || query.includes("count - 1")) {
        const key = params![0];
        const row = buckets.get(key);
        if (row) row.count -= 1;
        return [];
      }
      if (query.includes("DELETE FROM tekmetric_rate_buckets")) {
        return [];
      }
      return [];
    },
  };
}

function makeClock(startSeconds: number) {
  let cur = startSeconds * 1000;
  const sleeps: number[] = [];
  return {
    now: () => cur,
    advance: (ms: number) => { cur += ms; },
    sleeps,
  };
}

async function run() {
  console.log("tekmetric-shared-rate-limiter-pg smoke");

  const prevFlag = process.env.TEKMETRIC_SHARED_LIMITER_PG_CANONICAL;
  process.env.TEKMETRIC_SHARED_LIMITER_PG_CANONICAL = "1";
  try {
    ok("PG canonical flag detected", isSharedLimiterPgCanonical() === true);

    // 1. Single-process steady state under cap: every call acquires fast.
    {
      const sql = makeFakePgSql();
      const clock = makeClock(1_700_000_000);
      const sleep = async (ms: number) => { clock.sleeps.push(ms); clock.advance(ms); };
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(
          await acquireSharedTekmetricSlot({
            capOverride: 8,
            pgOverride: sql,
            nowMs: clock.now,
            sleep,
          }),
        );
      }
      ok(
        "5 under-cap calls all acquired immediately, no sleeps",
        results.every((r) => r.acquired && !r.fallback && !r.timedOut) && clock.sleeps.length === 0,
        `sleeps=${JSON.stringify(clock.sleeps)}`,
      );
      const key = `tek:${Math.floor(clock.now() / 1000)}`;
      ok("bucket count reflects 5 acquisitions", sql.buckets.get(key)?.count === 5);
    }

    // 2. Over-cap caller releases its slot and rolls to the next second.
    {
      const sql = makeFakePgSql();
      const clock = makeClock(1_700_000_010);
      const sleep = async (ms: number) => { clock.sleeps.push(ms); clock.advance(ms); };
      const firstKey = `tek:${Math.floor(clock.now() / 1000)}`;
      for (let i = 0; i < 4; i++) {
        await acquireSharedTekmetricSlot({ capOverride: 4, pgOverride: sql, nowMs: clock.now, sleep });
      }
      const overflow = await acquireSharedTekmetricSlot({ capOverride: 4, pgOverride: sql, nowMs: clock.now, sleep });
      ok("5th call (cap=4) acquired after waiting", overflow.acquired && !overflow.fallback && !overflow.timedOut);
      ok("5th call paid at least one sleep", clock.sleeps.length >= 1 && clock.sleeps[0] > 0);
      ok("overflow caller released its slot in the saturated bucket", sql.buckets.get(firstKey)?.count === 4,
        `firstBucket=${JSON.stringify(sql.buckets.get(firstKey))}`);
      ok("two distinct buckets exist", sql.buckets.size === 2);
    }

    // 3. Recovery: a crashed window self-heals on the next bucket.
    {
      const sql = makeFakePgSql();
      const clock = makeClock(1_700_000_020);
      const sleep = async (ms: number) => { clock.sleeps.push(ms); clock.advance(ms); };
      for (let i = 0; i < 4; i++) {
        await acquireSharedTekmetricSlot({ capOverride: 4, pgOverride: sql, nowMs: clock.now, sleep });
      }
      clock.advance(1100);
      const recovered = await acquireSharedTekmetricSlot({ capOverride: 4, pgOverride: sql, nowMs: clock.now, sleep });
      ok("next-bucket call after crash acquires immediately", recovered.acquired && clock.sleeps.length === 0,
        `sleeps=${JSON.stringify(clock.sleeps)}`);
    }

    // 4. Priority lane: background sees cap - reserve; 6th background waits.
    {
      const sql = makeFakePgSql();
      const clock = makeClock(1_700_000_100);
      const sleep = async (ms: number) => { clock.sleeps.push(ms); clock.advance(ms); };
      const firstKey = `tek:${Math.floor(clock.now() / 1000)}`;
      for (let i = 0; i < 5; i++) {
        const r = await acquireSharedTekmetricSlot({
          capOverride: 8, userReserveOverride: 3, priority: "background",
          pgOverride: sql, nowMs: clock.now, sleep,
        });
        ok(`background call ${i + 1}/5 acquired in first bucket`, r.acquired && !r.fallback);
      }
      const sleepsBefore = clock.sleeps.length;
      const sixth = await acquireSharedTekmetricSlot({
        capOverride: 8, userReserveOverride: 3, priority: "background",
        pgOverride: sql, nowMs: clock.now, sleep,
      });
      ok("6th background call rolled to next bucket (lane ceiling)",
        sixth.acquired && !sixth.fallback && clock.sleeps.length > sleepsBefore);
      ok("first bucket settled at background lane ceiling (5)", sql.buckets.get(firstKey)?.count === 5);
    }

    // 5. PG error on increment degrades to per-process fallback.
    {
      const throwingSql = { unsafe: async () => { throw new Error("simulated pg blip"); } };
      const r = await acquireSharedTekmetricSlot({ capOverride: 4, pgOverride: throwingSql });
      ok("PG error falls back to per-process behavior", r.acquired && r.fallback === true, JSON.stringify(r));
    }

    // 6. Sustained over-cap pressure fails closed by default.
    {
      const overCapSql = {
        unsafe: async (query: string) => {
          if (query.includes("INSERT INTO tekmetric_rate_buckets")) return [{ count: 999 }];
          return [];
        },
      };
      const clock = makeClock(1_700_000_030);
      const advancingSleep = async (ms: number) => { clock.advance(Math.max(ms, 600)); };
      const r = await acquireSharedTekmetricSlot({
        capOverride: 2, pgOverride: overCapSql, nowMs: clock.now, sleep: advancingSleep,
      });
      ok("sustained over-cap fails closed (acquired:false, timedOut:true)",
        r.acquired === false && r.timedOut === true, JSON.stringify(r));
    }

    // 7. FAIL_OPEN flips the timeout to pass-through.
    {
      const overCapSql = {
        unsafe: async (query: string) => {
          if (query.includes("INSERT INTO tekmetric_rate_buckets")) return [{ count: 999 }];
          return [];
        },
      };
      const prev = process.env.TEKMETRIC_SHARED_LIMITER_FAIL_OPEN;
      process.env.TEKMETRIC_SHARED_LIMITER_FAIL_OPEN = "true";
      try {
        const clock = makeClock(1_700_000_040);
        const advancingSleep = async (ms: number) => { clock.advance(Math.max(ms, 600)); };
        const r = await acquireSharedTekmetricSlot({
          capOverride: 2, pgOverride: overCapSql, nowMs: clock.now, sleep: advancingSleep,
        });
        ok("fail-open flips timeout to acquired:true with timedOut:true",
          r.acquired === true && r.timedOut === true, JSON.stringify(r));
      } finally {
        if (prev === undefined) delete process.env.TEKMETRIC_SHARED_LIMITER_FAIL_OPEN;
        else process.env.TEKMETRIC_SHARED_LIMITER_FAIL_OPEN = prev;
      }
    }
  } finally {
    if (prevFlag === undefined) delete process.env.TEKMETRIC_SHARED_LIMITER_PG_CANONICAL;
    else process.env.TEKMETRIC_SHARED_LIMITER_PG_CANONICAL = prevFlag;
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll tekmetric-shared-rate-limiter-pg smoke checks passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
