import assert from "node:assert/strict";

export const PG_SOURCE_KEYS = {
  normalized_work_orders: "id",
  normalized_service_jobs: "id", normalized_line_items: "id", normalized_payments: "id",
  protractor_work_orders: "work_order_id", protractor_invoices: "invoice_id",
  protractor_invoice_cache: "invoice_id",
} as const;

/** Requires the reviewed (shop_id, key::text COLLATE "C") source indexes.
 * Preserve existing cursor order and digests. Select a narrow key first; never
 * serialize every candidate's potentially large raw payload before LIMIT.
 * Separate first/next/exact plans also work with generic prepared plans. */
export function pgSourceQuery(table: string, key: string | null, exact: boolean) {
  assert.ok(Object.hasOwn(PG_SOURCE_KEYS, table));
  const column = PG_SOURCE_KEYS[table as keyof typeof PG_SOURCE_KEYS];
  assert.ok(!exact || key !== null);
  const predicate = key === null ? "" : `AND ${column}::text COLLATE "C" ${exact ? "=" : ">"} $2::text COLLATE "C"`;
  // Keep $2 typed even on the first page, without an OR around the index range.
  return `WITH candidate AS MATERIALIZED (
    SELECT ${column} FROM public.${table}
    WHERE shop_id=$1 ${predicate} AND $2::text IS NOT DISTINCT FROM $2::text
    ORDER BY ${column}::text COLLATE "C" LIMIT 1
  )
  SELECT t.${column}::text AS cursor,
    CASE WHEN octet_length(to_jsonb(t)::text)<=$3 THEN to_jsonb(t)::text END AS state
  FROM candidate c JOIN public.${table} t
    ON t.shop_id=$1 AND t.${column}::text COLLATE "C"=c.${column}::text COLLATE "C"`;
}
