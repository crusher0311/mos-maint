/**
 * Native-schema primitives, NOT a production repair executor.
 *
 * No connection factory, credentials, activation flag or authorization bypass.
 * Callers must establish fencing/authorization BEFORE using a CAS. A successful
 * CAS alone neither proves complete ownership nor authorizes an invoice repair.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BSON, type Document } from "mongodb";
import type { SnapshotTarget } from "./invoice-metadata-repair-plan";

export type InvoiceField = { present: false } | { present: true; value: unknown };
export interface NativePostgresOwner {
  id: string;
  /** Server-produced text. Never round-trip financial numerics through JS. */
  fullState: string;
  target: SnapshotTarget;
}
export interface NativeMongoOwner {
  /** Includes the native _id and every BSON type, not a JSON serialization. */
  fullStateBson: string;
  target: SnapshotTarget;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: any, name: string) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
};
function target(id: string, shop: number, status: string, softDelete: any, provenance: any, fields: any): SnapshotTarget {
  assert.ok(Number.isSafeInteger(shop) && shop > 0, "Invalid native shop identity");
  assert.ok(typeof id === "string" && id.length > 0, "Missing native row identity");
  object(fields, "custom fields");
  object(provenance, "provenance");
  object(softDelete, "soft delete");
  return { id: hash(`${shop}:${id}`), shop_id: shop, status,
    soft_delete: softDelete, provenance, custom_fields: fields };
}

/** Select ALL columns, including future columns, inside the caller's snapshot. */
export const READ_NATIVE_POSTGRES = `
  SELECT id, to_jsonb(wo)::text AS full_state
  FROM normalized_work_orders wo WHERE id=$1`;

export function mapNativePostgres(row: { id: string; full_state: string }): NativePostgresOwner {
  assert.equal(typeof row.full_state, "string");
  const parsed = JSON.parse(row.full_state);
  assert.equal(parsed.id, row.id, "Native primary key changed");
  return { id: row.id, fullState: row.full_state,
    target: target(row.id, parsed.shop_id, parsed.status, parsed.soft_delete,
      parsed.provenance, parsed.custom_fields) };
}

/** Numeric promotion would erase Int32/Double/Long distinctions before CAS. */
export const NATIVE_BSON_READ_OPTIONS = Object.freeze({
  promoteValues: false, promoteLongs: false, promoteBuffers: false,
});
export function encodeNativeBson(doc: Document): string {
  return Buffer.from(BSON.serialize(doc)).toString("base64");
}
export function decodeNativeBson(encoded: string): Document {
  return BSON.deserialize(Buffer.from(encoded, "base64"), NATIVE_BSON_READ_OPTIONS);
}
function nativeShop(value: any): number {
  // String shop IDs are not silently normalized into a different owner scope.
  const number = value?._bsontype === "Int32" ? value.value : value;
  assert.ok(Number.isSafeInteger(number) && number > 0, "Unsupported BSON shop identity");
  return number;
}
export function mapNativeMongo(doc: Document): NativeMongoOwner {
  assert.ok(typeof doc._id === "string" || doc._id?._bsontype === "ObjectId",
    "Unsupported BSON primary key");
  // Validate BEFORE BSON serialization: serialize(undefined) can otherwise
  // become null, and JS numeric promotion would invent a BSON storage type.
  typePredicates(doc, "$$ROOT", []);
  const fullStateBson = encodeNativeBson(doc);
  // Projection only. Never use this JSON-friendly representation as a document
  // replacement or full-state equality token.
  const projection = BSON.EJSON.parse(BSON.EJSON.stringify(doc), { relaxed: true });
  const nativeId = typeof doc._id === "string" ? doc._id : doc._id.toHexString();
  return { fullStateBson, target: target(nativeId, nativeShop(doc.shopId), projection.status,
    projection.softDelete, projection.provenance, projection.customFields) };
}

export function invoiceField(fields: Record<string, unknown>): InvoiceField {
  return Object.hasOwn(fields, "invoiceHours")
    ? { present: true, value: fields.invoiceHours } : { present: false };
}

/** Only the JSONB member is changed. Version, financials, raw_data and dates
 * remain untouched. Operation revisions/receipts belong in the coordinator,
 * not in the provider-owned version/contentHash fields. */
export function nativePostgresCas(before: NativePostgresOwner, next: InvoiceField) {
  if (next.present) assert.notEqual(next.value, undefined, "Undefined is not JSON metadata");
  return {
    sql: `UPDATE normalized_work_orders AS wo SET custom_fields =
      CASE WHEN $3::boolean THEN jsonb_set(custom_fields, '{invoiceHours}', $4::text::jsonb)
      ELSE custom_fields - 'invoiceHours' END
      WHERE id=$1 AND to_jsonb(wo)::text=$2
      RETURNING id, to_jsonb(wo)::text AS full_state`,
    params: [before.id, before.fullState, next.present,
      next.present ? JSON.stringify(next.value) : "null"],
  };
}

function bsonType(value: any): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (Buffer.isBuffer(value)) return "binData";
  const native: Record<string, string> = {
    ObjectId: "objectId", Int32: "int", Double: "double", Long: "long",
    Decimal128: "decimal", Binary: "binData", Timestamp: "timestamp",
    MinKey: "minKey", MaxKey: "maxKey", BSONRegExp: "regex",
  };
  if (value?._bsontype) {
    assert.ok(native[value._bsontype], "Unsupported BSON CAS type");
    return native[value._bsontype];
  }
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  // Caller must use unpromoted BSON reads; a JS number cannot reveal whether
  // the server originally stored Int32 or Double.
  assert.notEqual(typeof value, "number", "Read BSON without numeric promotion");
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, "Unsupported BSON value");
  return "object";
}
function typePredicates(value: any, expression: any, output: any[], depth = 0) {
  assert.ok(depth <= 60 && output.length < 10_000, "BSON CAS complexity cap");
  const type = bsonType(value);
  output.push({ $eq: [{ $type: expression }, type] });
  if (type === "object") {
    for (const [key, child] of Object.entries(value)) {
      typePredicates(child, { $getField: { field: { $literal: key }, input: expression } }, output, depth + 1);
    }
  } else if (type === "array") {
    value.forEach((child: any, index: number) =>
      typePredicates(child, { $arrayElemAt: [expression, index] }, output, depth + 1));
  }
}

/** Whole-document equality detects additions/removals, including missing vs
 * null. Explicit type predicates also reject numerically equal BSON drift:
 * Mongo's ordinary equality considers Int32(1), Long(1), Double(1) equivalent.
 * Run under the coordinator's write exclusion; this is not itself a fence. */
export function nativeMongoCas(before: NativeMongoOwner, next: InvoiceField) {
  const doc = decodeNativeBson(before.fullStateBson);
  const predicates: any[] = [{ $eq: ["$$ROOT", { $literal: doc }] }];
  typePredicates(doc, "$$ROOT", predicates);
  if (next.present) assert.notEqual(next.value, undefined, "Undefined is not invoice metadata");
  return {
    filter: { _id: doc._id, $expr: { $and: predicates } },
    update: next.present ? { $set: { "customFields.invoiceHours": next.value } }
      : { $unset: { "customFields.invoiceHours": "" } },
  };
}

/** Compare everything except the one authorized metadata member. This is a
 * verification aid, not an ownership lookup or permission to execute. */
export function bsonWithoutInvoice(owner: NativeMongoOwner): string {
  const doc = decodeNativeBson(owner.fullStateBson);
  delete doc.customFields.invoiceHours;
  return encodeNativeBson(doc);
}

// No environment flag can turn an incomplete adapter into a production one.
// The separately authenticated, disabled-by-default server entry lives in
// lib/invoice-repair/production-entry.ts. Schema helpers never activate it.
