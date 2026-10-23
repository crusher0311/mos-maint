import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { exportOnlyLifecycle, validateExportWorkerEnvironment } from "../workers/export-only-lifecycle";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
function fixture() {
  const events: string[] = [];
  let tick!: () => void;
  const consumer = {
    waitUntilReady: async () => { events.push("ready"); },
    isRunning: () => true,
    client: Promise.resolve({ status: "ready" }),
    close: async () => { events.push("close"); },
  };
  const deps = {
    preflight: async () => { events.push("preflight"); },
    createConsumer: (queue: "protractor-export", concurrency: 1) => {
      events.push(`${queue}:${concurrency}`); return consumer;
    },
    heartbeat: async () => { events.push("heartbeat"); },
    disconnect: async () => { events.push("disconnect"); },
    schedule: (callback: () => void) => { tick = callback; events.push("timer"); return 1; },
    unschedule: () => { events.push("clear"); },
    warn: () => { events.push("warning"); },
  };
  return { events, deps, consumer, tick: () => tick() };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("configuration fails closed; disabled mode requires no credentials", () => {
  assert.equal(validateExportWorkerEnvironment({}), false);
  const env = { PROTRACTOR_EXPORTS_ENABLED: "1", REDIS_URL: "redis://synthetic",
    MONGODB_URI: "mongodb://synthetic", DATABASE_URL: "postgres://synthetic",
    PROTRACTOR_EXPORT_ENCRYPTION_KEY: "a".repeat(64) };
  assert.equal(validateExportWorkerEnvironment(env), true);
  for (const key of ["REDIS_URL", "MONGODB_URI", "PROTRACTOR_EXPORT_ENCRYPTION_KEY", "DATABASE_URL"])
    assert.throws(() => validateExportWorkerEnvironment({ ...env, [key]: "" }));
  assert.equal(validateExportWorkerEnvironment({ ...env, IDENTITY_PG_CANONICAL: "1",
    DATABASE_URL: "postgres://synthetic" }), true);
});
test("only export queue starts at concurrency one; heartbeat follows readiness; stop is idempotent", async () => {
  const f = fixture(), worker = exportOnlyLifecycle(f.deps);
  await worker.start();
  assert.deepEqual(f.events, ["preflight", "protractor-export:1", "ready", "heartbeat", "timer"]);
  await worker.stop(); await worker.stop(); f.tick(); await flush();
  assert.deepEqual(f.events.slice(5), ["clear", "close", "disconnect"]);
});
test("shutdown during preflight cannot start any queue", async () => {
  const f = fixture(), gate = deferred();
  f.deps.preflight = () => gate.promise;
  const worker = exportOnlyLifecycle(f.deps), start = worker.start(), stop = worker.stop();
  gate.resolve(); await start; await stop;
  assert.deepEqual(f.events, ["disconnect"]);
});
test("no heartbeat before readiness or after shutdown during readiness", async () => {
  const f = fixture(), gate = deferred();
  f.consumer.waitUntilReady = () => gate.promise;
  const worker = exportOnlyLifecycle(f.deps), start = worker.start();
  await flush();
  assert.ok(!f.events.includes("heartbeat"));
  const stop = worker.stop(); gate.resolve(); await start; await stop;
  assert.ok(!f.events.includes("heartbeat"));
  assert.ok(f.events.includes("close"));
});
test("heartbeat is serialized, skipped while disconnected, and drained on shutdown", async () => {
  const f = fixture(), worker = exportOnlyLifecycle(f.deps);
  await worker.start();
  f.consumer.client = Promise.resolve({ status: "reconnecting" });
  f.tick(); await flush();
  assert.equal(f.events.filter(x => x === "heartbeat").length, 1);
  f.consumer.client = Promise.resolve({ status: "ready" });
  const gate = deferred(); let calls = 0;
  f.deps.heartbeat = async () => { calls++; await gate.promise; };
  f.tick(); f.tick(); await flush(); assert.equal(calls, 1);
  let stopped = false; const stop = worker.stop().then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false);
  gate.resolve(); await stop; assert.equal(stopped, true);
});
test("preflight failure starts nothing and cleanup still runs", async () => {
  const f = fixture();
  f.deps.preflight = async () => { throw Error("private failure"); };
  const worker = exportOnlyLifecycle(f.deps);
  await assert.rejects(worker.start());
  await worker.stop();
  assert.deepEqual(f.events, ["disconnect"]);
});
test("Redis readiness failure closes consumer without advertising heartbeat", async () => {
  const f = fixture();
  f.consumer.waitUntilReady = async () => { throw Error("private"); };
  const worker = exportOnlyLifecycle(f.deps);
  await assert.rejects(worker.start());
  await worker.stop();
  assert.deepEqual(f.events, ["preflight", "protractor-export:1", "close", "disconnect"]);
});
test("heartbeat errors are contained and future ticks retry", async () => {
  const f = fixture();
  f.deps.heartbeat = async () => { throw Error("private"); };
  const worker = exportOnlyLifecycle(f.deps);
  await worker.start(); f.tick(); await flush();
  assert.equal(f.events.filter(x => x === "warning").length, 2);
  await worker.stop();
});
test("disabled CLI exits without loading DB or backfill workers; invalid enabled CLI fails", () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH,
    NODE_OPTIONS: "--require ./tests/helpers/deny-network-egress.cjs" };
  for (const enabled of ["0", "1"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "workers/export-only.ts"], {
      env: { ...env, PROTRACTOR_EXPORTS_ENABLED: enabled }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, enabled === "0" ? 0 : 1, result.stderr);
    assert.doesNotMatch(result.stderr, /Network egress denied/);
  }
  const entry = readFileSync("workers/export-only.ts", "utf8");
  const imports = [...entry.matchAll(/(?:from\s+|import\()["']([^"']+)/g)].map(m => m[1]);
  assert.deepEqual(imports, ["./export-only-lifecycle", "bullmq", "ioredis",
    "../lib/protractor-exports/store", "./processors/protractor-export"]);
});
