/** Complete, capped native evidence reads. No connection factory or provider calls. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { evidenceDigest } from "./invoice-metadata-repair-plan";
import { encodeNativeBson, mapNativeMongo, mapNativePostgres, NATIVE_BSON_READ_OPTIONS } from "./invoice-native-schema";
import type { StoredEvidenceCase } from "./invoice-evidence-local-preview";

export async function readNativeInvoiceEvidence(sql: any, db: Db, shopId: number, sourceId: string) {
  assert.ok(Number.isSafeInteger(shopId) && shopId > 0);
  assert.match(sourceId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const canonicalRows = await sql.unsafe(`SELECT id,to_jsonb(w)::text full_state
    FROM normalized_work_orders w WHERE shop_id=$1 AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(provenance->'sourceIds') s
      WHERE s->>'system'='protractor' AND s->>'idType' IN ('invoice_id','work_order_id')
      AND lower(s->>'idValue')=$2) ORDER BY id LIMIT 2`, [shopId, sourceId]);
  const shadows = await db.collection("normalized_work_orders").find({
    shopId: { $in: [shopId, String(shopId)] },
    "provenance.sourceIds": { $elemMatch: {
      system: "protractor", idType: { $in: ["invoice_id", "work_order_id"] },
      idValue: new RegExp(`^${sourceId}$`, "i"),
    } },
  }, { ...NATIVE_BSON_READ_OPTIONS, maxTimeMS: 5000 }).limit(2).toArray();
  assert.equal(canonicalRows.length, 1, "Canonical ownership is not unique");
  assert.equal(shadows.length, 1, "Shadow ownership is not unique");
  const canonical = mapNativePostgres(canonicalRows[0]);
  const shadow = mapNativeMongo(shadows[0]);
  const rawCanonical = JSON.parse(canonical.fullState);
  const copies: StoredEvidenceCase["copies"] = [];
  const retain = (raw: any) => {
    if (raw == null) return;
    assert.equal(typeof raw, "object", "Malformed retained payload");
    assert.equal(String(raw.ID).toLowerCase(), sourceId, "Retained payload belongs to another identity");
    copies.push({ shopId, raw });
  };
  retain(rawCanonical.raw_data?.rawPayload);
  // Plain reads are ONLY evidence projections. The native BSON owner above
  // remains the full-state CAS authority.
  const plainShadow = await db.collection("normalized_work_orders").findOne({ _id: shadows[0]._id });
  retain(plainShadow?.rawPayload);
  const inventories: Record<string, unknown> = {};
  const cap = 5000;
  for (const collection of ["protractor_work_orders", "protractor_invoices", "protractor_invoice_cache"]) {
    const key = collection === "protractor_work_orders" ? "workOrderId" : "invoiceId";
    const docs = await db.collection(collection).find({
      shopId: { $in: [shopId, String(shopId)] }, [key]: new RegExp(`^${sourceId}$`, "i"),
    }, { maxTimeMS: 5000 }).sort({ _id: 1 }).limit(cap + 1).toArray();
    assert.ok(docs.length <= cap, "Complete current-copy inventory cap");
    inventories[collection] = docs;
    for (const doc of docs) retain(doc.rawPayload ?? doc.data ?? doc.invoice);
  }
  // No hardcoded campaign/day allowlist: every retained page for the shop,
  // including later campaigns and pages captured after an earlier preflight.
  const pages = await db.collection("operator_history_import_pages").find({
    shopId: { $in: [shopId, String(shopId)] },
  }, { maxTimeMS: 5000 }).sort({ _id: 1 }).limit(cap + 1).toArray();
  assert.ok(pages.length <= cap, "Complete archive inventory cap");
  for (const page of pages) {
    assert.ok(Array.isArray(page.invoices) && page.invoices.length <= 100, "Malformed archive page");
    assert.equal(createHash("sha256").update(JSON.stringify(page.invoices)).digest("hex"), page.digest,
      "Archive integrity failure");
    for (const raw of page.invoices)
      if (String(raw?.ID).toLowerCase() === sourceId) retain(raw);
  }
  inventories.archives = pages;
  for (const collection of ["operator_history_import_jobs", "operator_history_import_days", "operator_history_import_receipts"]) {
    const records = await db.collection(collection).find({
      shopId: { $in: [shopId, String(shopId)] },
    }, { maxTimeMS: 5000 }).sort({ _id: 1 }).limit(cap + 1).toArray();
    assert.ok(records.length <= cap, "Complete history inventory cap");
    inventories[collection] = records;
  }
  for (const table of ["normalized_service_jobs", "normalized_line_items", "normalized_payments"]) {
    const rows = await sql.unsafe(`SELECT to_jsonb(child)::text state FROM ${table} child
      WHERE work_order_id=$1 ORDER BY id LIMIT 5001`, [canonical.id]);
    assert.ok(rows.length <= cap, "Complete financial-child inventory cap");
    for (const row of rows) assert.equal(JSON.parse(row.state).shop_id, shopId, "Financial child belongs to another shop");
    inventories[table] = rows.map((r: any) => r.state);
    const shadowChildren = await db.collection(table).find({
      workOrderId: { $in: [canonical.id, shadows[0]._id, String(shadows[0]._id)] },
    }, { ...NATIVE_BSON_READ_OPTIONS, maxTimeMS: 5000 }).sort({ _id: 1 }).limit(cap + 1).toArray();
    assert.ok(shadowChildren.length <= cap, "Complete shadow financial-child inventory cap");
    for (const child of shadowChildren) {
      const childShop = (child.shopId as any)?._bsontype === "Int32" ? (child.shopId as any).value : child.shopId;
      assert.ok(childShop === shopId || childShop === String(shopId), "Shadow child belongs to another shop");
    }
    inventories[`mongo.${table}`] = shadowChildren.map(encodeNativeBson);
  }
  // PG provider caches may be canonical while Mongo retains older copies.
  for (const table of ["protractor_work_orders", "protractor_invoices", "protractor_invoice_cache"]) {
    const key = table === "protractor_work_orders" ? "work_order_id" : "invoice_id";
    const rows = await sql.unsafe(`SELECT to_jsonb(cache)::text state FROM ${table} cache
      WHERE shop_id=$1 AND lower(${key})=$2 ORDER BY ${key} LIMIT 5001`, [shopId, sourceId]);
    assert.ok(rows.length <= cap, "Complete canonical-cache inventory cap");
    inventories[`pg.${table}`] = rows.map((r: any) => r.state);
    for (const row of rows) {
      const payload = JSON.parse(row.state).payload;
      retain(payload?.rawPayload ?? payload?.data ?? payload?.invoice);
    }
  }
  const inventoryText = JSON.stringify(inventories);
  assert.ok(Buffer.byteLength(inventoryText) <= 32 * 1024 * 1024, "Complete evidence byte cap");
  assert.ok(copies.length, "No retained invoice evidence");
  return {
    canonical, shadow,
    source: { shopId, sourceIds: [sourceId], copies } satisfies StoredEvidenceCase,
    inventoryDigest: evidenceDigest(inventories),
  };
}
