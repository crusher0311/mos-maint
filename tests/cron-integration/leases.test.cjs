const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { config } = require("./config.cjs");

// Validate before loading drivers or the scheduler. No dotenv and no app boot.
const { mongoUrl, pgUrl } = config(process.env);
const { MongoClient } = require("mongodb");
const postgres = require("postgres");
const scheduler = require("../../lib/cron/scheduler.cjs");
global.__cronMongoClient = { db() { throw new Error("Application Mongo access forbidden"); } };
global.__cronPgSql = { unsafe() { throw new Error("Application PostgreSQL access forbidden"); } };
const CONNECTIONS = 8;

async function race(peers, name, ttl) {
  let start;
  const gate = new Promise(resolve => { start = resolve; });
  const attempts = peers.map(async peer => {
    const owner = randomUUID();
    await gate;
    return { owner, acquired: await peer.acquire(name, ttl, owner) };
  });
  start();
  const results = await Promise.all(attempts);
  assert.ok(results.every(result => typeof result.acquired === "boolean"));
  const winners = results.filter(result => result.acquired);
  assert.equal(winners.length, 1, "exactly one independent connection must acquire");
  assert.equal(results.filter(result => !result.acquired).length, CONNECTIONS - 1);
  return winners[0].owner;
}

async function contract(peers, inspect, duplicate, waitExpired) {
  // Repeated fresh-key contention exercises insert races, not just updates.
  for (let round = 0; round < 6; round++) {
    const name = `simultaneous-${round}`;
    const owner = await race(peers, name, 60_000);
    assert.equal(await inspect(name), owner);
    await duplicate(name); // actual server uniqueness error, not a fake boundary
    assert.equal(await peers[1].acquire(name, 60_000, owner), false,
      "even the current execution cannot reacquire an unexpired lease");
    await peers[2].release(name, randomUUID());
    assert.equal(await inspect(name), owner, "non-owner release must preserve the lease");
    await peers[3].release(name, owner);
    assert.equal(await inspect(name), null, "owner release must delete the lease");
  }

  const name = "expiry-takeover";
  const oldOwner = randomUUID();
  assert.equal(await peers[0].acquire(name, 400, oldOwner), true);
  assert.equal(await peers[1].acquire(name, 60_000, randomUUID()), false);
  await waitExpired(name);
  const successor = await race(peers, name, 60_000);
  assert.notEqual(successor, oldOwner);
  await peers[0].release(name, oldOwner);
  assert.equal(await inspect(name), successor, "expired execution must not delete its successor");
  assert.equal(await peers[1].acquire(name, 60_000, randomUUID()), false);
  await peers[2].release(name, successor);
  assert.equal(await inspect(name), null);
  const finalOwner = randomUUID();
  assert.equal(await peers[3].acquire(name, 60_000, finalOwner), true);
  await peers[3].release(name, finalOwner);
  assert.equal(await inspect(name), null);
}

test("real MongoDB lease exclusion and execution fencing", { timeout: 45_000 }, async () => {
  const database = `cron_lease_test_${randomUUID().replaceAll("-", "")}`;
  const clients = Array.from({ length: CONNECTIONS }, () => new MongoClient(mongoUrl, {
    maxPoolSize: 1, serverSelectionTimeoutMS: 3000, socketTimeoutMS: 5000,
    monitorCommands: true,
  }));
  let created = false;
  let duplicateFailures = 0;
  for (const client of clients) client.on("commandSucceeded", event => {
    if (event.commandName === "update") {
      duplicateFailures += (event.reply.writeErrors || []).filter(e => e.code === 11000).length;
    }
  });
  try {
    await Promise.all(clients.map(client => client.connect()));
    const dbs = clients.map(client => client.db(database));
    await dbs[0].createCollection("cron_locks");
    created = true;
    const collection = dbs[0].collection("cron_locks");
    const peers = dbs.map(db => ({
      acquire: (name, ttl, owner) => scheduler.tryAcquireLockMongo(name, ttl, owner, db),
      release: (name, owner) => scheduler.releaseLockMongo(name, owner, db),
    }));
    await contract(peers,
      async name => (await collection.findOne({ _id: name }))?.instanceId ?? null,
      name => assert.rejects(
        collection.insertOne({ _id: name, instanceId: "duplicate" }),
        error => error.code === 11000),
      async name => {
        const row = await collection.findOne({ _id: name });
        await delay(Math.max(0, row.expiresAt.getTime() - Date.now()) + 50);
      });
    assert.ok(duplicateFailures > 0, "scheduler must handle real Mongo upsert duplicate-key responses");
    assert.equal(await collection.countDocuments(), 0);
  } finally {
    try {
      if (created) await clients[0].db(database).dropDatabase();
    } finally {
      await Promise.all(clients.map(client => client.close()));
    }
  }
});

test("real PostgreSQL lease exclusion and execution fencing", { timeout: 45_000 }, async () => {
  const schema = `cron_lease_test_${randomUUID().replaceAll("-", "")}`;
  const clients = Array.from({ length: CONNECTIONS }, () => postgres(pgUrl, {
    max: 1, connect_timeout: 3, idle_timeout: 5,
    connection: { statement_timeout: 5000, search_path: schema },
    onnotice() {},
  }));
  let created = false;
  try {
    const pids = await Promise.all(clients.map(sql => sql`SELECT pg_backend_pid() AS pid`));
    assert.equal(new Set(pids.map(rows => rows[0].pid)).size, CONNECTIONS,
      "contenders must use independent PostgreSQL sessions");
    await clients[0].unsafe(`CREATE SCHEMA "${schema}"`);
    created = true;
    // Same column types and unique key as drizzle/0018_task557_operational_primitives.sql.
    await clients[0].unsafe(`CREATE TABLE "${schema}".cron_locks (
      job_name text PRIMARY KEY, locked_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL, instance_id text NOT NULL
    )`);
    const peers = clients.map(sql => ({
      acquire: (name, ttl, owner) => scheduler.tryAcquireLockPg(name, ttl, owner, sql),
      release: (name, owner) => scheduler.releaseLockPg(name, owner, sql),
    }));
    await contract(peers,
      async name => (await clients[0]`SELECT instance_id FROM cron_locks WHERE job_name = ${name}`)[0]?.instance_id ?? null,
      name => assert.rejects(clients[1]`INSERT INTO cron_locks
        (job_name, expires_at, instance_id) VALUES (${name}, now(), 'duplicate')`,
        error => error.code === "23505"),
      async name => {
        // Use the server clock, without changing timestamps or mocking expiry.
        for (let attempt = 0; attempt < 100; attempt++) {
          const [row] = await clients[0]`SELECT expires_at <= now() AS expired
            FROM cron_locks WHERE job_name = ${name}`;
          if (row.expired) return;
          await delay(25);
        }
        assert.fail("PostgreSQL lease did not expire within the bounded wait");
      });
    assert.equal(Number((await clients[0]`SELECT count(*) AS n FROM cron_locks`)[0].n), 0);
  } finally {
    try {
      if (created) await clients[0].unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await Promise.all(clients.map(sql => sql.end({ timeout: 2 })));
    }
  }
});
