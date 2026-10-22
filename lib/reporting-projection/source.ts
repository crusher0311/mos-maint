import assert from "node:assert/strict";
import { EJSON } from "bson";
import type { Db } from "mongodb";
import { hash, LIMITS, UUID, type Query, type SourceDocument, type SourceInventory } from "./contract";
import { PG_SOURCE_KEYS as pg, pgSourceQuery } from "./source-query";
const mongo = [
  "normalized_work_orders", "normalized_service_jobs", "normalized_line_items", "normalized_payments",
  "protractor_work_orders", "protractor_invoices", "protractor_invoice_cache",
  "operator_history_import_pages", "operator_history_import_jobs", "operator_history_import_days",
  "operator_history_import_receipts",
] as const;

/** Read-only adapters, supplied restricted connections; no connection factory or provider client.
 * All channels are required. A missing table/collection is not an empty inventory. */
export class StoredInvoiceInventory implements SourceInventory {
  readonly channels = [...Object.keys(pg).map(t => `pg.${t}`), ...mongo.map(t => `mongo.${t}`)];
  constructor(private readonly query: Query, private readonly db: Db) {}

  private async read(channel: string, shop: number, key: string | null, exact: boolean, supplied?: any) {
    assert.ok(this.channels.includes(channel));
    assert.ok(Number.isSafeInteger(shop) && shop > 0);
    const [store, table] = channel.split(".");
    let doc: any, native: string, cursor: string;
    if (store === "pg") {
      // Size check in PostgreSQL prevents an oversized row crossing the wire.
      const rows = supplied ? [supplied] : await this.query(pgSourceQuery(table, key, exact), [shop, key, LIMITS.documentBytes]);
      assert.ok(rows.length <= 1, "ambiguous_source_key");
      if (!rows.length) return null;
      assert.ok(rows[0].state, "source_document_byte_limit");
      native = rows[0].state; cursor = rows[0].cursor; doc = JSON.parse(native);
    } else {
      assert.equal((await this.db.listCollections({ name: table }, { nameOnly: true }).toArray()).length, 1,
        `Missing inventory collection: ${table}`);
      const filter: any = { shopId: { $in: [shop, String(shop)] } };
      if (key !== null) {
        if (exact) filter._id = EJSON.parse(key);
        // Query-operator $gt is type-bracketed; mixed String/ObjectId keys would
        // silently disappear. Expression comparison uses BSON total ordering.
        else filter.$expr = { $gt: ["$_id", { $literal: EJSON.parse(key) }] };
      }
      doc = await this.db.collection(table).findOne(filter, { sort: { _id: 1 }, maxTimeMS: 2000 });
      if (!doc) return null;
      native = EJSON.stringify(doc, { relaxed: false });
      assert.ok(Buffer.byteLength(native) <= LIMITS.documentBytes, "source_document_byte_limit");
      cursor = EJSON.stringify(doc._id, { relaxed: false });
    }
    const raw = store === "pg"
      ? doc.raw_data?.rawPayload ?? doc.payload?.rawPayload ?? doc.payload?.data ?? doc.payload?.invoice
      : doc.rawPayload ?? doc.data ?? doc.invoice;
    let raws: any[] = raw ? [raw] : [];
    const identities = new Set<string>();
    let ambiguous = false;
    let owner: string | null = null;
    const identity = (value: unknown) => {
      const id = String(value ?? "").toLowerCase();
      if (UUID.test(id)) identities.add(id);
      else ambiguous = true;
    };
    if (table === "operator_history_import_pages") {
      assert.ok(Array.isArray(doc.invoices) && doc.invoices.length <= 100, "archive_page_limit");
      assert.equal(hash(doc.invoices), doc.digest, "archive_integrity");
      raws = doc.invoices;
      raws.forEach(r => identity(r?.ID));
    } else if (table === "normalized_work_orders") {
      const ids = doc.provenance?.sourceIds;
      for (const id of Array.isArray(ids) ? ids : [])
        if (id.system === "protractor" && ["invoice_id", "work_order_id"].includes(id.idType)) identity(id.idValue);
      if (raw) identity(raw.ID);
      // Non-Protractor owners remain explicit unknown populations, never silently excluded.
      if (store === "pg" && doc.provenance?.sourceSystem === "protractor") owner = String(doc.id);
      if (store === "pg" && (doc.provenance?.sourceSystem !== "protractor" || doc.soft_delete?.isDeleted))
        ambiguous = true;
      if (identities.size !== 1) ambiguous = true;
    } else if (["protractor_work_orders", "protractor_invoices", "protractor_invoice_cache"].includes(table)) {
      identity(store === "pg" ? doc[pg[table as keyof typeof pg]] : doc.workOrderId ?? doc.invoiceId);
      if (raw) identity(raw.ID);
      if (identities.size !== 1) ambiguous = true;
    }
    if (ambiguous || (table === "normalized_work_orders" && !identities.size))
      identities.add(`unknown:${hash([channel, cursor])}`);
    return { key: cursor, digest: hash(native), identities: [...identities].sort(),
      owner, ambiguous, raws } satisfies SourceDocument;
  }
  next(channel: string, shop: number, after: string | null) { return this.read(channel, shop, after, false); }
  async nextBatch(channel: string, shop: number, after: string | null, limit: number) {
    assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 10);
    assert.ok(this.channels.includes(channel) && Number.isSafeInteger(shop) && shop > 0);
    // Mongo retains its bounded single-document path until a BSON-order batch
    // implementation has independent index/size evidence.
    if (!channel.startsWith("pg.") || limit === 1) {
      const doc = await this.next(channel, shop, after); return doc ? [doc] : [];
    }
    const rows = await this.query(pgSourceQuery(channel.split(".")[1], after, false, limit),
      [shop, after, LIMITS.documentBytes]);
    assert.ok(rows.length <= limit);
    const docs = [];
    for (const row of rows) docs.push((await this.read(channel, shop, after, false, row))!);
    return docs;
  }
  load(channel: string, shop: number, key: string) { return this.read(channel, shop, key, true); }
}
