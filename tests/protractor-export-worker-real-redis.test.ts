import test from "node:test";
import assert from "node:assert/strict";
import { spawn, fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { fixturePg } from "./helpers/export-worker-pg";

const cleanEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "test" };
async function until(check: () => unknown | Promise<unknown>, timeout = 10000) {
  const start = Date.now();
  while (!await check()) {
    if (Date.now() - start > timeout) throw Error(`Condition timed out after ${timeout}ms`);
    await sleep(50);
  }
}
function track(child: ChildProcess) {
  let output = "";
  child.stdout?.on("data", chunk => { output += chunk; });
  child.stderr?.on("data", chunk => { output += chunk; });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, closed, output: () => output };
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test("export-only entry point: real PostgreSQL + Redis, real signals, durable synthetic delivery", { timeout: 1500000 }, async t => {
  // Fail closed when invoked directly without the sanitized wrapper/preload.
  assert.throws(() => net.connect({ host: "192.0.2.1", port: 443 }), /external network denied/);
  assert.throws(() => new net.Socket().connect({ host: "example.com", port: 443 }), /external network denied/);
  assert.equal(process.env.MONGODB_PASSWORD, undefined);
  assert.equal(process.env.REDIS_URL, undefined);
  for (const key of Object.keys(process.env))
    assert.ok(!/PASSWORD|SECRET|TOKEN|DATABASE_URL|MONGODB|NEON|SUPABASE/.test(key), key);
  assert.throws(() => net.connect("/tmp/not-the-fixture/.s.PGSQL.5432"), /external network denied/);
  const { sql, collections } = fixturePg();
  const directory = mkdtempSync("/tmp/export-worker-real-");
  const port = await freePort(), redisUrl = `redis://127.0.0.1:${port}`;
  const children: ReturnType<typeof track>[] = [];
  let redisProcess: ReturnType<typeof track> | undefined;
  let client: Redis | undefined, queue: Queue | undefined;
  let receiverMode: "accept" | "reject" | "hang" = "accept";
  const received: { id: string; body: string }[] = [];
  const held: ServerResponse[] = [];
  const receiver = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const id = String(req.headers["x-mos-delivery-id"]);
      received.push({ id, body });
      if (receiverMode === "hang") { held.push(res); return; }
      if (receiverMode === "reject") { res.writeHead(503); res.end(); return; }
      res.writeHead(202, { "x-mos-acknowledgment": id }); res.end();
    });
  });
  await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const receiverPort = (receiver.address() as net.AddressInfo).port;
  const read = (name: string) => collections[name].find({}).toArray();
  const events = () => readFileSync(join(directory, "events"), "utf8");
  async function reset() {
    writeFileSync(join(directory, "events"), "");
    await sql.unsafe("TRUNCATE protractor_export.states, protractor_export.hashes, protractor_export.history, protractor_export.health, protractor_export.configs");
    await collections.configs.insertOne({ _id: "synthetic-enterprise", revision: 1, shopIds: [999999],
      timeZone: "UTC", dailyTime: "00:00",
      paused: false, revoked: false, destination: "synthetic-only", secret: "synthetic-only" });
  }
  async function pending(id: string) {
    await collections.states.insertOne({ _id: "synthetic-state", enterpriseId: "synthetic-enterprise",
      revision: 1, shopId: 999999, attempts: 0, window: new Date().toISOString().slice(0, 10),
      pending: { deliveryId: id, body: JSON.stringify({ synthetic: true, deliveryId: id }),
        createdAt: new Date().toISOString(), hashes: [{ key: "invoice_synthetic", hash: "synthetic-hash" }],
        after: "synthetic-record", entity: "invoice", final: true, recordCount: 1 } });
  }
  async function startRedis() {
    redisProcess = track(spawn("redis-server", ["--bind", "127.0.0.1", "--port", String(port),
      "--dir", directory, "--save", "", "--appendonly", "yes", "--appendfsync", "always",
      "--protected-mode", "yes"], { env: cleanEnv, stdio: ["ignore", "pipe", "pipe"] }));
    children.push(redisProcess);
    await until(() => {
      assert.equal(redisProcess!.child.exitCode, null, redisProcess!.output());
      return redisProcess!.output().includes("Ready to accept connections");
    });
  }
  function startWorker(preflight = "", crashPoint = "") {
    const worker = track(fork("workers/export-only.ts", [], {
      execArgv: ["--require", "./tests/helpers/export-worker-network-guard.cjs",
        "--require", "./tests/helpers/export-worker-preload.cjs", "--import", "tsx"],
      env: { ...cleanEnv, PROTRACTOR_EXPORTS_ENABLED: "1", REDIS_URL: redisUrl,
        MONGODB_URI: "mongodb://127.0.0.1/synthetic-unused", PROTRACTOR_EXPORT_ENCRYPTION_KEY: "a".repeat(64),
        DATABASE_URL: "postgres://synthetic-unused",
        EXPORT_FIXTURE_PG_SOCKET: process.env.EXPORT_FIXTURE_PG_SOCKET,
        EXPORT_FIXTURE_CRASH_POINT: crashPoint,
        EXPORT_FIXTURE_DIRECTORY: directory, EXPORT_FIXTURE_RECEIVER_PORT: String(receiverPort),
        EXPORT_FIXTURE_PREFLIGHT: preflight },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }));
    children.push(worker);
    return worker;
  }
  async function ready(worker: ReturnType<typeof track>) {
    await until(() => {
      assert.equal(worker.child.exitCode, null, worker.output());
      return worker.output().includes("Export-only consumer ready");
    });
  }
  async function stop(worker: ReturnType<typeof track>) {
    worker.child.kill("SIGTERM");
    assert.deepEqual(await worker.closed, { code: 0, signal: null }, worker.output());
  }
  async function onlyExportQueue() {
    const keys = await client!.keys("bull:*");
    assert.ok(keys.length);
    assert.ok(keys.every(key => key.startsWith("bull:protractor-export:")), keys.join(","));
  }
  async function schedulerWake() {
    const child = track(fork("tests/helpers/export-worker-scheduler.ts", [], {
      execArgv: ["--require", "./tests/helpers/export-worker-network-guard.cjs",
        "--require", "./tests/helpers/export-worker-preload.cjs", "--import", "tsx"],
      env: { ...cleanEnv, PROTRACTOR_EXPORTS_ENABLED: "1", REDIS_URL: redisUrl,
        EXPORT_FIXTURE_PG_SOCKET: process.env.EXPORT_FIXTURE_PG_SOCKET,
        EXPORT_FIXTURE_DIRECTORY: directory, EXPORT_FIXTURE_SCHEDULER: "1",
        CRON_SECRET: "synthetic-cron" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }));
    children.push(child);
    assert.deepEqual(await child.closed, { code: 0, signal: null }, child.output());
    assert.equal((await collections.health.findOne({ _id: "dispatcher" }))?.after, "synthetic-enterprise");
  }
  const enqueue = () => queue!.add("synthetic", { enterpriseId: "synthetic-enterprise", revision: 1, shopId: 999999 });
  try {
    const installation = await sql.reserve();
    try { await installation.unsafe(readFileSync("scripts/protractor-export-pg/schema.sql", "utf8")); }
    finally { installation.release(); }
    await reset(); await startRedis();
    client = new Redis(redisUrl, { maxRetriesPerRequest: null });
    client.on("error", () => {});
    queue = new Queue("protractor-export", { connection: client as any });
    queue.on("error", () => {});
    await queue.waitUntilReady();

    await t.test("SIGTERM during preflight never registers a consumer or heartbeat", async () => {
      const worker = startWorker("gate");
      await until(() => {
        assert.equal(worker.child.exitCode, null, worker.output());
        return events().includes("preflight");
      });
      worker.child.kill("SIGTERM"); await sleep(150); worker.child.send("release");
      assert.deepEqual(await worker.closed, { code: 0, signal: null }, worker.output());
      assert.equal(events(), "preflight\n");
      assert.equal((await queue!.getWorkers()).length, 0);
      assert.doesNotMatch(worker.output(), /consumer ready/);
    });
    await t.test("hung startup exits at the real 30-second deadline", async () => {
      await reset(); const start = Date.now(), worker = startWorker("hang");
      assert.deepEqual(await worker.closed, { code: 1, signal: null }, worker.output());
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 30000 && elapsed < 35000, `startup ${elapsed}ms: ${worker.output()}`);
      assert.match(worker.output(), /Startup deadline exceeded/);
      assert.equal(events(), "preflight\n");
      t.diagnostic(`startup deadline: ${elapsed}ms`);
    });
    await t.test("SIGTERM drains an in-flight delivery and exits cleanly", async () => {
      await reset(); await pending("graceful"); receiverMode = "hang";
      const worker = startWorker(); await ready(worker);
      const job = await enqueue();
      await until(() => held.length === 1);
      const workers = await queue!.getWorkers();
      assert.equal(workers.length, 1);
      await onlyExportQueue();
      worker.child.kill("SIGTERM"); await sleep(250);
      assert.equal(worker.child.exitCode, null);
      const response = held.pop()!;
      response.writeHead(202, { "x-mos-acknowledgment": "graceful" }); response.end();
      assert.deepEqual(await worker.closed, { code: 0, signal: null }, worker.output());
      assert.equal(await job.getState(), "completed");
      assert.equal((await read("states"))[0].pending, undefined);
      assert.equal((await read("history")).length, 1);
      assert.doesNotMatch(worker.output(), /Drain deadline/);
    });
    await t.test("25-second drain kill leaves a durable job that a new worker recovers", async () => {
      await reset(); await pending("interrupted"); receiverMode = "hang";
      const worker = startWorker(); await ready(worker);
      const job = await enqueue();
      await until(() => held.length === 1);
      const start = Date.now(); worker.child.kill("SIGTERM");
      assert.deepEqual(await worker.closed, { code: 1, signal: null }, worker.output());
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 25000 && elapsed < 30000, `drain ${elapsed}ms`);
      assert.match(worker.output(), /Drain deadline exceeded/);
      assert.equal(await job.getState(), "active");
      assert.equal((await read("states"))[0].pending.deliveryId, "interrupted");
      assert.equal((await read("history")).length, 0);
      held.pop()!.destroy(); receiverMode = "accept";
      // The real engine lease is 120s. Do not shorten it: wait for both lease
      // expiration and BullMQ stalled recovery before another scheduler wake-up.
      const replacement = startWorker(); await ready(replacement);
      await until(async () => await job.getState() === "completed", 70000);
      const state = (await read("states"))[0];
      if (state.pending) {
        await sleep(Math.max(0, state.leaseUntil.getTime() - Date.now()) + 100);
        await schedulerWake();
      }
      await until(async () => !(await read("states"))[0].pending);
      assert.equal((await read("history")).length, 1);
      const attempts = received.filter(x => x.id === "interrupted");
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0], attempts[1]);
      await stop(replacement);
      t.diagnostic(`drain deadline: ${elapsed}ms; identical delivery recovered after real lease expiration`);
    });
    await t.test("Redis restart reconnects the same worker and retains queued work", async () => {
      await reset(); await pending("redis-reconnect"); receiverMode = "accept";
      const worker = startWorker(); await ready(worker);
      await queue!.pause();
      const job = await enqueue();
      redisProcess!.child.kill("SIGTERM"); await redisProcess!.closed;
      await until(() => worker.output().includes("Redis unavailable"));
      assert.equal(worker.child.exitCode, null);
      await startRedis();
      await until(() => client!.status === "ready");
      await queue!.resume();
      await until(async () => await job.getState() === "completed");
      assert.equal((await read("history"))[0]._id, "redis-reconnect");
      await onlyExportQueue(); await stop(worker);
    });
    await t.test("receiver rejection persists retry state across worker restart", async () => {
      await reset(); await pending("durable-retry"); receiverMode = "reject";
      const worker = startWorker(); await ready(worker);
      const job = await enqueue();
      await until(async () => await job.getState() === "completed");
      const state = (await read("states"))[0];
      assert.equal(state.attempts, 1);
      assert.equal(state.failure, "receiver_not_acknowledged");
      assert.equal(state.pending.deliveryId, "durable-retry");
      assert.ok(state.retryAt instanceof Date);
      worker.child.kill("SIGKILL");
      assert.deepEqual(await worker.closed, { code: null, signal: "SIGKILL" });
      assert.deepEqual((await read("states"))[0], state);
      receiverMode = "accept";
      const replacement = startWorker(); await ready(replacement);
      const early = await enqueue();
      await until(async () => await early.getState() === "completed");
      assert.equal(received.filter(x => x.id === "durable-retry").length, 1);
      await sleep(Math.max(0, state.retryAt.getTime() - Date.now()) + 100);
      await schedulerWake(); await until(async () => !(await read("states"))[0].pending);
      assert.equal((await read("history")).length, 1);
      assert.equal((await read("states"))[0].attempts, 0);
      const attempts = received.filter(x => x.id === "durable-retry");
      assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
      await onlyExportQueue(); await stop(replacement);
    });
    for (const point of ["before-send", "before-acceptance", "after-acceptance",
      "after-hash", "after-receipt", "after-checkpoint"]) {
      await t.test(`SIGKILL ${point}: PG commit boundary survives and scheduler finishes`, async () => {
        await reset(); await pending(point); receiverMode = "accept";
        const initial = (await read("states"))[0], original = initial.pending;
        const worker = startWorker("", point); await ready(worker);
        const job = await enqueue();
        await until(() => {
          assert.equal(worker.child.exitCode, null, worker.output());
          return events().split("\n").includes(point);
        });
        worker.child.kill("SIGKILL");
        assert.deepEqual(await worker.closed, { code: null, signal: "SIGKILL" });
        const persisted = (await read("states"))[0];
        assert.ok(persisted.leaseUntil instanceof Date);
        const accepted = !["before-send", "before-acceptance"].includes(point);
        const finished = point === "after-checkpoint";
        assert.equal(received.filter(x => x.id === point).length, point === "before-send" ? 0 : 1);
        if (!finished) {
          assert.equal(persisted.pending.body, original.body);
          assert.equal(persisted.pending.deliveryId, original.deliveryId);
          assert.equal(!!persisted.pending.acceptedAt, accepted);
        } else assert.equal(persisted.pending, undefined);
        assert.equal((await read("hashes")).length,
          ["after-hash", "after-receipt", "after-checkpoint"].includes(point) ? 1 : 0);
        assert.equal((await read("history")).length,
          ["after-receipt", "after-checkpoint"].includes(point) ? 1 : 0);

        const replacement = startWorker(); await ready(replacement);
        await until(async () => await job.getState() === "completed", 70000);
        // BullMQ recovery alone must not defeat the still-live 120-second PG lease.
        assert.ok(persisted.leaseUntil.getTime() > Date.now());
        assert.deepEqual((await read("states"))[0], persisted);
        await sleep(Math.max(0, persisted.leaseUntil.getTime() - Date.now()) + 100);
        await schedulerWake();
        await until(async () => {
          const state = (await read("states"))[0];
          return !state.pending && !state.lease;
        });
        const state = (await read("states"))[0], receipts = await read("history");
        assert.equal(state.attempts, 0);
        assert.equal(state.baselineDone, true);
        assert.equal(state.completedWindow, initial.window);
        assert.equal(state.after, "synthetic-record");
        assert.equal(state.failure, undefined);
        assert.equal(state.retryAt, undefined);
        assert.equal(receipts.length, 1);
        assert.equal(receipts[0]._id, original.deliveryId);
        assert.ok(receipts[0].acceptedAt instanceof Date);
        assert.equal(receipts[0].recordCount, 1);
        assert.equal((await read("hashes"))[0].hash, "synthetic-hash");
        const attempts = received.filter(x => x.id === point);
        assert.equal(attempts.length, point === "before-acceptance" ? 2 : 1);
        for (const attempt of attempts)
          assert.deepEqual(attempt, { id: original.deliveryId, body: original.body });
        await schedulerWake();
        await until(async () => await queue!.getActiveCount() === 0 && await queue!.getWaitingCount() === 0);
        assert.equal((await read("history")).length, 1);
        assert.equal(received.filter(x => x.id === point).length, attempts.length);
        await onlyExportQueue(); await stop(replacement);
      });
    }
  } finally {
    // Disconnect clients first: queue.close() otherwise waits indefinitely for
    // reconnect when a failing test has already killed the Redis process.
    await queue?.disconnect(); client?.disconnect();
    for (const child of children)
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
    await Promise.allSettled(children.map(child => child.closed));
    await sql.end({ timeout: 2 });
    for (const response of held) response.destroy();
    receiver.closeAllConnections();
    await new Promise<void>(resolve => receiver.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
