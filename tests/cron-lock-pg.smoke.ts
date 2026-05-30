/**
 * Smoke test for the Postgres-backed cron distributed lock (task #557).
 *
 * Run: `npx tsx tests/cron-lock-pg.smoke.ts`
 *
 * Exercises `tryAcquireLockPg` / `releaseLockPg` from lib/cron/scheduler.cjs
 * against an injected fake postgres-js client (no real DB). Pins the same
 * contract the Mongo backend provides:
 *   - acquire on a free lock,
 *   - a second instance is blocked while the lease is live,
 *   - the same instance can refresh its own lease,
 *   - a different instance takes over once the lease expires,
 *   - release is fenced on instanceId (a stale holder cannot free a
 *     successor's lock),
 *   - the CRON_LOCK_PG_CANONICAL flag reader reflects the env.
 */
const scheduler = require("../lib/cron/scheduler.cjs");
const { tryAcquireLockPg, releaseLockPg, isCronLockPgCanonical } = scheduler;

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

function makeClock(startMs: number): Clock {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/**
 * Fake postgres-js client implementing just enough of `cron_locks` semantics
 * for the two queries the lock issues. `now()` is driven by the injected
 * clock so expiry/takeover is deterministic.
 */
function makeFakeCronSql(clock: Clock) {
  const store = new Map<string, { expiresAt: number; instanceId: string }>();
  return {
    store,
    unsafe: async (query: string, params: any[]) => {
      if (query.includes("INSERT INTO cron_locks")) {
        const [jobName, ttlMs, instanceId] = params;
        const now = clock.now();
        const existing = store.get(jobName);
        const canTake =
          !existing ||
          existing.expiresAt <= now ||
          existing.instanceId === instanceId;
        if (canTake) {
          store.set(jobName, { expiresAt: now + Number(ttlMs), instanceId });
          return [{ instance_id: instanceId }];
        }
        return [];
      }
      if (query.includes("DELETE FROM cron_locks")) {
        const [jobName, instanceId] = params;
        const existing = store.get(jobName);
        if (existing && existing.instanceId === instanceId) store.delete(jobName);
        return [];
      }
      return [];
    },
  };
}

async function run() {
  console.log("cron-lock-pg smoke");

  // 0. Flag reader.
  {
    const prev = process.env.CRON_LOCK_PG_CANONICAL;
    delete process.env.CRON_LOCK_PG_CANONICAL;
    ok("flag off by default", isCronLockPgCanonical() === false);
    process.env.CRON_LOCK_PG_CANONICAL = "1";
    ok("flag on when set to '1'", isCronLockPgCanonical() === true);
    process.env.CRON_LOCK_PG_CANONICAL = "true";
    ok("flag only honors exact '1'", isCronLockPgCanonical() === false);
    if (prev === undefined) delete process.env.CRON_LOCK_PG_CANONICAL;
    else process.env.CRON_LOCK_PG_CANONICAL = prev;
  }

  const TTL = 10 * 60 * 1000; // 10 min

  // 1. Acquire on a free lock.
  {
    const clock = makeClock(1_700_000_000_000);
    const sql = makeFakeCronSql(clock);
    const got = await tryAcquireLockPg("protractor-sync", TTL, "instA", sql);
    ok("instance A acquires a free lock", got === true);
    ok("lock row recorded for instance A", sql.store.get("protractor-sync")?.instanceId === "instA");
  }

  // 2. Second instance blocked while lease is live; same instance refreshes.
  {
    const clock = makeClock(1_700_000_000_000);
    const sql = makeFakeCronSql(clock);
    await tryAcquireLockPg("job", TTL, "instA", sql);
    const bGot = await tryAcquireLockPg("job", TTL, "instB", sql);
    ok("instance B blocked while A holds a live lease", bGot === false);
    ok("lock still owned by A", sql.store.get("job")?.instanceId === "instA");

    clock.advance(60_000); // 1 min later, still within TTL
    const aRefresh = await tryAcquireLockPg("job", TTL, "instA", sql);
    ok("instance A can refresh its own live lease", aRefresh === true);
    ok(
      "refresh extended the expiry",
      sql.store.get("job")!.expiresAt === clock.now() + TTL,
    );
  }

  // 3. Takeover after expiry.
  {
    const clock = makeClock(1_700_000_000_000);
    const sql = makeFakeCronSql(clock);
    await tryAcquireLockPg("job", TTL, "instA", sql);
    clock.advance(TTL + 1000); // lease expired
    const bGot = await tryAcquireLockPg("job", TTL, "instB", sql);
    ok("instance B takes over an expired lease", bGot === true);
    ok("lock now owned by B", sql.store.get("job")?.instanceId === "instB");
  }

  // 4. Fenced release: stale holder cannot free a successor's lock.
  {
    const clock = makeClock(1_700_000_000_000);
    const sql = makeFakeCronSql(clock);
    await tryAcquireLockPg("job", TTL, "instA", sql);
    clock.advance(TTL + 1000);
    await tryAcquireLockPg("job", TTL, "instB", sql); // B took over

    await releaseLockPg("job", "instA", sql); // stale A tries to release
    ok("stale A's release does NOT delete B's lock", sql.store.has("job") === true);
    ok("lock still owned by B after stale release", sql.store.get("job")?.instanceId === "instB");

    await releaseLockPg("job", "instB", sql); // rightful owner releases
    ok("rightful owner B's release frees the lock", sql.store.has("job") === false);

    const cGot = await tryAcquireLockPg("job", TTL, "instC", sql);
    ok("instance C acquires after the lock is freed", cGot === true);
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll cron-lock-pg smoke checks passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
