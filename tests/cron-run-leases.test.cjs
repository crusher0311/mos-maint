const { test } = require("node:test");
const assert = require("node:assert/strict");
const scheduler = require("../lib/cron/scheduler.cjs");
const { CRON_JOBS } = require("../lib/cron/jobs.cjs");

// Fail hard if a test accidentally leaves the injected boundaries.
global.__cronMongoClient = { db() { throw new Error("Unexpected real Mongo access"); } };
global.__cronPgSql = { unsafe() { throw new Error("Unexpected real PG access"); } };

function harness(backend) {
  let time = 100000;
  const rows = new Map();
  const sql = {
    async unsafe(query, params) {
      const [name, value, owner] = params;
      if (query.includes("INSERT INTO")) {
        assert.match(query, /WHERE cron_locks.expires_at <= now\(\)/);
        assert.doesNotMatch(query, /OR\s+cron_locks.instance_id/);
        const row = rows.get(name);
        if (row && row.expiresAt > time) return [];
        rows.set(name, { owner, expiresAt: time + value });
        return [{ instance_id: owner }];
      }
      assert.match(query, /WHERE job_name = \$1 AND instance_id = \$2/);
      if (rows.get(name)?.owner === value) rows.delete(name);
      return [];
    },
  };
  const db = { collection(name) {
    assert.equal(name, "cron_locks");
    return {
      async updateOne(filter, update, options) {
        assert.equal(options.upsert, true);
        assert.deepEqual(filter.$or, [
          { expiresAt: { $lte: new Date(time) } },
          { expiresAt: { $exists: false } },
        ]);
        const old = rows.get(filter._id);
        if (old && old.expiresAt > time) throw Object.assign(new Error("duplicate"), { code: 11000 });
        rows.set(filter._id, { owner: update.$set.instanceId, expiresAt: +update.$set.expiresAt });
        return { acknowledged: true, matchedCount: old ? 1 : 0, upsertedCount: old ? 0 : 1 };
      },
      async deleteOne(filter) {
        assert.deepEqual(Object.keys(filter).sort(), ["_id", "instanceId"]);
        if (rows.get(filter._id)?.owner === filter.instanceId) rows.delete(filter._id);
      },
    };
  }};
  const acquire = (name, ttl, owner) => backend === "pg"
    ? scheduler.tryAcquireLockPg(name, ttl, owner, sql)
    : scheduler.tryAcquireLockMongo(name, ttl, owner, db, time);
  const release = (name, owner) => backend === "pg"
    ? scheduler.releaseLockPg(name, owner, sql)
    : scheduler.releaseLockMongo(name, owner, db);
  const pending = [];
  const timers = new Set();
  const records = [];
  const deps = {
    acquire, release, now: () => time,
    setTimeout(fn, ms) { const timer = { fn, at: time + ms }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    record: async (_, record) => records.push(record),
    request: (_, { signal }) => new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })));
    }),
  };
  const job = { name: "job", path: "/test", schedule: "* * * * *", timeoutMs: 10000, lockTtlMs: 100 };
  const tick = (instance = "boot-A") => scheduler.runJob(job, "http://unused", "fake", instance, deps);
  return { rows, acquire, release, deps, records, pending, job, tick,
    advance(ms) { time += ms; },
    fireTimers() { for (const timer of timers) if (timer.at <= time) timer.fn(); },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (status = 200) => ({ ok: status === 200, status, text: () => "done" });

for (const backend of ["mongo", "pg"]) {
  test(`${backend}: scheduler excludes same-process and cross-process overlap; completion permits next tick`, async () => {
    const h = harness(backend);
    const first = h.tick();
    await flush();
    await Promise.all([h.tick(), h.tick("boot-B")]);
    assert.equal(h.pending.length, 1);
    const firstOwner = h.rows.get("job").owner;
    assert.notEqual(firstOwner, "boot-A");
    assert.equal(await h.acquire("job", 20000, firstOwner), false, "admission is not renewal");
    assert.equal(h.rows.get("job").expiresAt, 115000);
    h.pending[0].resolve(response());
    await first;
    assert.equal(h.rows.size, 0);
    const second = h.tick();
    await flush();
    assert.notEqual(h.rows.get("job").owner, firstOwner);
    h.pending[1].resolve(response(503));
    await second;
    assert.equal(h.rows.size, 0, "complete non-2xx response releases");
    assert.equal(h.records[0].instanceId, "boot-A");
  });

  test(`${backend}: expired execution completion cannot release or renew same-process successor`, async () => {
    const h = harness(backend);
    const first = h.tick();
    await flush();
    const oldOwner = h.rows.get("job").owner;
    h.advance(15000); // Simulate stalled event loop; deadline callback has not run.
    const second = h.tick();
    await flush();
    const successor = { ...h.rows.get("job") };
    assert.notEqual(successor.owner, oldOwner);
    assert.equal(await h.acquire("job", 20000, oldOwner), false);
    await h.release("job", oldOwner);
    h.pending[0].resolve(response());
    await first;
    assert.deepEqual(h.rows.get("job"), successor);
    h.pending[1].resolve(response());
    await second;
  });

  for (const failure of ["timeout", "connection-reset"]) {
    test(`${backend}: ${failure} retains lease until expiry, without renewal`, async () => {
      const h = harness(backend);
      const first = h.tick();
      await flush();
      const lease = { ...h.rows.get("job") };
      if (failure === "timeout") { h.advance(10000); h.fireTimers(); }
      else h.pending[0].reject(new Error("connection reset"));
      await first;
      assert.deepEqual(h.rows.get("job"), lease);
      assert.equal(h.records[0].leaseRetained, true);
      await h.tick();
      assert.equal(h.pending.length, 1);
      h.advance(failure === "timeout" ? 5000 : 15000);
      const next = h.tick();
      await flush();
      assert.equal(h.pending.length, 2);
      assert.notEqual(h.rows.get("job").owner, lease.owner);
      h.pending[1].resolve(response());
      await next;
    });
  }

  test(`${backend}: slow acquisition cannot dispatch past request budget; legacy rows exclude new runs`, async () => {
    const h = harness(backend);
    h.rows.set("job", { owner: "legacy-boot", expiresAt: 101000 });
    await h.tick();
    assert.equal(h.pending.length, 0);
    h.advance(1000);
    h.deps.acquire = async (...args) => {
      const acquired = await h.acquire(...args);
      h.advance(10001);
      return acquired;
    };
    await h.tick();
    assert.equal(h.pending.length, 0);
    assert.equal(h.rows.size, 0);
  });
}

test("all configured jobs cover deadlines plus explicit headroom; no renewal API exists", () => {
  assert.ok(CRON_JOBS.length > 0);
  for (const job of CRON_JOBS) {
    const policy = scheduler.leasePolicy(job);
    assert.ok(policy.ttlMs >= policy.timeoutMs + policy.headroomMs, job.name);
  }
  for (const name of ["data-quality", "daily-all"]) {
    const daily = CRON_JOBS.find((job) => job.name === name);
    assert.ok(daily);
    assert.equal(scheduler.leasePolicy(daily).ttlMs, 30 * 60000);
  }
  assert.equal(Object.keys(scheduler).some((key) => /renew/i.test(key)), false);
  assert.throws(() => scheduler.leasePolicy({ timeoutMs: 0 }));
  assert.throws(() => scheduler.leasePolicy({ timeoutMs: Infinity }));
});

test("both canonical-store errors fail closed without transport or fallback", async () => {
  const previous = process.env.CRON_LOCK_PG_CANONICAL;
  try {
    for (const flag of ["0", "1"]) {
      process.env.CRON_LOCK_PG_CANONICAL = flag;
      await scheduler.runJob({ name: "unavailable", path: "/test" }, "http://unused", "fake", "boot", {
        request() { assert.fail("Must not dispatch on failed admission"); },
        record() { assert.fail("Must not record an unadmitted run"); },
      });
    }
  } finally {
    if (previous === undefined) delete process.env.CRON_LOCK_PG_CANONICAL;
    else process.env.CRON_LOCK_PG_CANONICAL = previous;
  }
});
