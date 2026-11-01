const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { MongoClient } = require("mongodb");
const { mongoIndexes, postgresStatements } = require("../scripts/reporting-index-package.cjs");

test("package is narrow and never silently skips an invalid same-name index", () => {
  assert.equal(postgresStatements.length, 3);
  for (const sql of postgresStatements) {
    assert.match(sql, /^CREATE INDEX CONCURRENTLY /);
    assert.doesNotMatch(sql, /IF NOT EXISTS|DROP|recommendation_events/);
  }
  assert.equal(mongoIndexes.length, 3);
});

test("real disposable Mongo indexes preserve queue results and avoid collection scans", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "report-index-test-"));
  // OS assigns a free port; no application credentials or shared stores.
  const net = require("node:net");
  const port = await new Promise(resolve => {
    const s = net.createServer(); s.listen(0, "127.0.0.1", () => {
      const p = s.address().port; s.close(() => resolve(p));
    });
  });
  const proc = spawn("mongod", ["--dbpath", dir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.on("data", data => { logs = (logs + data).slice(-6000); });
  }
  const exited = new Promise(resolve => proc.once("exit", resolve));
  const client = new MongoClient(`mongodb://127.0.0.1:${port}`, { maxPoolSize: 1, serverSelectionTimeoutMS: 10000 });
  try {
    try { await client.connect(); }
    catch (error) { console.error(logs); throw error; }
    const col = client.db("disposable_reporting").collection("report_runs");
    const now = new Date("2026-11-01T12:00:00Z");
    await col.insertMany(Array.from({ length: 12000 }, (_, i) => ({
      _id: String(i), status: i < 10 ? "queued" : i < 20 ? "running" : "succeeded",
      attempts: i === 0 ? 3 : 0, queuedAt: new Date(now - (12000-i)*1000),
      heartbeatAt: new Date(now - 1200000), refreshEnabled: i % 2 === 0,
      lastViewedAt: new Date(now - i*1000), generatedAt: new Date(now - 3600000),
    })));
    const queries = [
      { filter: { attempts: { $lt: 3 }, $or: [
        { status: "queued", queuedAt: { $lte: now } },
        { status: "running", heartbeatAt: { $lt: new Date(now - 600000) } },
      ] }, sort: { queuedAt: 1 }, limit: 1 },
      { filter: { status: "succeeded", refreshEnabled: true,
        lastViewedAt: { $gte: new Date(now - 30*86400000) },
        generatedAt: { $lt: new Date(now - 900000) } }, sort: { lastViewedAt: -1 }, limit: 10 },
    ];
    const results = [];
    for (const q of queries) results.push(await col.find(q.filter).sort(q.sort).limit(q.limit).toArray());
    for (const { key, name } of mongoIndexes) await col.createIndex(key, { name });
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      assert.deepEqual(await col.find(q.filter).sort(q.sort).limit(q.limit).toArray(), results[i]);
      const plan = await col.find(q.filter).sort(q.sort).limit(q.limit).explain("executionStats");
      assert.doesNotMatch(JSON.stringify(plan.queryPlanner.winningPlan), /COLLSCAN/);
      assert.ok(plan.executionStats.totalDocsExamined < 100, "bounded fixture work");
      console.log(JSON.stringify({ query: i, docsExamined: plan.executionStats.totalDocsExamined,
        keysExamined: plan.executionStats.totalKeysExamined }));
    }
  } finally {
    await client.close();
    proc.kill("SIGTERM");
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});
