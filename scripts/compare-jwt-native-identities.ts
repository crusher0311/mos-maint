import postgres from "postgres";
import { readFileSync, writeFileSync } from "node:fs";

// Read-only identity investigation. Input contains only native invoice/WO IDs
// and dates, not the customer fields from the original export.
async function main() {
  const native = JSON.parse(readFileSync(process.argv[2] ?? "/tmp/jwt-701-native-identities.json", "utf8")) as {wo:string;invoice:string;date:string}[];
  if (!Array.isArray(native) || native.length > 1000 || native.some(n =>
    !/^\d+$/.test(n.wo) || !/^\d+$/.test(n.invoice) ||
    !/^09\/\d{2}\/2026$/.test(n.date))) {
    throw new Error("Expected at most 1000 numeric invoice/WO identities for September 2026");
  }
  const pg = postgres(process.env.SUPABASE_PROD_DATABASE_URL!, {
    max:1, connect_timeout:10,
    connection:{options:"-c default_transaction_read_only=on -c statement_timeout=10000"},
  });
  try {
    const matched: any[] = [];
    for (let offset=0;offset<native.length;offset+=100) {
      const ids=native.slice(offset,offset+100).flatMap(r=>[r.wo,r.invoice]);
      const rows=await pg.unsafe(`SELECT id, work_order_number,
        status, closed_date::text, completed_date::text,
        coalesce(closed_date,completed_date)::date::text business_date,
        soft_delete, provenance->'sourceIds' source_ids
        FROM normalized_work_orders
        WHERE shop_id=227 AND work_order_number=ANY($1::text[])`,
        [`{${ids.join(",")}}`]);
      matched.push(...rows);
    }
    const unique=[...new Map(matched.map(r=>[r.id,r])).values()];
    writeFileSync("/tmp/jwt-701-stored-identities.json", JSON.stringify(unique));
    const groups: Record<string, number>={};
    const dates: Record<string, Record<string,number>>={};
    const details=native.map(n=>{
      const exact=unique.filter(r=>r.work_order_number===n.wo);
      const alternatives=unique.filter(r=>r.work_order_number===n.invoice);
      const kind=!exact.length ? (alternatives.length ? "invoice_number_only_match":"absent_by_both_numbers") :
        exact.some(r=>!r.soft_delete?.isDeleted && ["closed","invoiced","paid"].includes(r.status) && r.business_date>="2026-09-01" && r.business_date<="2026-09-30") ? "included":
        exact.some(r=>r.soft_delete?.isDeleted) ? "soft_deleted":
        exact.some(r=>!["closed","invoiced","paid"].includes(r.status)) ? "nonterminal":"outside_september_or_missing_date";
      groups[kind]=(groups[kind]||0)+1;
      dates[n.date]??={}; dates[n.date][kind]=(dates[n.date][kind]||0)+1;
      return {...n,classification:kind};
    });
    writeFileSync("/tmp/jwt-701-identity-diff.json",JSON.stringify(details));
    console.log(JSON.stringify({nativeCount:native.length,matchedStoredRows:unique.length,groups,dates},null,2));
  } finally { await pg.end({timeout:5}); }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
