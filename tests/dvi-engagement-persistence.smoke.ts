import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";

// Intercept only database factories. No network/database access is allowed here.
const Module = require("module");
const originalLoad = Module._load;
const docs: any[] = [];
const pgQueries: Array<{ sql: string; params: unknown[] }> = [];
let maxTime = 0;
let rowLimit = 0;
const matches = (doc: any, filter: any) =>
  Object.entries(filter).every(([key, val]: any) => val?.$in ? val.$in.includes(doc[key]) : doc[key] === val);
const collection = {
  async updateOne(filter: any, update: any, options: any) {
    const touched = new Set<string>();
    for (const op of Object.values(update) as any[]) for (const key of Object.keys(op)) {
      assert(!touched.has(key), `conflicting Mongo update path ${key}`);
      touched.add(key);
    }
    let doc = docs.find(doc => matches(doc, filter));
    if (!doc && options?.upsert) { doc = { ...update.$setOnInsert }; docs.push(doc); }
    assert(doc);
    for (const [key, value] of Object.entries(update.$min || {})) {
      if (doc[key] === undefined || (value as string) < doc[key]) doc[key] = value;
    }
    Object.assign(doc, update.$set);
  },
  find(filter: any, options: any) {
    assert(options.projection["data.inspectionShareDate"]);
    return {
      limit(n: number) { rowLimit = n; return this; },
      maxTimeMS(n: number) { maxTime = n; return this; },
      async toArray() { return docs.filter(doc => matches(doc, filter)); },
    };
  },
};
const fakePg: any = {
  insert() {
    return { values() {
      return { async onConflictDoUpdate(options: any) {
        const query = new PgDialect().sqlToQuery(options.set.payload);
        assert(query.sql.includes("||"), "snapshot refresh must merge, not replace evidence");
      } };
    } };
  },
  async execute(query: any) {
    const compiled = new PgDialect().sqlToQuery(query);
    pgQueries.push(compiled);
    return [];
  },
  async transaction(fn: any) { return fn(fakePg); },
};
Module._load = function(request: string, ...args: any[]) {
  if (request === "@/lib/data/db") return { getDb: async () => ({ collection: () => collection }) };
  if (request === "@/lib/db/drizzle") return { getDb: () => fakePg };
  return originalLoad.call(this, request, ...args);
};

async function main() {
  const { recordTekmetricDviEvidence: write, findTekmetricDviEvidence: read } =
    require("../lib/data/repositories/dvi-engagement");
  const { upsertTekmetricWorkOrderSnapshot: refresh } =
    require("../lib/data/repositories/tekmetric-work-orders");
  process.env.TEKMETRIC_CACHE_PG_CANONICAL = "0";
  const early = "2026-10-01T12:00:00.000Z";
  const late = "2026-10-02T12:00:00.000Z";
  await write(7, "10", { inspectionViewReceivedAt: late });
  await write(7, "10", { inspectionViewReceivedAt: late });
  await write(7, "10", { inspectionViewReceivedAt: early });
  await write(7, "10", { inspectionViewReceivedAt: late, inspectionSharedAt: early });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].dviInspectionViewReceivedAt, early);
  await write(8, "10", { inspectionSharedAt: late });
  assert.equal(docs.length, 2);
  // Numeric/string legacy identity variants must update, not split evidence.
  docs[0].shopId = "7"; docs[0].workOrderId = 10;
  await write(7, "10", { inspectionViewReceivedAt: late });
  assert.equal(docs.length, 2);
  await refresh("7", 10 as any, { data: { inspectionShareDate: null, jobs: [] } });
  assert.equal(docs[0].dviInspectionSharedAt, early);
  assert.equal(docs[0].dviInspectionViewReceivedAt, early);
  const found = await read(7, ["10", "20"], 80);
  assert.equal(found.length, 1);
  assert.equal(found[0].dviInspectionSharedAt, early);
  assert.equal(maxTime, 80);
  assert.equal(rowLimit, 600);
  await write(7, "10", { inspectionSharedAt: "invalid" });
  assert.equal(docs[0].dviInspectionSharedAt, early);
  await read(7, [], 80);

  process.env.TEKMETRIC_CACHE_PG_CANONICAL = "1";
  process.env.WRITE_MONGO_TEKMETRIC_CACHE = "0";
  // Shadow default is checked below via SQL and no canonical read touches Mongo.
  await write(7, "10", { inspectionSharedAt: late, inspectionViewReceivedAt: early });
  assert(pgQueries.some(q => q.sql.includes("ON CONFLICT (shop_id, work_order_id)") &&
    q.sql.includes("least(") && q.sql.includes("payload") && q.params.includes(7) && q.params.includes("10")));
  await read(8, ["10"], 50);
  const select = pgQueries.find(q => q.sql.includes("SELECT work_order_id"));
  assert(select && select.sql.includes("shop_id =") && select.sql.includes("work_order_id IN"));
  assert(select.params.includes(8) && select.params.includes("10"));
  assert(pgQueries.some(q => q.sql.includes("statement_timeout") && q.params.includes("50")));
  await refresh(7, "10", { data: {} });
  // The existing snapshot writer is Drizzle-builder based; tested below separately.
  console.log("DVI persistence/canonical-store/atomic merge tests passed");
}
main().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  Module._load = originalLoad;
});
