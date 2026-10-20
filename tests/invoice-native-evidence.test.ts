import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Int32 } from "mongodb";
import { readNativeInvoiceEvidence } from "../scripts/invoice-native-evidence";

export async function testNativeEvidence(sql: any, db: any) {
  const id = "22222222-2222-4222-8222-222222222222", shopId = 9200;
  const raw = { ID: id, Type: "Invoice", WorkflowStage: "Invoice", InvoiceNumber: 12,
    InvoiceTime: "2026-10-19T12:00:00Z", ServicePackages: [], DeferredServicePackages: [] };
  const provenance = { sourceSystem: "protractor",
    sourceIds: [{ system: "protractor", idType: "invoice_id", idValue: id, isPrimary: true }] };
  await sql.unsafe(`INSERT INTO normalized_work_orders
    (id,shop_id,work_order_number,status,provenance,custom_fields,raw_data)
    VALUES($1,$2,'12','closed',$3::text::jsonb,'{}',$4::text::jsonb)`,
  ["evidence-native", shopId, JSON.stringify(provenance), JSON.stringify({ rawPayload: raw })]);
  await db.collection("normalized_work_orders").insertOne({
    _id: "evidence-native", shopId: new Int32(shopId), status: "closed",
    softDelete: { isDeleted: false }, provenance, customFields: {}, rawPayload: raw,
  });
  for (const table of ["normalized_service_jobs", "normalized_line_items", "normalized_payments"])
    await sql.unsafe(`CREATE TABLE ${table} (id text PRIMARY KEY, shop_id integer NOT NULL,
      work_order_id text NOT NULL, amount numeric(12,2))`);
  for (const table of ["protractor_work_orders", "protractor_invoices", "protractor_invoice_cache"]) {
    const key = table === "protractor_work_orders" ? "work_order_id" : "invoice_id";
    await sql.unsafe(`CREATE TABLE ${table} (shop_id integer NOT NULL, ${key} text NOT NULL,
      payload jsonb NOT NULL, PRIMARY KEY(shop_id,${key}))`);
  }
  const invoices = [raw];
  await db.collection("operator_history_import_pages").insertOne({
    _id: "new-campaign-not-in-old-allowlist", shopId, invoices,
    digest: createHash("sha256").update(JSON.stringify(invoices)).digest("hex"),
  });
  const before = await readNativeInvoiceEvidence(sql, db, shopId, id);
  assert.equal(before.source.copies.length, 3, "Both native rows plus previously unknown archive campaign");
  await sql.unsafe("INSERT INTO normalized_payments VALUES('payment',$1,'evidence-native',1.00)", [shopId]);
  assert.notEqual((await readNativeInvoiceEvidence(sql, db, shopId, id)).inventoryDigest, before.inventoryDigest);
  await db.collection("operator_history_import_pages").updateOne(
    { _id: "new-campaign-not-in-old-allowlist" }, { $set: { digest: "invalid" } });
  await assert.rejects(readNativeInvoiceEvidence(sql, db, shopId, id), /Archive integrity failure/);
  await db.collection("operator_history_import_pages").deleteMany({});
  await db.collection("normalized_work_orders").insertOne({
    _id: "competing-native", shopId: new Int32(shopId), status: "closed",
    softDelete: { isDeleted: false }, provenance, customFields: {}, rawPayload: raw,
  });
  await assert.rejects(readNativeInvoiceEvidence(sql, db, shopId, id), /Shadow ownership is not unique/);
  console.log("Native evidence checks passed: both stores, all retained campaigns, financial drift, integrity and competing owners");
}
