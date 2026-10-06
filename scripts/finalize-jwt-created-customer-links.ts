// Completes import identities on ONLY the new customer references made by
// the approved recovery. Preserves all personal/contact fields byte-for-byte.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { captureApprovedRecoverySource } from "../lib/jwt-approved-recovery-source";
import { getAdapter } from "../lib/integrations/core/normalized-adapter";
async function main() {
  const text=readFileSync(process.argv[2],"utf8"),bundle=JSON.parse(text);
  assert.equal(bundle.shopId,227);
  const {invoices}=captureApprovedRecoverySource(bundle.invoices);
  const digest=createHash("sha256").update(text).digest("hex");
  const apply=process.argv.includes("--apply-approved");
  const adapter=getAdapter("protractor")!;
  const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,
    connection:{options:`-c statement_timeout=5000 -c lock_timeout=2000${apply?"":" -c default_transaction_read_only=on"}`}});
  try {
    const count=await pg.begin(async t=>{
      let n=0;
      for(const r of invoices) {
        const id=createHash("sha256").update(`jwt-recovery|227|customer|${r.Contact.ID}`).digest("hex").slice(0,24);
        const wo=await t.unsafe(`SELECT customer_id FROM normalized_work_orders WHERE shop_id=227
          AND work_order_number=$1 AND raw_data->'customFields'->>'jwtRecoverySourceDigest'=$2`,
          [String(r.WorkOrderNumber),digest]);
        if(wo.length!==1||wo[0].customer_id!==id) continue;
        const rows=await t.unsafe(`SELECT provenance,md5((to_jsonb(c)-'provenance')::text) AS hash
          FROM normalized_customers c WHERE shop_id=227 AND id=$1 AND raw_data->'rawPayload'->>'ID'=$2${apply?" FOR UPDATE":""}`,
          [id,r.Contact.ID]);
        assert.equal(rows.length,1);
        const storedIds=rows[0].provenance.sourceIds;
        const ids=typeof storedIds==="string"?JSON.parse(storedIds):storedIds;
        assert.ok(Array.isArray(ids));
        const additions=adapter.getSourceIds(r).filter(s=>!ids.some((x:any)=>x.system===s.system&&x.idType===s.idType&&x.idValue===s.idValue));
        if(!additions.length && Array.isArray(storedIds)) continue;
        if(apply) {
          await t.unsafe(`UPDATE normalized_customers SET provenance=jsonb_set(provenance,'{sourceIds}',$1::text::jsonb)
            WHERE id=$2 AND shop_id=227`,[JSON.stringify([...ids,...additions]),id]);
          const after=await t.unsafe(`SELECT md5((to_jsonb(c)-'provenance')::text) AS hash FROM normalized_customers c WHERE id=$1`,[id]);
          assert.equal(after[0].hash,rows[0].hash);
          const shape=await t.unsafe(`SELECT jsonb_typeof(provenance->'sourceIds') AS shape FROM normalized_customers WHERE id=$1`,[id]);
          assert.equal(shape[0].shape,"array");
        }
        n++;
      }
      return n;
    });
    console.log(JSON.stringify({apply,newCustomerImportIdentities:count,personalFieldsUnchanged:true}));
  } finally {await pg.end({timeout:5});}
}
main().catch((e)=>{console.error("Identity finalization failed; verify commit state before retrying.",
  {name:e?.name,code:e?.code,location:e?.stack?.split("\n").slice(1,3)});process.exitCode=1});
