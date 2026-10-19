// Requires migration 0040 BEFORE runner rollout. No scan fallback: a missing
// function/index must be resolved by an operator, not by weakening duplicate safety.
export const HISTORY_EXISTING_INVOICE_SQL = `
-- Materialize only indexed matches, not the entire shop. This prevents LIMIT 1
-- from tempting the planner into a low-startup-cost sequential scan for misses.
WITH matches AS MATERIALIZED (
SELECT id FROM normalized_work_orders
WHERE shop_id=$1 AND public.protractor_identity_keys_v1(provenance) @> ARRAY[lower($2::text)]
)
SELECT id FROM matches LIMIT 1`;

export async function requireHistoryIdentityIndex(db: {unsafe: (sql:string)=>PromiseLike<any[]>}) {
  const rows=await db.unsafe(`SELECT i.indisvalid,i.indisready,
    pg_get_expr(i.indexprs,i.indrelid) AS expression,am.amname,
    i.indpred IS NULL AS unfiltered,i.indnatts
    FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_class tbl ON tbl.oid=i.indrelid JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
    JOIN pg_am am ON am.oid=idx.relam
    WHERE idx.relname='nwo_protractor_identity_keys_v1_idx'
      AND tbl.relname='normalized_work_orders' AND ns.nspname='public'`);
  if(rows.length!==1||!rows[0].indisvalid||!rows[0].indisready||!rows[0].unfiltered||
    rows[0].indnatts!==1||rows[0].amname!=="gin"||
    !/^(public\.)?protractor_identity_keys_v1\(provenance\)$/.test(rows[0].expression??""))
    throw new Error("Valid Protractor identity index required before history runner startup");
}

export function historyFailureCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && ["57014", "53300", "55P03", "23505", "ETIMEDOUT", "ECONNRESET"].includes(code)
    ? code : "UNCLASSIFIED";
}
