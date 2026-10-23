import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { collections, maintainExportRetention } from "../lib/data/repositories/protractor-exports";
import { checkPgExportSchema } from "../lib/protractor-exports/pg-store";
import { processShop, engineDependencies } from "../lib/protractor-exports/engine";
import { retryExportState } from "../lib/protractor-exports/retry";
import type { ExportConfig } from "../lib/protractor-exports/contract";

const socket = process.argv[2];
assert.match(socket, /^\/tmp\/export-pg\./);
const sql = postgres({ host: socket, database: "postgres", max: 4, onnotice: () => {},
  connect_timeout: 2, connection: { statement_timeout: 5000, lock_timeout: 1000 } });
const schema = readFileSync("scripts/protractor-export-pg/schema.sql", "utf8");
async function install() {
  const connection = await sql.reserve();
  try { await connection.unsafe(schema); } finally { connection.release(); }
}
async function main() {
  await assert.rejects(checkPgExportSchema(sql));
  await install();
  await install();
  await checkPgExportSchema(sql);
  await sql.unsafe("DROP INDEX protractor_export.export_active");
  await sql.unsafe("CREATE INDEX export_active ON protractor_export.configs(id)");
  await assert.rejects(checkPgExportSchema(sql), /operator setup/);
  await sql.unsafe("DROP INDEX protractor_export.export_active");
  await install();
  await checkPgExportSchema(sql);
  console.log("PASS PG schema: idempotent install, strict incompatible-index rejection");

  const c = await collections(sql);
  const config: ExportConfig = { _id: "synthetic-enterprise", revision: 1,
    destination: "https://receiver.example.test/inbox", shopIds: [999999], timeZone: "UTC",
    dailyTime: "00:00", initialSnapshot: true, paused: false, revoked: false,
    confirmedAt: new Date().toISOString(), approvedBy: "synthetic", secret: "encrypted-fixture" };
  await c.configs.insertOne(config);
  await assert.rejects(c.configs.insertOne(config));
  const writes = await Promise.all([2, 3].map(revision =>
    c.configs.replaceOne({ _id: config._id, revision: 1 }, { ...config, revision })));
  assert.equal(writes.filter(r => r.matchedCount === 1).length, 1);
  await c.configs.replaceOne({ _id: config._id }, config);
  assert.equal((await c.configs.find({ paused: false, revoked: false, _id: { $gt: "" } })
    .sort({ _id: 1 }).limit(1).next())?._id, config._id);
  console.log("PASS PG configuration revision CAS and scheduler query");

  const id = `${config._id}_1_999999`;
  await c.states.updateOne({ _id: id }, { $setOnInsert: {
    enterpriseId: config._id, revision: 1, shopId: 999999, entity: "work_order",
    after: "", baselineDone: false, attempts: 0,
    coverage: { scanned: 0, missing: 0, oversized: 0, mode: "not_collected" },
  } }, { upsert: true });
  const claims = await Promise.all(["a", "b"].map(lease =>
    c.states.findOneAndUpdate({ _id: id, $or: [{ leaseUntil: { $exists: false } },
      { leaseUntil: { $lt: new Date() } }] }, { $set: { lease, leaseUntil: new Date(Date.now() + 10000) } },
    { returnDocument: "after" })));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.ok(claims.find(Boolean)!.leaseUntil instanceof Date);
  const winner = claims.find(Boolean)!.lease!;
  assert.equal((await c.states.updateOne({ _id: id, lease: winner === "a" ? "b" : "a" },
    { $set: { after: "wrong" } })).matchedCount, 0);
  await c.states.updateOne({ _id: id, lease: winner }, { $unset: { lease: "", leaseUntil: "" } });
  console.log("PASS PG concurrent lease admission, Date roundtrip and stale fence rejection");

  let now = new Date("2026-10-23T12:00:00Z"), fail = true;
  const sent: { id: string; body: string }[] = [];
  const deps: typeof engineDependencies = {
    ...engineDependencies, collections: async () => c,
    config: async key => c.configs.findOne({ _id: key }),
    enabled: () => true, authorize: async () => ({ shopId: 999999, name: "Synthetic" }),
    now: () => now, secret: () => "synthetic",
    source: async (_shop, entity, after) => entity === "work_order" && !after ?
      { ids: ["fictional"], snapshots: [{ shopId: 999999, entityType: "work_order",
        providerId: "fictional", observedAt: now.toISOString(), source: "synthetic",
        payload: { ID: "fictional", Total: 123 } }], missing: 0 } :
      { ids: [], snapshots: [], missing: 0 },
    send: async (_url, _secret, deliveryId, body) => {
      sent.push({ id: deliveryId, body });
      if (fail) throw Error("receiver_not_acknowledged");
    },
  };
  await processShop(config, 999999, deps); // Persist immutable pending.
  const pending = (await c.states.findOne({ _id: id }))!.pending!;
  assert.ok(pending.deliveryId && pending.body.includes("fictional"));
  const projected = await c.states.find({ enterpriseId: config._id, revision: 1 },
    { projection: { shopId: 1, "pending.deliveryId": 1 } }).limit(50).toArray();
  assert.equal(projected[0].pending?.deliveryId, pending.deliveryId);
  assert.ok(!JSON.stringify(projected).includes("encrypted-fixture"));
  assert.ok(!JSON.stringify(projected).includes('"body"'));
  const status = await c.states.findOne({ _id: id }, { projection: { pending: 0, lease: 0 } });
  assert.equal(status?.pending, undefined);
  await processShop(config, 999999, deps); // Receiver fails; pending retained.
  assert.ok((await c.states.findOne({ _id: id }))!.retryAt instanceof Date);
  const second = await collections(sql); // Reconstruct repository, no in-memory state.
  now = new Date(now.getTime() + 31000); fail = false;
  await processShop(config, 999999, { ...deps, collections: async () => second });
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]);
  assert.equal((await c.states.findOne({ _id: id }))?.pending, undefined);
  assert.equal((await c.history.find({ enterpriseId: config._id }).limit(100).toArray()).length, 1);
  assert.ok((await c.history.findOne({ _id: pending.deliveryId }))!.acceptedAt instanceof Date);
  for (let i = 0; i < 4; i++) await processShop(config, 999999, deps);
  assert.ok((await c.states.findOne({ _id: id }))?.baselineDone);
  console.log("PASS real PG engine: immutable delivery retry, history, terminal completion and safe projections");

  await c.states.updateOne({ _id: id }, { $set: { attempts: 8, failure: "collection_unavailable" } });
  assert.equal(await retryExportState(c.states, id), true);
  assert.equal((await c.states.findOne({ _id: id }))?.attempts, 0);
  const old = new Date(Date.now() - 100 * 86400_000);
  await c.history.insertOne({ _id: "expired", enterpriseId: config._id, revision: 1, shopId: 999999,
    window: "synthetic", acceptedAt: old, recordCount: 0 });
  await c.states.updateOne({ _id: id }, { $set: { pending: { ...pending, createdAt: old.toISOString() } } });
  await maintainExportRetention(sql);
  assert.equal(await c.history.findOne({ _id: "expired" }), null);
  assert.equal((await c.states.findOne({ _id: id }))?.failure, "payload_retention_expired");
  assert.equal((await c.states.findOne({ _id: id }))?.pending, undefined);
  assert.equal(await retryExportState(c.states, id), false);
  await c.configs.updateOne({ _id: config._id, revision: 1 }, { $set: { paused: true, revoked: true, secret: "" } });
  await c.states.updateMany({ enterpriseId: config._id, revision: { $ne: 2 } },
    { $unset: { pending: "" }, $set: { failure: "authorization_revoked" } });
  assert.equal((await c.configs.findOne({ _id: config._id }))?.secret, "");
  console.log("PASS PG manual retry, bounded retention, revoke and cleanup");
}
main().finally(() => sql.end({ timeout: 2 })).catch(e => { console.error(e); process.exitCode = 1; });
