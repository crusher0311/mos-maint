import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { MongoClient, ObjectId } from "mongodb";
import { emptyTireResult, validateTireDefinition } from "../lib/tire-dot-report";

async function load(path: string, db: unknown, sql?: (text: string, params?: any[]) => Promise<any[]>) {
  const bundle = await build({
    entryPoints: [path], bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{ name: "offline-storage", setup(b) {
      b.onResolve({ filter: /^@\/lib\/(data\/db|db\/drizzle|db\/integration-cache-write-mode)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents:
        args.path.endsWith("data/db") ? "export const getDb=async()=>globalThis.fixtureDb;"
        : args.path.endsWith("drizzle") ? "export const getClient=()=>({begin: async f=>f({unsafe:globalThis.fixtureSql})});"
        : `export const isTekmetricCachePgCanonical=()=>${Boolean(sql)};` }));
    } }],
  });
  const mod = { exports: {} as any };
  runInNewContext(bundle.outputFiles[0].text, { module: mod, exports: mod.exports, require: createRequire(import.meta.url), Buffer, process,
    fixtureDb: db, fixtureSql: sql });
  return mod.exports;
}

test("real disposable Mongo indexes, canonical keyset, deduplication and fenced checkpoint publication", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tire-dot-mongo-"));
  // No environment credentials and no bind beyond loopback.
  const server = spawn("mongod", ["--dbpath", directory, "--bind_ip", "127.0.0.1", "--port", "27929", "--quiet"], {
    env: { PATH: process.env.PATH, HOME: directory, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; server.stdout.on("data", c => output += c); server.stderr.on("data", c => output += c);
  const client = new MongoClient("mongodb://127.0.0.1:27929/tire_dot_fixture", { serverSelectionTimeoutMS: 500 });
  try {
    for (let i = 0; ; i++) {
      try { await client.connect(); break; }
      catch (e) { if (i >= 30 || server.exitCode !== null) throw new Error(`Disposable Mongo failed to start: ${output.slice(-1500)}`); await new Promise(r => setTimeout(r, 200)); }
    }
    const db = client.db();
    await db.collection("tekmetric_work_orders").createIndex({ shopId: 1, _id: 1 }, { name: "tire_dot_shop_id" });
    await db.collection("tire_dot_report_runs").createIndex({ activeKey: 1 }, { unique: true, sparse: true });
    await db.collection("tire_dot_report_runs").createIndex({ requestKey: 1, status: 1, heartbeatAt: -1 });
    await db.collection("tire_dot_report_runs").createIndex({ status: 1, queuedAt: 1, heartbeatAt: 1 });
    const source = db.collection("tekmetric_work_orders");
    await source.insertMany(Array.from({ length: 28 }, (_, i) => ({
      _id: new ObjectId(), shopId: i % 2 ? 311 : "311", workOrderId: String(i), data: { id: i, jobs: [] },
    })));
    await source.insertOne({ shopId: 99, workOrderId: "foreign", data: { id: 99 } });
    const reader = await load("lib/data/repositories/tire-dot-source.ts", db);
    const first = await reader.readTireSourcePage(311, null, "mongo");
    assert.equal(first.length, 25);
    const second = await reader.readTireSourcePage(311, first.at(-1).key, "mongo");
    assert.equal(second.length, 3);
    assert.equal(new Set([...first, ...second].map(r => r.key)).size, 28);
    assert.ok([...first, ...second].every(r => Number(r.doc.shopId) === 311));
    await source.insertOne({ shopId: 33, workOrderId: "status-only", status: "Void", deletedAt: "2024-08-15",
      data: { id: "status-only", repairOrderStatus: "Posted", postedDate: "2024-08-14" } });
    const updated = await reader.readTireSourcePage(33, null, "mongo");
    assert.equal(updated[0].doc.status, "Void");
    assert.equal(updated[0].doc.deletedAt, "2024-08-15");
    assert.equal(updated[0].doc.data.repairOrderStatus, "Posted");
    await assert.rejects(reader.readTireSourcePage(311, null, "pg"), /changed/);
    await source.insertOne({ shopId: 32, workOrderId: "large", data: { name: "x".repeat(1_100_000) } });
    await assert.rejects(reader.readTireSourcePage(32, null, "mongo"), /size/);

    const repo = await load("lib/data/repositories/tire-dot-report-runs.ts", db);
    const definition = validateTireDefinition({ dateRange: { start: "2024-08-14", end: "2024-08-14" }, locationIds: [311] });
    const input = { requestedBy: "fixture@example.test", definition, scope: { kind: "shop", shopId: 311 }, sourceMode: "mongo",
      partial: emptyTireResult(definition, [{ shopId: 311, name: "Fixture" }]) };
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => repo.createTireRun(input)));
    assert.equal(new Set(concurrent.map(r => r._id)).size, 1);
    const old = await repo.claimTireRun();
    assert.equal(await repo.claimTireRun(), null);
    await db.collection("tire_dot_report_runs").updateOne({ _id: old._id }, { $set: { heartbeatAt: new Date(0) } });
    const recovered = await repo.claimTireRun();
    assert.notEqual(recovered.lease, old.lease);
    assert.equal((await repo.saveTireRun(old, true)).modifiedCount, 0, "stale worker cannot publish");
    recovered.cursor = "durable-cursor";
    await repo.saveTireRun(recovered, false);
    const resumed = await repo.claimTireRun(); assert.equal(resumed.cursor, "durable-cursor");
    await repo.saveTireRun(resumed, true);
    const cached = await repo.createTireRun(input);
    assert.equal(cached._id, resumed._id); assert.equal(cached.status, "succeeded");
    const fresh = await repo.createTireRun(input, true);
    assert.notEqual(fresh._id, cached._id, "refresh has immutable new generation");
    assert.equal((await repo.findTireRun(cached._id)).status, "succeeded", "old download remains pinned");
  } finally {
    await client.close(); server.kill("SIGTERM");
    if (server.exitCode === null) await new Promise(resolve => server.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("PG source selects only the pinned shop using primary-key pagination and query deadline", async () => {
  const calls: any[] = [];
  const reader = await load("lib/data/repositories/tire-dot-source.ts", null, async (text, params) => {
    calls.push({ text, params });
    return text.startsWith("SELECT") ? [{ key: "102", payload: { data: { id: "102" } }, bytes: 100 }] : [];
  });
  const page = await reader.readTireSourcePage(311, "101", "pg");
  assert.match(calls[0].text, /statement_timeout='2000ms'/);
  assert.match(calls[1].text, /WHERE shop_id=\$1/);
  assert.match(calls[1].text, /work_order_id > \$2/);
  assert.deepEqual(Array.from(calls[1].params), [311, "101", 25]);
  assert.equal(page[0].doc.shopId, 311); assert.equal(page[0].doc.workOrderId, "102");
});
