// Materialize the tenant slice before testing JSON identities. Otherwise LIMIT 1
// can favor a fleet-wide scan for an invoice which is absent from this shop.
// Preserve all source-ID types, case-insensitive IDs, and existing-row protection.
export const HISTORY_EXISTING_INVOICE_SQL = `
WITH shop_rows AS MATERIALIZED (
  SELECT id, provenance FROM normalized_work_orders WHERE shop_id=$1
)
SELECT w.id FROM shop_rows w
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(w.provenance->'sourceIds') s
  WHERE s->>'system'='protractor' AND lower(s->>'idValue')=$2
) LIMIT 1`;

export function historyFailureCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && ["57014", "53300", "55P03", "23505", "ETIMEDOUT", "ECONNRESET"].includes(code)
    ? code : "UNCLASSIFIED";
}
