const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { config } = require("./config.cjs");

// Same guard as healthy-server tests; validate BEFORE drivers or any sockets.
const { mongoUrl, pgUrl } = config(process.env);
const { MongoClient } = require("mongodb");
const postgres = require("postgres");
const scheduler = require("../../lib/cron/scheduler.cjs");
const { faultProxy } = require("./fault-proxy.cjs");
global.__cronMongoClient = { db() { throw new Error("Application Mongo access forbidden"); } };
global.__cronPgSql = { unsafe() { throw new Error("Application PostgreSQL access forbidden"); } };

async function until(predicate, message, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(message);
}

// Attach rejection handling immediately, including for postgres-js lazy queries.
async function outcome(operation) {
  try { return { value: await operation() }; }
  catch (error) { return { error }; }
}

async function fixture(kind, run) {
  const namespace = `cron_lease_test_${randomUUID().replaceAll("-", "")}`;
  const proxy = await faultProxy(kind === "mongo" ? 27185 : 55485);
  const clients = [];
  let cleanup = async () => {};
  try {
    let peers, inspect, warm, failureCount;
    if (kind === "mongo") {
      let failures = 0;
      for (const url of [mongoUrl, mongoUrl.replace(":27185", `:${proxy.port}`)]) {
        const client = new MongoClient(url, {
          maxPoolSize: 1, serverSelectionTimeoutMS: 1500, socketTimeoutMS: 1500,
          monitorCommands: true,
        });
        clients.push(client);
        client.on("commandFailed", event => {
          if (["update", "delete"].includes(event.commandName)) failures++;
        });
        await client.connect();
      }
      const dbs = clients.map(client => client.db(namespace));
      await dbs[0].createCollection("cron_locks");
      cleanup = () => dbs[0].dropDatabase();
      peers = dbs.map(db => ({
        acquire: (name, ttl, owner) => scheduler.tryAcquireLockMongo(name, ttl, owner, db),
        release: (name, owner) => scheduler.releaseLockMongo(name, owner, db),
      }));
      inspect = async name => {
        const row = await dbs[0].collection("cron_locks").findOne({ _id: name });
        return row ? { owner: row.instanceId, remaining: row.expiresAt.getTime() - Date.now() } : null;
      };
      warm = () => dbs[1].command({ ping: 1 });
      failureCount = () => failures;
    } else {
      for (const url of [pgUrl, pgUrl.replace(":55485", `:${proxy.port}`)]) {
        clients.push(postgres(url, {
          max: 1, connect_timeout: 2, idle_timeout: 30,
          connection: { statement_timeout: 2000, search_path: namespace },
          onnotice() {},
        }));
      }
      await clients[0].unsafe(`CREATE SCHEMA "${namespace}"`);
      cleanup = () => clients[0].unsafe(`DROP SCHEMA "${namespace}" CASCADE`);
      await clients[0].unsafe(`CREATE TABLE "${namespace}".cron_locks (
        job_name text PRIMARY KEY, locked_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL, instance_id text NOT NULL
      )`);
      peers = clients.map(sql => ({
        acquire: (name, ttl, owner) => scheduler.tryAcquireLockPg(name, ttl, owner, sql),
        release: (name, owner) => scheduler.releaseLockPg(name, owner, sql),
      }));
      inspect = async name => {
        const [row] = await clients[0]`SELECT instance_id AS owner,
          extract(epoch FROM (expires_at - clock_timestamp())) * 1000 AS remaining
          FROM cron_locks WHERE job_name = ${name}`;
        return row ? { owner: row.owner, remaining: Number(row.remaining) } : null;
      };
      warm = () => clients[1]`SELECT 1`;
      failureCount = () => 0;
    }
    await warm(); // complete handshakes before arming the wire fault
    await run({ direct: peers[0], victim: peers[1], inspect, warm, failureCount, proxy });
  } finally {
    try { await cleanup(); }
    finally {
      try {
        await Promise.all(clients.map(client => kind === "mongo"
          ? client.close() : client.end({ timeout: 2 })));
      } finally { await proxy.close(); }
    }
  }
}

async function noAdmissionBeforeExpiry(direct, inspect, name, owner) {
  // Repeated attempts, not just one snapshot. Assert there was real TTL left,
  // so a slow test cannot accidentally pass without testing pre-expiry safety.
  const initial = await inspect(name);
  assert.equal(initial?.owner, owner);
  assert.ok(initial.remaining > 500, "fault must resolve well before lease expiry");
  for (let i = 0; i < 3; i++) {
    assert.equal(await direct.acquire(name, 10_000, randomUUID()), false);
    assert.equal((await inspect(name))?.owner, owner);
    await delay(30);
  }
}

async function successorFence({ direct, victim, inspect, warm }, name, oldOwner) {
  await warm(); // real reconnection through the healed proxy
  const successor = randomUUID();
  const admissions = await Promise.all([
    direct.acquire(name, 10_000, successor),
    victim.acquire(name, 10_000, randomUUID()),
  ]);
  assert.equal(admissions.filter(Boolean).length, 1, "one successor after recovery");
  const winner = (await inspect(name)).owner;
  assert.notEqual(winner, oldOwner);
  await victim.release(name, oldOwner);
  assert.equal((await inspect(name))?.owner, winner, "stale release cannot erase successor");
  assert.equal(await direct.acquire(name, 10_000, randomUUID()), false);
  await direct.release(name, winner);
  assert.equal(await inspect(name), null);
  assert.equal(await victim.acquire(name, 10_000, randomUUID()), true,
    "recovered driver can acquire after legitimate release");
}

for (const kind of ["mongo", "postgres"]) {
  for (const scenario of ["lost-acquire-ack", "release-not-delivered", "lost-release-ack"]) {
    test(`${kind}: ${scenario} preserves exclusion and successor fencing`,
      { timeout: 25_000 }, async () => fixture(kind, async ctx => {
        const { direct, victim, inspect, proxy, failureCount } = ctx;
        const name = scenario;
        const owner = randomUUID();
        const ttl = 5000;
        if (scenario !== "lost-acquire-ack") {
          assert.equal(await victim.acquire(name, ttl, owner), true);
        }
        const failuresBefore = failureCount();
        const fault = proxy.arm(scenario === "release-not-delivered" ? "request" : "response");
        const pending = outcome(() => scenario === "lost-acquire-ack"
          ? victim.acquire(name, ttl, owner) : victim.release(name, owner));
        try {
          await until(() => fault.bytes > 0, "proxy must intercept actual wire bytes");
          if (scenario === "lost-acquire-ack") {
            await until(async () => (await inspect(name))?.owner === owner,
              "independent observer must see committed acquisition without acknowledgment");
          } else if (scenario === "lost-release-ack") {
            await until(async () => await inspect(name) === null,
              "independent observer must see committed release without acknowledgment");
          } else {
            assert.equal((await inspect(name))?.owner, owner,
              "request-side interruption must leave the lease intact");
          }
        } finally {
          proxy.cut();
        }
        const result = await pending;
        if (kind === "postgres") {
          assert.ok(result.error, "real PostgreSQL driver must report the interrupted operation");
          assert.match(result.error.code, /CONNECTION_|ECONN|EPIPE/);
        } else {
          assert.ok(failureCount() > failuresBefore, "real Mongo driver must report a failed command");
          if (scenario === "lost-acquire-ack") assert.equal(result.value, false);
          assert.equal(result.error, undefined, "Mongo helper handles network errors fail-closed");
        }
        proxy.recover();
        if (scenario !== "lost-release-ack") {
          await noAdmissionBeforeExpiry(direct, inspect, name, owner);
          await until(async () => (await inspect(name)).remaining <= 0,
            "lease must expire naturally", ttl + 1000);
        }
        // A committed release allows early admission. An uncommitted release
        // or ambiguous acquisition must retain exclusion until natural expiry.
        await successorFence(ctx, name, owner);
      }));
  }
}
