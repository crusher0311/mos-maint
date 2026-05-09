/**
 * Smoke test for the cross-process Tekmetric rate limiter.
 *
 * Run: `npx tsx tests/tekmetric-shared-rate-limiter.smoke.ts`
 *
 * Pins:
 *   - Single-process steady state: under-cap calls all acquire immediately.
 *   - Multi-process steady state: bucket count is shared across simulated
 *     processes; over-cap callers wait for the next second's bucket.
 *   - Recovery after a process crash mid-window: bucket TTL means a stranded
 *     count harmlessly expires and the next bucket is fresh.
 *   - Mongo blip on getDb: graceful fallback (acquired:true, fallback:true).
 *   - Mongo blip on $inc: graceful fallback (acquired:true, fallback:true).
 *   - Hard ceiling: cap is clamped to 10 even if env asks for more.
 *   - Disable flag: TEKMETRIC_SHARED_LIMITER_DISABLED short-circuits.
 *   - Sustained over-cap pressure fails closed (acquired:false) so callers
 *     don't breach the cap.
 *   - TEKMETRIC_SHARED_LIMITER_FAIL_OPEN flips the timeout to pass-through
 *     with a CAP BREACH warning.
 */

import {
  __deps,
  __resetIndexEnsuredForTest,
  acquireSharedTekmetricSlot,
  getSharedTekmetricRpsCap,
  isSharedLimiterDisabled,
} from "../lib/integrations/tekmetric/shared-rate-limiter";
import { makeFakeDb } from "./utils/fake-mongo";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Patch the fake-mongo collection to also support findOneAndUpdate, which
// the shared limiter uses but the shared fake-mongo helper doesn't ship.
function withLimiterFakeDb() {
  const fake = makeFakeDb({ tekmetric_rate_buckets: [] });
  const realCollection = fake.db.collection.bind(fake.db);
  fake.db.collection = (name: string) => {
    const col: any = realCollection(name);
    col.findOneAndUpdate = async (filter: any, update: any, opts?: any) => {
      // Single-key {_id: x} filter only — that's all the limiter sends.
      const id = filter._id;
      const data = fake.collections[name];
      let doc = data.find((d: any) => d._id === id);
      if (!doc) {
        if (!opts?.upsert) return null;
        doc = {
          _id: id,
          ...(update.$setOnInsert || {}),
          ...(update.$set || {}),
        };
        data.push(doc);
      }
      for (const [k, v] of Object.entries(update.$inc || {})) {
        doc[k] = (Number(doc[k]) || 0) + Number(v);
      }
      return { ...doc };
    };
    return col;
  };
  return fake;
}

async function withClock<T>(
  startSeconds: number,
  body: (ctx: {
    advance: (ms: number) => void;
    now: () => number;
    sleeps: number[];
  }) => Promise<T>,
): Promise<T> {
  let cur = startSeconds * 1000;
  const sleeps: number[] = [];
  return body({
    advance: (ms: number) => {
      cur += ms;
    },
    now: () => cur,
    sleeps,
  });
}

async function run() {
  console.log("tekmetric-shared-rate-limiter smoke");

  // 0. Cap defaults and env clamping.
  {
    const prev = process.env.TEKMETRIC_SHARED_RPS_CAP;
    delete process.env.TEKMETRIC_SHARED_RPS_CAP;
    ok("default cap is 8", getSharedTekmetricRpsCap() === 8);
    process.env.TEKMETRIC_SHARED_RPS_CAP = "5";
    ok("env override of 5 honored", getSharedTekmetricRpsCap() === 5);
    process.env.TEKMETRIC_SHARED_RPS_CAP = "999";
    ok(
      "cap clamped to 10 hard ceiling even with env=999",
      getSharedTekmetricRpsCap() === 10,
    );
    process.env.TEKMETRIC_SHARED_RPS_CAP = "garbage";
    ok("garbage env falls back to default 8", getSharedTekmetricRpsCap() === 8);
    if (prev === undefined) delete process.env.TEKMETRIC_SHARED_RPS_CAP;
    else process.env.TEKMETRIC_SHARED_RPS_CAP = prev;
  }

  // 1. Single-process steady state under cap: every call acquires fast.
  {
    __resetIndexEnsuredForTest();
    const fake = withLimiterFakeDb();
    await withClock(1_700_000_000, async (clock) => {
      const sleep = async (ms: number) => {
        clock.sleeps.push(ms);
        clock.advance(ms);
      };
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(
          await acquireSharedTekmetricSlot({
            capOverride: 8,
            dbOverride: fake.db,
            nowMs: clock.now,
            sleep,
          }),
        );
      }
      ok(
        "5 under-cap calls all acquired immediately, no sleeps",
        results.every((r) => r.acquired && !r.fallback && !r.timedOut) &&
          clock.sleeps.length === 0,
        `sleeps=${JSON.stringify(clock.sleeps)} fallback=${results.some((r) => r.fallback)}`,
      );
      const bucket = fake.collections.tekmetric_rate_buckets[0];
      ok(
        "bucket count reflects 5 acquisitions",
        bucket?.count === 5,
        `bucket=${JSON.stringify(bucket)}`,
      );
    });
  }

  // 2. Two simulated processes share the same bucket: the 5th caller (cap=4)
  //    is forced to wait for the next second.
  {
    __resetIndexEnsuredForTest();
    const fake = withLimiterFakeDb(); // both "processes" point at same fake db
    await withClock(1_700_000_010, async (clock) => {
      const sleep = async (ms: number) => {
        clock.sleeps.push(ms);
        clock.advance(ms);
      };
      // 4 acquisitions fill the bucket.
      for (let i = 0; i < 4; i++) {
        await acquireSharedTekmetricSlot({
          capOverride: 4,
          dbOverride: fake.db,
          nowMs: clock.now,
          sleep,
        });
      }
      const overflow = await acquireSharedTekmetricSlot({
        capOverride: 4,
        dbOverride: fake.db,
        nowMs: clock.now,
        sleep,
      });
      ok(
        "5th call (cap=4) eventually acquired after waiting",
        overflow.acquired && !overflow.fallback && !overflow.timedOut,
        JSON.stringify(overflow),
      );
      ok(
        "5th call paid at least one sleep to roll into next bucket",
        clock.sleeps.length >= 1 && clock.sleeps[0] > 0,
        `sleeps=${JSON.stringify(clock.sleeps)}`,
      );
      // Two distinct buckets exist now.
      ok(
        "two distinct per-second buckets exist",
        fake.collections.tekmetric_rate_buckets.length === 2,
        `buckets=${JSON.stringify(fake.collections.tekmetric_rate_buckets)}`,
      );
      // The first bucket should be back at 4 (not 5) because the overflow
      // call released its slot before sleeping.
      const firstBucket = fake.collections.tekmetric_rate_buckets[0];
      ok(
        "overflow caller released its slot in the saturated bucket",
        firstBucket?.count === 4,
        `firstBucket=${JSON.stringify(firstBucket)}`,
      );
    });
  }

  // 3. Recovery: a "crashed" process leaves count incremented but never makes
  //    the API call. Subsequent calls in the *next* bucket see a fresh count.
  {
    __resetIndexEnsuredForTest();
    const fake = withLimiterFakeDb();
    await withClock(1_700_000_020, async (clock) => {
      const sleep = async (ms: number) => {
        clock.sleeps.push(ms);
        clock.advance(ms);
      };
      // Crashed process consumed all 4 slots of bucket N then died.
      for (let i = 0; i < 4; i++) {
        await acquireSharedTekmetricSlot({
          capOverride: 4,
          dbOverride: fake.db,
          nowMs: clock.now,
          sleep,
        });
      }
      // Time advances into the next second.
      clock.advance(1100);
      const recovered = await acquireSharedTekmetricSlot({
        capOverride: 4,
        dbOverride: fake.db,
        nowMs: clock.now,
        sleep,
      });
      ok(
        "next-bucket call after crash acquires immediately (no waits)",
        recovered.acquired && clock.sleeps.length === 0,
        `sleeps=${JSON.stringify(clock.sleeps)}`,
      );
    });
  }

  // 4. Mongo unavailable on getDb: graceful fallback.
  {
    __resetIndexEnsuredForTest();
    const originalGetDb = __deps.getDb;
    __deps.getDb = async () => {
      throw new Error("simulated mongo down");
    };
    try {
      const r = await acquireSharedTekmetricSlot({ capOverride: 4 });
      ok(
        "getDb failure falls back to per-process behavior",
        r.acquired && r.fallback === true,
        JSON.stringify(r),
      );
    } finally {
      __deps.getDb = originalGetDb;
    }
  }

  // 5. Mongo blip on $inc: graceful fallback.
  {
    __resetIndexEnsuredForTest();
    const fake = withLimiterFakeDb();
    const realCollection = fake.db.collection.bind(fake.db);
    fake.db.collection = (name: string) => {
      const col: any = realCollection(name);
      col.findOneAndUpdate = async () => {
        throw new Error("simulated mongo $inc blip");
      };
      return col;
    };
    const r = await acquireSharedTekmetricSlot({
      capOverride: 4,
      dbOverride: fake.db,
    });
    ok(
      "$inc failure falls back to per-process behavior",
      r.acquired && r.fallback === true,
      JSON.stringify(r),
    );
  }

  // Helper: a fake db whose findOneAndUpdate always reports the bucket as
  // already over cap, simulating sustained multi-process pressure on every
  // bucket the caller tries.
  function alwaysOverCapDb() {
    return {
      collection: (_name: string) => ({
        createIndex: async () => "fake",
        findOneAndUpdate: async (_f: any, _u: any, _o: any) => ({
          _id: "x",
          count: 999,
        }),
        updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
      }),
    } as any;
  }

  // 5b. Sustained over-cap pressure fails closed by default.
  {
    __resetIndexEnsuredForTest();
    await withClock(1_700_000_030, async (clock) => {
      const advancingSleep = async (ms: number) => {
        // Advance enough each sleep to roll the elapsed counter past
        // MAX_WAIT_MS (5s) within a couple iterations.
        clock.advance(Math.max(ms, 600));
      };
      const r = await acquireSharedTekmetricSlot({
        capOverride: 2,
        dbOverride: alwaysOverCapDb(),
        nowMs: clock.now,
        sleep: advancingSleep,
      });
      ok(
        "sustained over-cap pressure fails closed (acquired:false, timedOut:true)",
        r.acquired === false && r.timedOut === true,
        JSON.stringify(r),
      );
    });
  }

  // 5c. TEKMETRIC_SHARED_LIMITER_FAIL_OPEN flips timeout to pass-through.
  {
    __resetIndexEnsuredForTest();
    const prev = process.env.TEKMETRIC_SHARED_LIMITER_FAIL_OPEN;
    process.env.TEKMETRIC_SHARED_LIMITER_FAIL_OPEN = "true";
    try {
      await withClock(1_700_000_040, async (clock) => {
        const advancingSleep = async (ms: number) => {
          clock.advance(Math.max(ms, 600));
        };
        const r = await acquireSharedTekmetricSlot({
          capOverride: 2,
          dbOverride: alwaysOverCapDb(),
          nowMs: clock.now,
          sleep: advancingSleep,
        });
        ok(
          "fail-open env flips timeout to acquired:true with timedOut:true",
          r.acquired === true && r.timedOut === true,
          JSON.stringify(r),
        );
      });
    } finally {
      if (prev === undefined)
        delete process.env.TEKMETRIC_SHARED_LIMITER_FAIL_OPEN;
      else process.env.TEKMETRIC_SHARED_LIMITER_FAIL_OPEN = prev;
    }
  }

  // 6. Disable flag short-circuits.
  {
    const prev = process.env.TEKMETRIC_SHARED_LIMITER_DISABLED;
    process.env.TEKMETRIC_SHARED_LIMITER_DISABLED = "true";
    try {
      ok("disabled flag detected", isSharedLimiterDisabled() === true);
      const r = await acquireSharedTekmetricSlot();
      ok(
        "disabled flag returns immediately as fallback",
        r.acquired && r.fallback === true && r.waitedMs === 0,
        JSON.stringify(r),
      );
    } finally {
      if (prev === undefined)
        delete process.env.TEKMETRIC_SHARED_LIMITER_DISABLED;
      else process.env.TEKMETRIC_SHARED_LIMITER_DISABLED = prev;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll tekmetric-shared-rate-limiter smoke checks passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
