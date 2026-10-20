import assert from "node:assert/strict";
import { ObjectId, Int32, Double, Long, Decimal128, Binary, Timestamp } from "mongodb";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
import { normalizedWorkOrders } from "../lib/db/schema/normalized";
import { LocalDualMetadataStore } from "../scripts/invoice-metadata-dual-store";
import { testNativeEvidence } from "./invoice-native-evidence.test";
import {
  READ_NATIVE_POSTGRES, NATIVE_BSON_READ_OPTIONS, mapNativePostgres, mapNativeMongo,
  nativePostgresCas, nativeMongoCas, invoiceField, bsonWithoutInvoice,
  executeProductionInvoiceRepair,
} from "../scripts/invoice-native-schema";

const store = new LocalDualMetadataStore(process.env.INVOICE_DUAL_SOCKET!,
  Number(process.env.INVOICE_DUAL_PORT), process.env.INVOICE_DUAL_MARKER!,
  process.env.INVOICE_DUAL_PORTS?.split(",").map(Number));
const collection = store.db.collection("normalized_work_orders");
const dialect = new PgDialect();
const source = { sourceSystem: "protractor", sourceIds: [
  { system: "protractor", idType: "invoice_id", idValue: "11111111-1111-4111-8111-111111111111", isPrimary: true },
] };
const patch = { version: 1, id: source.sourceIds[0].idValue,
  date: "2026-10-19T12:00:00.000Z", sold: null, presented: 0 };

async function main() {
  assert.equal(process.env.MONGODB_PASSWORD, undefined);
  await store.mongo.connect();
  assert.ok(await store.db.collection("marker").findOne({ _id: store.marker as any }));
  await store.sql.begin(tx => store.guard(tx));
  // Derive columns, native enum types, defaults and nullability from the actual
  // Drizzle schema, rather than another manually maintained owner envelope.
  const { columns } = getTableConfig(normalizedWorkOrders);
  const enums = new Map<string, string[]>();
  for (const c of columns) {
    if ("enumValues" in c && Array.isArray(c.enumValues) && c.enumValues.length)
      enums.set(c.getSQLType(), c.enumValues);
  }
  for (const [name, values] of enums)
    await store.sql.unsafe(`CREATE TYPE "${name}" AS ENUM (${values.map(v => `'${v}'`).join(",")})`);
  const definitions = columns.map(c => {
    const defaultSql = c.default instanceof SQL ? dialect.sqlToQuery(c.default).sql
      : c.default === undefined ? null : `'${String(c.default)}'`;
    return `"${c.name}" ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.primary ? " PRIMARY KEY" : ""}` +
      (defaultSql ? ` DEFAULT ${defaultSql}` : "");
  });
  await store.sql.unsafe(`CREATE TABLE normalized_work_orders (${definitions.join(",")})`);
  await store.sql.unsafe("CREATE UNIQUE INDEX ON normalized_work_orders(shop_id,work_order_number)");
  for (const nullField of [false, true]) {
    await store.sql.unsafe("TRUNCATE normalized_work_orders");
    await collection.deleteMany({});
    const fields = { unrelated: { empty: null, zero: 0 }, ...(nullField ? { invoiceHours: null } : {}) };
    await store.sql`INSERT INTO normalized_work_orders
      (id,shop_id,work_order_number,status,provenance,custom_fields,grand_total,raw_data)
      VALUES ('native-row',9100,'1','closed',${store.sql.json(source)},${store.sql.json(fields)},
        1234567890.12,'{"precise":12345678901234567890.123456789,"explicitNull":null}'::jsonb)`;
    const pgRead = async () => mapNativePostgres(
      (await store.sql.unsafe(READ_NATIVE_POSTGRES, ["native-row"]))[0] as any);
    const pgBefore = await pgRead();
    assert.equal(invoiceField(pgBefore.target.custom_fields).present, nullField);
    const executePg = async (before: typeof pgBefore, field: Parameters<typeof nativePostgresCas>[1]) => {
      const cas = nativePostgresCas(before, field);
      return store.sql.unsafe(cas.sql, cas.params as any[]);
    };
    assert.equal((await executePg(pgBefore, { present: true, value: patch })).length, 1);
    const pgAfter = await pgRead();
    assert.equal((await executePg(pgBefore, { present: true, value: patch })).length, 0, "Full-state CAS");
    const unchanged = await store.sql.unsafe(`SELECT
      (to_jsonb(w) #- '{custom_fields,invoiceHours}') =
      ($1::text::jsonb #- '{custom_fields,invoiceHours}') AS same FROM normalized_work_orders w`, [pgBefore.fullState]);
    assert.equal(unchanged[0].same, true);
    assert.ok(pgAfter.fullState.includes("12345678901234567890.123456789"), "No JS numeric loss");
    assert.equal((await executePg(pgAfter, invoiceField(pgBefore.target.custom_fields))).length, 1);
    assert.equal((await pgRead()).fullState, pgBefore.fullState);
    await store.sql.unsafe("UPDATE normalized_work_orders SET balance_due=1");
    assert.equal((await executePg(pgBefore, { present: true, value: patch })).length, 0, "Financial drift veto");

    for (const id of [new ObjectId(), "native-string-id"]) {
      const doc = { _id: id, shopId: new Int32(9100), version: new Int32(7),
        workOrderNumber: "1", status: "closed", softDelete: { isDeleted: false },
        provenance: source, customFields: fields, createdAt: new Date("2026-10-19T12:00:00Z"),
        grandTotal: Decimal128.fromString("1234567890.1200"), laborHoursTotal: new Double(0),
        opaque: { integer: Long.fromString("9007199254740993"),
          bytes: new Binary(Buffer.from([0, 1, 255]), 128), stamp: Timestamp.fromNumber(12345678) },
        payments: [{ amount: new Int32(0), reference: null }] };
      await collection.insertOne(doc as any);
      const read = async () => mapNativeMongo((await collection.findOne({ _id: id as any }, NATIVE_BSON_READ_OPTIONS))!);
      const before = await read();
      const apply = nativeMongoCas(before, { present: true, value: patch });
      assert.equal((await collection.updateOne(apply.filter, apply.update)).modifiedCount, 1);
      assert.equal((await collection.updateOne(apply.filter, apply.update)).matchedCount, 0);
      const after = await read();
      assert.equal(bsonWithoutInvoice(after), bsonWithoutInvoice(before), "Native BSON/financial bytes retained");
      const rollback = nativeMongoCas(after, invoiceField(before.target.custom_fields));
      assert.equal((await collection.updateOne(rollback.filter, rollback.update)).modifiedCount, 1);
      assert.equal((await read()).fullStateBson, before.fullStateBson, "Missing/null restored exactly");

      // Ordinary Mongo equality cannot distinguish these equal-valued types.
      await collection.updateOne({ _id: id as any }, { $set: { "payments.0.amount": new Double(0) } });
      assert.equal((await collection.updateOne(apply.filter, apply.update)).matchedCount, 0, "Numeric BSON type drift veto");
      await collection.updateOne({ _id: id as any }, { $set: { "payments.0.amount": new Int32(0), addedNull: null } });
      assert.equal((await collection.updateOne(apply.filter, apply.update)).matchedCount, 0, "Added null veto");
      await collection.updateOne({ _id: id as any }, { $unset: { addedNull: "", "payments.0.reference": "" } });
      assert.equal((await collection.updateOne(apply.filter, apply.update)).matchedCount, 0, "Missing financial member veto");
      await collection.deleteOne({ _id: id as any });
    }
  }
  assert.throws(() => mapNativeMongo({
    _id: "promoted", shopId: 9100, status: "closed", provenance: source,
    softDelete: {}, customFields: {},
  }), /numeric promotion/);
  assert.throws(() => mapNativeMongo({
    _id: "undefined", shopId: new Int32(9100), status: "closed", provenance: source,
    softDelete: {}, customFields: {}, financial: undefined,
  }), /Unsupported BSON value/);
  assert.throws(() => executeProductionInvoiceRepair(), /disabled/);
  await testNativeEvidence(store.sql, store.db);
  console.log("Native invoice schema checks passed: real PG columns, BSON IDs/types, metadata-only CAS and drift vetoes");
}
main().finally(() => store.close()).catch(error => { console.error(error); process.exitCode = 1; });
