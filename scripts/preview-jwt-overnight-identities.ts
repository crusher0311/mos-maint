/** Bounded read-only identity preview. Never calls the provider or writes DBs. */
import postgres from "postgres";
import {readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {getEnterpriseByShopId} from "../lib/enterprise";
import {getMongoClient} from "../lib/mongo";

async function main() {
  const bytes = readFileSync("docs/reporting/jwt-overnight-native-manifest.json");
  const manifest = JSON.parse(bytes.toString());
  const enterprise = await getEnterpriseByShopId(227);
  if (enterprise?.name !== "JWT") throw Error("Canonical enterprise unavailable");
  const members = new Set(enterprise.shopIds.map(Number));
  if (manifest.orders.length !== 12397 || manifest.orders.some((n:any) => !members.has(n.shopId))) {
    throw Error("Native scope differs from canonical membership");
  }
  const pg = postgres(process.env.SUPABASE_PROD_DATABASE_URL!, {max:1,connect_timeout:10,
    connection:{options:"-c default_transaction_read_only=on -c statement_timeout=5000 -c timezone=UTC"}});
  const rows:any[] = [];
  const legacyIdentityCells:any[] = [];
  const cells = new Map<string, any[]>();
  for (const n of manifest.orders) {
    const cell = `${n.shopId}:${n.date.slice(0,7)}`;
    cells.set(cell, [...(cells.get(cell) ?? []), n]);
  }
  const deadline = Date.now() + 120_000;
  try {
    for (const [cell,native] of cells) {
      if (Date.now() >= deadline) throw Error("Preview exceeded overall deadline");
      const month = native[0].date.slice(0,7);
      const [legacy] = await pg.unsafe(`SELECT count(*)::int stored_terminal,
        count(*) FILTER (WHERE work_order_number ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::int guid_numbered
        FROM normalized_work_orders WHERE shop_id=$1
        AND coalesce(closed_date,completed_date)>=$2
        AND coalesce(closed_date,completed_date)<$3
        AND status IN ('closed','paid','invoiced')
        AND NOT coalesce((soft_delete->>'isDeleted')::boolean,false)`,
      [native[0].shopId, `${month}-01`, month==="2026-08"?"2026-09-01":"2026-10-01"]);
      legacyIdentityCells.push({cell,...legacy});
      const numbers = [...new Set(native.flatMap(n=>[n.wo,n.invoice]))];
      if (numbers.length > 2200 || numbers.some(n=>!/^\d+$/.test(n))) throw Error("Invalid bounded cell");
      const stored = await pg.unsafe(`SELECT id,work_order_number,status,
        to_char(coalesce(closed_date,completed_date),'YYYY-MM-DD') business_date,
        labor_total,coalesce((soft_delete->>'isDeleted')::boolean,false) deleted,
        provenance->>'sourceSystem' source_system
        FROM normalized_work_orders WHERE shop_id=$1 AND work_order_number=ANY($2::text[])
        LIMIT 2201`, [native[0].shopId, `{${numbers.join(",")}}`]);
      if (stored.length > 2200) throw Error("Stored identity bound exceeded");
      const byNumber = new Map<string,any[]>();
      for (const s of stored) byNumber.set(s.work_order_number,[...(byNumber.get(s.work_order_number)??[]),s]);
      for (const n of native) {
        const match = byNumber.get(n.wo) ?? [];
        const alternate = n.invoice === n.wo ? [] : byNumber.get(n.invoice) ?? [];
        let classification: string;
        let laborCents:number|null = null;
        const s = match.length === 1 ? match[0] : null;
        if (match.length > 1) classification = "held_multiple_wo_matches";
        else if (!s) classification = alternate.length ? "absent_wo_with_number_collision" : "absent_wo";
        else if (s.deleted) classification = "held_deleted";
        else if (s.source_system !== "protractor") classification = "held_provider_unverified";
        else if (!["closed","invoiced","paid"].includes(s.status)) classification = "held_nonterminal";
        else if (s.business_date !== n.date) classification = "held_business_date_difference";
        else if (s.labor_total == null || !Number.isFinite(Number(s.labor_total))) classification = "held_missing_labor";
        else {
          const amount = Number(s.labor_total)*100;
          if (Math.abs(amount-Math.round(amount)) > .00001) classification = "held_fractional_cent_labor";
          else {
            laborCents = Math.round(amount);
            classification = laborCents === n.laborCents ? "header_matches_native" :
              laborCents === 0 ? "zero_header_requires_source_verification" : "held_nonzero_labor_difference";
          }
        }
        rows.push({shopId:n.shopId,wo:n.wo,invoice:n.invoice,date:n.date,classification,
          normalizedId:s?.id??null,storedLaborCents:laborCents,nativeLaborCents:n.laborCents,
          alternateNumberMatches:alternate.length});
      }
      console.log(JSON.stringify({cell,native:native.length,storedSample:stored.length}));
    }
  } finally {await pg.end({timeout:5});}
  const counts:Record<string,number> = {};
  for(const row of rows) counts[row.classification]=(counts[row.classification]??0)+1;
  const result = {
    checkedAt:new Date().toISOString(),readOnly:true,
    manifestSha256:createHash("sha256").update(bytes).digest("hex"),counts,legacyIdentityCells,rows,
    warning:"Number-only absence is NOT proof of missing history: legacy rows can use provider GUIDs as work_order_number. Resolve source GUIDs before create/update. This preview is not write approval or source reconciliation.",
  };
  writeFileSync("docs/reporting/jwt-overnight-identity-preview.json",JSON.stringify(result)+"\n");
  console.log(JSON.stringify({counts,readOnly:true}));
}
main().catch(e=>{console.error(e.name, "Identity preview failed; no writes made");process.exitCode=1;})
  .finally(async()=>{await(await getMongoClient()).close();});
