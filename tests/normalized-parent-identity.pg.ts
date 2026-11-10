import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { userInfo } from "node:os";
import {
  normalizedWorkOrders, normalizedServiceJobs, normalizedLineItems, normalizedPayments,
} from "../lib/db/schema/normalized";
import { SupabaseDualWriter } from "../lib/supabase-dual-writer";
import { NormalizedIngestionService } from "../lib/integrations/core/normalized-ingestion";
import { assertSameWorkOrderOwner } from "../lib/normalized-work-order-owner";

const provenance = (id = "provider-1", system = "tekmetric") => ({
  sourceSystem: system,
  sourceIds: [{ system, idType: "repair_order_id", idValue: id, isPrimary: true }],
});
const doc = (id: string, number: string, owner = provenance(), shopId = 97) => ({
  _id: id, workOrderNumber: number, shopId, provenance: owner, grandTotal: 10,
});

async function main() {
  const socket = process.argv[2];
  assert.match(socket, /^\/tmp\/parent-identity\.[^/]+$/);
  const pg = postgres({ host: socket, username: userInfo().username, database: "postgres", max: 4 });
  try {
    assert.equal((await pg`select current_setting('parent_identity.disposable',true) marker`)[0].marker, "yes");
    const enums = new Set<string>();
    for (const [name, table, constraints] of [
      ["normalized_work_orders", normalizedWorkOrders, "UNIQUE(shop_id,work_order_number)"],
      ["normalized_service_jobs", normalizedServiceJobs, "FOREIGN KEY(work_order_id) REFERENCES normalized_work_orders(id)"],
      ["normalized_line_items", normalizedLineItems, "FOREIGN KEY(work_order_id) REFERENCES normalized_work_orders(id), FOREIGN KEY(service_job_id) REFERENCES normalized_service_jobs(id)"],
      ["normalized_payments", normalizedPayments, "FOREIGN KEY(work_order_id) REFERENCES normalized_work_orders(id)"],
    ] as const) {
      for (const column of Object.values(getTableColumns(table))) {
        if (column.enumValues?.length && !enums.has(column.getSQLType())) {
          const type = column.getSQLType();
          await pg.unsafe(`CREATE TYPE ${type} AS ENUM (${column.enumValues.map((v: string) => `'${v}'`).join(",")})`);
          enums.add(type);
        }
      }
      const columns = Object.values(getTableColumns(table)).map(c =>
        `"${c.name}" ${c.getSQLType()}${c.name === "id" ? " PRIMARY KEY" : ""}`);
      await pg.unsafe(`CREATE TABLE ${name} (${columns.join(",")}, ${constraints})`);
    }
    const writer = new SupabaseDualWriter(drizzle(pg) as any);
    const ids = await Promise.all([
      writer.upsertWorkOrder(doc("winner-a", "100")),
      writer.upsertWorkOrder(doc("winner-b", "100")),
    ]);
    assert.equal(ids[0], ids[1]);
    const rows = await pg`select id,raw_data from normalized_work_orders where work_order_number='100'`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].raw_data._id, rows[0].id);
    assert.equal(await writer.upsertWorkOrder(doc(ids[0], "100")), ids[0], "ordinary PK update returns identity");
    console.log("PASS real PG concurrent inserts return one canonical ID, including retained raw identity");

    for (const owner of [
      provenance("different-record"),
      provenance("provider-1", "shopmonkey"),
      { sourceSystem: "tekmetric", sourceIds: [] },
      { ...provenance(), sourceIds: [...provenance().sourceIds, ...provenance("other").sourceIds] },
    ]) {
      await assert.rejects(() => writer.upsertWorkOrder(doc("rejected", "100", owner)));
    }
    assert.equal(Number((await pg`select grand_total from normalized_work_orders where id=${ids[0]}`)[0].grand_total), 10);
    const otherShop = await writer.upsertWorkOrder(doc("other-shop", "100", provenance(), 98));
    assert.equal(otherShop, "other-shop", "shop scope cannot resolve to another shop's owner");
    assert.throws(() => assertSameWorkOrderOwner(provenance(), {
      ...provenance(), sourceSystem: "shopmonkey",
    }));
    console.log("PASS mismatched, missing and ambiguous provider ownership rejects without overwriting winner");

    // Force an ownership change between the fallback SELECT and UPDATE. The
    // actual SQL CAS must veto it even though the initial evidence matched.
    const db = drizzle(pg) as any;
    const racingDb = Object.create(db);
    racingDb.select = (...args: any[]) => {
      const query = db.select(...args);
      return { from: (...from: any[]) => ({ where: (...where: any[]) => ({
        limit: async (n: number) => {
          const result = await query.from(...from).where(...where).limit(n);
          await pg`update normalized_work_orders set provenance=${JSON.stringify(provenance("changed"))}::jsonb where work_order_number='100' and shop_id=97`;
          return result;
        },
      }) }) };
    };
    await assert.rejects(() => new SupabaseDualWriter(racingDb).upsertWorkOrder(doc("cas-loser", "100")),
      /ownership changed/);
    console.log("PASS atomic ownership recheck rejects a changed winner");

    // Exercise the real ingestion caller with two guaranteed initial misses.
    // The Mongo double checks identity and unique provider ownership; PG is real.
    const shadows = new Map<string, any>();
    const childParents: string[] = [];
    const mongo = {
      collection(name: string) {
        return {
          async findOne() { return null; },
          async updateOne(filter: any, update: any) {
            if (name === "normalized_work_orders" && update.$setOnInsert) {
              const value = update.$setOnInsert;
              assert.equal(filter._id, value._id);
              assert.ok(![...shadows.values()].some(d =>
                d.workOrderNumber === value.workOrderNumber && d._id !== value._id));
              if (!shadows.has(filter._id)) shadows.set(filter._id, structuredClone(value));
            }
            return { matchedCount: 1 };
          },
          async insertOne(value: any) {
            assert.notEqual(name, "normalized_work_orders", "create shadows must be idempotent");
            if (value.workOrderId) childParents.push(value.workOrderId);
            return { acknowledged: true };
          },
        };
      },
    };
    const adapter = {
      sourceSystem: "tekmetric",
      getSourceIds: () => provenance().sourceIds,
      mapWorkOrder: () => ({ workOrderNumber: "200", status: "closed" }),
      mapServiceJob: () => ({ title: "Fixture service", status: "completed" }),
      mapLineItem: () => ({ description: "Fixture line", lineType: "labor" }),
      mapPayment: () => ({ amount: 10, paymentMethod: "cash" }),
      extractVehicleFromWorkOrder: () => null,
      extractCustomerFromWorkOrder: () => null,
      extractServiceJobsFromWorkOrder: () => [],
    };
    const makeService = () => {
      const svc = new NormalizedIngestionService(mongo as any, "tekmetric", 97, undefined, {
        dualWriteToSupabase: false, createAuditLog: false,
        dualWriteToJobIndex: false, dualWriteToRepairPatterns: false,
      }, adapter as any);
      (svc as any).supabaseDualWriter = writer;
      return svc;
    };
    const originalFind = writer.findWorkOrderByNaturalKey.bind(writer);
    let misses = 0;
    writer.findWorkOrderByNaturalKey = async (...args) => {
      if (misses++ < 2) return null;
      return originalFind(...args);
    };
    const services = [makeService(), makeService()];
    const parents = await Promise.all(services.map(s => s.ingestWorkOrder({ id: "provider-1" })));
    assert.ok(parents.every(p => p.success), JSON.stringify(parents));
    assert.equal(parents[0].entityId, parents[1].entityId);
    assert.deepEqual(parents.map(p => p.action).sort(), ["created", "updated"]);
    const parentId = parents[0].entityId!;
    assert.equal(shadows.size, 1);
    assert.ok(shadows.has(parentId));
    for (const [i, svc] of services.entries()) {
      const job = await svc.ingestServiceJob(parents[i].entityId!, { id: `job-${i}` });
      assert.ok(job.success, job.message);
      const line = await svc.ingestLineItem(parents[i].entityId!, job.entityId!, { id: `line-${i}` });
      assert.ok(line.success, line.message);
      const payment = await svc.ingestPayment(parents[i].entityId!, { id: `payment-${i}` });
      assert.ok(payment.success, payment.message);
    }
    for (const table of ["normalized_service_jobs", "normalized_line_items", "normalized_payments"]) {
      const children = await pg.unsafe(`select work_order_id from ${table}`);
      assert.equal(children.length, 2);
      assert.ok(children.every(c => c.work_order_id === parentId));
    }
    assert.equal(childParents.length, 6);
    assert.ok(childParents.every(id => id === parentId));
    console.log("PASS ingestion race: canonical IDs reach both callers, Mongo shadow, jobs, lines and payments");

    // Mongo fallback can also lose a race during skip backfill or update.
    // Its obsolete local ID must not escape either branch.
    writer.findWorkOrderByNaturalKey = async () => null;
    for (const unchanged of [true, false]) {
      const legacy = {
        ...shadows.get(parentId),
        _id: "legacy-losing-parent",
        provenance: {
          ...shadows.get(parentId).provenance,
          contentHash: unchanged ? parents[0].contentHash : "old-hash",
        },
      };
      const fallbackMongo = {
        collection(name: string) {
          return {
            ...mongo.collection(name),
            async findOne() { return name === "normalized_work_orders" ? legacy : null; },
          };
        },
      };
      const svc = new NormalizedIngestionService(fallbackMongo as any, "tekmetric", 97, undefined, {
        dualWriteToSupabase: false, createAuditLog: false,
        dualWriteToJobIndex: false, dualWriteToRepairPatterns: false,
      }, adapter as any);
      (svc as any).supabaseDualWriter = writer;
      const result = await svc.ingestWorkOrder({ id: "provider-1" });
      assert.equal(result.success, true, result.message);
      assert.equal(result.entityId, parentId);
      assert.equal(result.action, unchanged ? "skipped" : "updated");
      assert.equal(shadows.size, 1);
      assert.ok(!shadows.has("legacy-losing-parent"));
    }
    console.log("PASS Mongo-fallback skip and update races preserve canonical parent identity");

    process.env.WRITE_MONGO_NORMALIZED = "0";
    adapter.mapWorkOrder = () => ({ workOrderNumber: "300", status: "closed" });
    const noShadow = await Promise.all(services.map(s => s.ingestWorkOrder({ id: "provider-1" })));
    assert.ok(noShadow.every(p => p.success), JSON.stringify(noShadow));
    assert.equal(noShadow[0].entityId, noShadow[1].entityId);
    assert.equal(shadows.size, 1, "disabled shadows remain untouched");
    delete process.env.WRITE_MONGO_NORMALIZED;
    adapter.mapWorkOrder = () => ({ workOrderNumber: "200", status: "closed" });
    console.log("PASS canonical identity propagation with Mongo shadow disabled");

    // Failed parent writes must stop the all-entities path before children.
    writer.findWorkOrderByNaturalKey = async () => null;
    // Force a real conflicting identity rather than relying on a synthetic throw.
    adapter.getSourceIds = () => provenance("unrelated").sourceIds;
    const blocked = await makeService().ingestWorkOrderWithAllEntities({ id: "unrelated" });
    assert.equal(blocked.workOrder.success, false);
    assert.equal(blocked.workOrder.action, "error");
    assert.deepEqual(blocked.serviceJobs, []);
    assert.deepEqual(blocked.lineItems, []);
    assert.deepEqual(blocked.payments, []);
    console.log("PASS conflicting parent reports failure without child success");
  } finally {
    await pg.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
