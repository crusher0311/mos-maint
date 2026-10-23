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

test("export-only entry point: real Redis, real signals, durable synthetic delivery", { timeout: 260000 }, async t => {
  // Fail closed when invoked directly without the sanitized wrapper/preload.
  assert.throws(() => net.connect({ host: "192.0.2.1", port: 443 }), /external network denied/);
  assert.throws(() => new net.Socket().connect({ host: "example.com", port: 443 }), /external network denied/);
  assert.equal(process.env.MONGODB_PASSWORD, undefined);
  assert.equal(process.env.REDIS_URL, undefined);
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
  const read = (name: string) => JSON.parse(readFileSync(join(directory, `${name}.json`), "utf8"));
  const write = (name: string, data: unknown) => writeFileSync(join(directory, `${name}.json`), JSON.stringify(data));
  const events = () => readFileSync(join(directory, "events"), "utf8");
  function reset() {
    writeFileSync(join(directory, "events"), "");
    for (const name of ["states", "hashes", "history", "health"]) write(name, []);
    write("config", { _id: "synthetic-enterprise", revision: 1, shopIds: [999999],
      paused: false, revoked: false, destination: "synthetic-only", secret: "synthetic-only" });
  }
  function pending(id: string) {
    write("states", [{ _id: "synthetic-state", enterpriseId: "synthetic-enterprise",
      revision: 1, shopId: 999999, attempts: 0, window: "2026-10-23",
      pending: { deliveryId: id, body: JSON.stringify({ synthetic: true, deliveryId: id }),
        createdAt: new Date().toISOString(), hashes: [], after: "synthetic-record",
        entity: "invoice", final: true, recordCount: 1 } }]);
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
  function startWorker(preflight = "") {
    const worker = track(fork("workers/export-only.ts", [], {
      execArgv: ["--require", "./tests/helpers/export-worker-network-guard.cjs",
        "--require", "./tests/helpers/export-worker-preload.cjs", "--import", "tsx"],
      env: { ...cleanEnv, PROTRACTOR_EXPORTS_ENABLED: "1", REDIS_URL: redisUrl,
        MONGODB_URI: "mongodb://127.0.0.1/synthetic-unused", PROTRACTOR_EXPORT_ENCRYPTION_KEY: "a".repeat(64),
        DATABASE_URL: "postgres://synthetic-unused",
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
  const enqueue = () => queue!.add("synthetic", { enterpriseId: "synthetic-enterprise", revision: 1, shopId: 999999 });
  try {
    reset(); await startRedis();
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
      reset(); const start = Date.now(), worker = startWorker("hang");
      assert.deepEqual(await worker.closed, { code: 1, signal: null }, worker.output());
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 30000 && elapsed < 35000, `startup ${elapsed}ms: ${worker.output()}`);
      assert.match(worker.output(), /Startup deadline exceeded/);
      assert.equal(events(), "preflight\n");
      t.diagnostic(`startup deadline: ${elapsed}ms`);
    });
    await t.test("SIGTERM drains an in-flight delivery and exits cleanly", async () => {
      reset(); pending("graceful"); receiverMode = "hang";
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
      assert.equal(read("states")[0].pending, undefined);
      assert.equal(read("history").length, 1);
      assert.doesNotMatch(worker.output(), /Drain deadline/);
    });
    await t.test("25-second drain kill leaves a durable job that a new worker recovers", async () => {
      reset(); pending("interrupted"); receiverMode = "hang";
      const worker = startWorker(); await ready(worker);
      const job = await enqueue();
      await until(() => held.length === 1);
      const start = Date.now(); worker.child.kill("SIGTERM");
      assert.deepEqual(await worker.closed, { code: 1, signal: null }, worker.output());
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 25000 && elapsed < 30000, `drain ${elapsed}ms`);
      assert.match(worker.output(), /Drain deadline exceeded/);
      assert.equal(await job.getState(), "active");
      assert.equal(read("states")[0].pending.deliveryId, "interrupted");
      assert.equal(read("history").length, 0);
      held.pop()!.destroy(); receiverMode = "accept";
      // The real engine lease is 120s. Do not shorten it: wait for both lease
      // expiration and BullMQ stalled recovery before another scheduler wake-up.
      const replacement = startWorker(); await ready(replacement);
      await until(async () => await job.getState() === "completed", 70000);
      const state = read("states")[0];
      if (state.pending) {
        await sleep(Math.max(0, Date.parse(state.leaseUntil) - Date.now()) + 100);
        await enqueue();
      }
      await until(() => read("history").length === 1);
      assert.equal(read("states")[0].pending, undefined);
      const attempts = received.filter(x => x.id === "interrupted");
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0], attempts[1]);
      await stop(replacement);
      t.diagnostic(`drain deadline: ${elapsed}ms; identical delivery recovered after real lease expiration`);
    });
    await t.test("Redis restart reconnects the same worker and retains queued work", async () => {
      reset(); pending("redis-reconnect"); receiverMode = "accept";
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
      assert.equal(read("history")[0]._id, "redis-reconnect");
      await onlyExportQueue(); await stop(worker);
    });
    await t.test("receiver rejection persists retry state across worker restart", async () => {
      reset(); pending("durable-retry"); receiverMode = "reject";
      const worker = startWorker(); await ready(worker);
      const job = await enqueue();
      await until(async () => await job.getState() === "completed");
      const state = read("states")[0];
      assert.equal(state.attempts, 1);
      assert.equal(state.failure, "receiver_not_acknowledged");
      assert.equal(state.pending.deliveryId, "durable-retry");
      await stop(worker);
      receiverMode = "accept";
      const replacement = startWorker(); await ready(replacement);
      const early = await enqueue();
      await until(async () => await early.getState() === "completed");
      assert.equal(received.filter(x => x.id === "durable-retry").length, 1);
      await sleep(Math.max(0, Date.parse(state.retryAt) - Date.now()) + 100);
      await enqueue(); await until(() => read("history").length === 1);
      assert.equal(read("states")[0].pending, undefined);
      assert.equal(read("states")[0].attempts, 0);
      const attempts = received.filter(x => x.id === "durable-retry");
      assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
      await onlyExportQueue(); await stop(replacement);
    });
  } finally {
    // Disconnect clients first: queue.close() otherwise waits indefinitely for
    // reconnect when a failing test has already killed the Redis process.
    await queue?.disconnect(); client?.disconnect();
    for (const child of children)
      if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
    await Promise.allSettled(children.map(child => child.closed));
    for (const response of held) response.destroy();
    receiver.closeAllConnections();
    await new Promise<void>(resolve => receiver.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
