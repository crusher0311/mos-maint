import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LocalDualMetadataStore } from "../scripts/invoice-metadata-dual-store";
import { InvoiceFence } from "../lib/invoice-repair/fence";
import { guardMongoClient, guardPostgres } from "../lib/invoice-repair/guarded-drivers";
import { testHoldRegistry } from "./invoice-hold-registry.test";
import { testNativeProtocol } from "./invoice-native-dual-store.test";
import { MongoClient as FencedMongoClient } from "../lib/invoice-repair/mongo-client";
import fencedPostgres from "../lib/invoice-repair/postgres-client";
import { userInfo } from "node:os";

const store = new LocalDualMetadataStore(process.env.INVOICE_DUAL_SOCKET!,
  Number(process.env.INVOICE_DUAL_PORT), process.env.INVOICE_DUAL_MARKER!,
  process.env.INVOICE_DUAL_PORTS?.split(",").map(Number));
async function main() {
  await store.mongo.connect();
  await store.sql.begin(tx => store.guard(tx));
  await store.sql.begin(tx => tx.unsafe(readFileSync("docs/reporting/invoice-repair-control-schema.sql", "utf8")
    .replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "")));
  await store.db.collection("invoice_repair_installation").insertOne({
    _id: "coordinator" as any, protocol: 1,
    installationKey: (await store.sql`SELECT installation_key FROM invoice_repair_installation WHERE id=1`)[0].installation_key,
  });
  const fence = new InvoiceFence(store.sql);
  process.env.PGHOST = process.env.INVOICE_DUAL_SOCKET!;
  process.env.PGUSER = userInfo().username;
  process.env.DATABASE_URL = "postgresql:///postgres";
  const factoryMongo = new FencedMongoClient(process.env.INVOICE_DUAL_PORTS
    ? `mongodb://${process.env.INVOICE_DUAL_PORTS.split(",").map(p => `127.0.0.1:${p}`).join(",")}/?replicaSet=invoice_disposable`
    : `mongodb://127.0.0.1:${process.env.INVOICE_DUAL_PORT}/?directConnection=true`);
  await factoryMongo.connect();
  const factoryPg = fencedPostgres(process.env.DATABASE_URL, { max: 2 });
  const factoryCol = factoryMongo.db("invoice_dual_disposable").collection("fence_test");
  const pg = guardPostgres(store.sql, fence);
  const mongo = guardMongoClient(store.mongo, fence);
  const col = mongo.db("invoice_dual_disposable").collection("fence_test");
  await col.insertOne({ key: "before" });
  assert.equal((await factoryCol.findOne({}))!.key, "before");
  assert.equal((await factoryPg`SELECT 3 value`)[0].value, 3);
  const cursor = col.find({}).batchSize(1);
  assert.equal((await pg`SELECT 1 value`)[0].value, 1);
  assert.equal((await pg.begin(tx => tx.unsafe("SELECT 2 value")) as any)[0].value, 2);
  await store.sql`UPDATE invoice_repair_fence SET operation='unresolved' WHERE id=1`;
  for (const call of [
    () => pg`SELECT 1`,
    () => pg.unsafe("SELECT 1").execute(),
    () => pg.begin(tx => tx.unsafe("SELECT 1")),
    () => col.findOne({}),
    () => col.updateOne({}, { $set: { key: "bad" } }),
    () => col.aggregate([{ $match: {} }]).toArray(),
    () => cursor.next(),
    () => mongo.db("invoice_dual_disposable").command({ count: "fence_test" }),
    () => factoryCol.findOne({}),
    () => factoryCol.insertOne({ key: "must-not-write" }),
    () => factoryPg.unsafe("SELECT * FROM normalized_work_orders"),
    () => factoryMongo.db("invoice_dual_disposable").collection("normalized_work_orders").countDocuments({ shopId: 9100 }),
  ]) await assert.rejects(async () => { await call(); }, /unavailable/);
  // Reopen clients: no in-memory flag or expired lease can clear the fence.
  assert.equal((await store.db.collection("fence_test").findOne({}))!.key, "before");
  await store.sql`UPDATE invoice_repair_fence SET operation=null WHERE id=1`;
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const paused = fence.run(async () => {
    entered(); await new Promise<void>(r => { release = r; });
    await col.findOne({});
  });
  await ready;
  assert.equal(Number((await store.sql`SELECT count(*) n FROM invoice_repair_access`)[0].n), 1);
  release(); await paused;
  assert.equal(Number((await store.sql`SELECT count(*) n FROM invoice_repair_access`)[0].n), 0);
  await assert.rejects(fence.run(async () => { throw Error("lost response"); }), /lost response/);
  assert.equal(Number((await store.sql`SELECT count(*) n FROM invoice_repair_access`)[0].n), 1,
    "Ambiguous normal access must prevent later repair admission");
  await testHoldRegistry(store.sql);
  await testNativeProtocol(store.sql, store.db);
  await store.sql.unsafe("DROP TABLE invoice_repair_fence");
  await assert.rejects(col.findOne({}), /does not exist/);
  await factoryMongo.close();
  await factoryPg.end({ timeout: 2 });
  delete process.env.DATABASE_URL;
  delete process.env.PGHOST;
  delete process.env.PGUSER;
  console.log("Mandatory driver boundary checks passed: queries, transactions, Mongo reads/writes/cursors, durable access and missing fence");
}
main().finally(() => store.close()).catch(e => { console.error(e); process.exitCode = 1; });
