import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import { prerequisites } from "../lib/data/repositories/protractor-exports";
import { exportOnlyLifecycle } from "../workers/export-only-lifecycle";

function fixture() {
  const indexes: Record<string, any[]> = {
    protractor_export_configs: [{ name: "export_active", key: { paused: 1, revoked: 1, _id: 1 } }],
    protractor_export_states: [
      { name: "export_status", key: { enterpriseId: 1, revision: 1, shopId: 1 } },
      { name: "export_retention", key: { "pending.createdAt": 1 } },
    ],
    protractor_export_history: [
      { name: "export_history_ttl", key: { acceptedAt: 1 }, expireAfterSeconds: 7776000 },
      { name: "export_history_enterprise_accepted", key: { enterpriseId: 1, acceptedAt: -1 } },
    ],
    protractor_work_orders: [{ name: "existing_operator_name", key: { shopId: 1, workOrderId: 1 }, unique: true }],
    protractor_invoices: [{ name: "protractor_invoice_shop_invoice", key: { shopId: 1, invoiceId: 1 } }],
    protractor_invoice_cache: [{ name: "protractor_invoice_cache_shop_invoice", key: { shopId: 1, invoiceId: 1 } }],
  };
  const metadata: Record<string, any> = Object.fromEntries(Object.keys(indexes).map(name =>
    [name, { name, type: "collection", options: {} }]));
  const reads: string[] = [];
  // No write/index-management methods exist: any attempt to mutate fails.
  const db = {
    listCollections: ({ name }: { name: string }) => ({ toArray: async () => {
      reads.push(`metadata:${name}`); return metadata[name] ? [metadata[name]] : [];
    } }),
    collection: (name: string) => ({ listIndexes: () => ({ toArray: async () => {
      reads.push(`indexes:${name}`); return indexes[name];
    } }) }),
  } as unknown as Pick<Db, "collection" | "listCollections">;
  return { db, indexes, metadata, reads };
}

test("manifest passes read-only, including an existing unique work-order index under its own name", async () => {
  const f = fixture();
  await prerequisites(f.db);
  assert.equal(f.reads.length, 12);
});

test("every required index rejects a correct name with wrong keys, order, direction or extra fields", async () => {
  for (const [collection, indexes] of Object.entries(fixture().indexes)) {
    for (let i = 0; i < indexes.length; i++) {
      const key = indexes[i].key;
      const variants = [
        { unrelated: 1 },
        Object.fromEntries(Object.entries(key).map(([k, v]) => [k, v === 1 ? -1 : 1])),
        { ...key, extra: 1 },
      ];
      if (Object.keys(key).length > 1)
        variants.push(Object.fromEntries(Object.entries(key).reverse()));
      for (const wrong of variants) {
        const f = fixture(); f.indexes[collection][i].key = wrong;
        await assert.rejects(prerequisites(f.db), /missing or incompatible/);
      }
      const f = fixture(); f.indexes[collection].splice(i, 1);
      await assert.rejects(prerequisites(f.db), /missing or incompatible/);
    }
  }
});

test("TTL must be exactly 90 days and absent from all non-TTL indexes", async () => {
  for (const ttl of [undefined, 0, 7775999, "7776000"]) {
    const f = fixture(); f.indexes.protractor_export_history[0].expireAfterSeconds = ttl;
    await assert.rejects(prerequisites(f.db), /export_history_ttl/);
  }
  for (const [collection, indexes] of Object.entries(fixture().indexes)) {
    for (let i = 0; i < indexes.length; i++) {
      if (indexes[i].expireAfterSeconds !== undefined) continue;
      const f = fixture(); f.indexes[collection][i].expireAfterSeconds = 7776000;
      await assert.rejects(prerequisites(f.db), /incompatible/);
    }
  }
});

test("partial, sparse, hidden and non-simple indexes fail closed", async () => {
  for (const [collection, indexes] of Object.entries(fixture().indexes)) {
    for (let i = 0; i < indexes.length; i++) {
      for (const option of [{ hidden: true }, { sparse: true },
        { partialFilterExpression: { shopId: 1 } }, { collation: { locale: "en", strength: 2 } },
        ...(collection.startsWith("protractor_export_") ? [{ unique: true }] : [])]) {
        const f = fixture(); Object.assign(f.indexes[collection][i], option);
        await assert.rejects(prerequisites(f.db), /incompatible/);
      }
    }
  }
});

test("all source collections and binary query collation are required even with a simple index", async () => {
  for (const collection of ["protractor_work_orders", "protractor_invoices", "protractor_invoice_cache"]) {
    const absent = fixture(); delete absent.metadata[collection];
    await assert.rejects(prerequisites(absent.db), /collection missing/);
    const f = fixture();
    f.metadata[collection].options.collation = { locale: "en", strength: 2 };
    f.indexes[collection][0].collation = { locale: "simple" };
    await assert.rejects(prerequisites(f.db), /simple default collation/);
    f.metadata[collection].options.collation = { locale: "simple" };
    await prerequisites(f.db);
  }
});

test("metadata failure propagates; incompatible prerequisites never start consumer or heartbeat", async () => {
  const f = fixture();
  f.db.listCollections = (() => { throw new Error("metadata denied"); }) as any;
  await assert.rejects(prerequisites(f.db), /metadata denied/);
  const missing = fixture(); missing.indexes.protractor_invoices = [];
  const lifecycle = exportOnlyLifecycle({
    preflight: () => prerequisites(missing.db),
    createConsumer: () => { assert.fail("consumer must not start"); },
    heartbeat: async () => { assert.fail("heartbeat must not start"); },
    schedule: () => { assert.fail("timer must not start"); },
    unschedule: () => {}, disconnect: async () => {}, warn: () => {},
  });
  await assert.rejects(lifecycle.start(), /source cursor index/);
  await lifecycle.stop();
});
