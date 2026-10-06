import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import postgres from "postgres";
import {cents} from "../lib/jwt-labor-header-correction-guard";
async function main(){
 const baseline=JSON.parse(readFileSync("docs/reporting/jwt-701-september-reconciliation.json","utf8"));
 const approved=JSON.parse(readFileSync("docs/reporting/jwt-701-labor-header-correction-applied.json","utf8"));
 assert.equal(approved.committed,true);assert.equal(approved.protectedVerified,true);
 const ns=baseline.comparisons.filter((n:any)=>n.kind==="Invoice"&&n.included);
 assert.equal(ns.length,580);
 const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,
 connection:{options:"-c default_transaction_read_only=on -c statement_timeout=5000 -c timezone=UTC"}});
 let total=0;
 try{
 for(let i=0;i<ns.length;i+=50){
 const batch=ns.slice(i,i+50);
 const rows=await pg.unsafe(`SELECT work_order_number,status,labor_total,
 coalesce(closed_date,completed_date)::date::text business_date,soft_delete
 FROM normalized_work_orders WHERE shop_id=227 AND work_order_number=ANY($1::text[])`,
 [`{${batch.map((n:any)=>n.wo).join(",")}}`]);
 assert.equal(rows.length,batch.length);
 for(const n of batch){
 const row=rows.find(r=>r.work_order_number===n.wo)!;
 assert.equal(row.status,n.storedStatus);assert.equal(row.business_date,n.date);
 assert.ok(!row.soft_delete?.isDeleted);assert.equal(cents(row.labor_total),cents(n.labor));
 total+=cents(row.labor_total);
 }
 }
 assert.equal(total,5230684);
 const result={verifiedAt:new Date().toISOString(),readOnly:true,appliedCount:approved.pending,
 correctionCents:approved.correctionCents,includedInvoices:580,laborHeaderCents:total,
 includedNativeLaborCents:5230684,mismatches:0,heldInvoices:18,heldNativeLaborCents:85191,
 creditsNotResolved:4,creditsNativeLaborCents:-53998,
 limitations:"Header labor is reconciled for included ordinary invoices only; this does not certify net discounts, hours, credits or the complete pilot."};
 writeFileSync("docs/reporting/jwt-701-labor-header-correction-verification.json",JSON.stringify(result,null,2)+"\n");
 console.log(JSON.stringify(result));
 }finally{await pg.end({timeout:5});}
}
main().catch(e=>{console.error(e.name,e.code??"",e instanceof assert.AssertionError?e.message:"Verification failed");process.exitCode=1;});
