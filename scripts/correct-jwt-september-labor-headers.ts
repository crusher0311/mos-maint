/**
 * Approved fixed-scope 216-header correction; never calls an upstream provider.
 * Default read-only. Rehearsal rolls back. Application requires a matching
 * completed rehearsal, fresh source validation and unchanged full row hashes.
 */
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import postgres from "postgres";
import {getEnterpriseByShopId} from "../lib/enterprise";
import {getMongoClient} from "../lib/mongo";
import {findCachedWorkOrdersByIds} from "../lib/data/repositories/protractor-work-orders";
import {cents,validateLaborHeaderSource} from "../lib/jwt-labor-header-correction-guard";
const report=JSON.parse(readFileSync("docs/reporting/jwt-701-september-reconciliation.json","utf8"));
const scope=report.comparisons.filter((n:any)=>n.kind==="Invoice"&&n.included&&!n.recovered&&n.deltaCents!==0);
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fingerprint=hash(scope.map((n:any)=>[n.wo,n.invoice,n.date,cents(n.labor)]).sort());
assert.equal(fingerprint,"b583e072d06b532ab1e3ac03765be05df4b94136b0d68becafa207510dacfebd",
 "Approved invoice/amount manifest changed");
const mode=process.argv[2]??"--plan";
assert.ok(["--plan","--rehearse-approved","--apply-approved"].includes(mode));
assert.equal(scope.length,216);assert.equal(new Set(scope.map((n:any)=>n.wo)).size,216);
assert.ok(scope.every((n:any)=>n.date>="2026-09-01"&&n.date<"2026-10-01"&&cents(n.storedLabor)===0));
assert.equal(scope.reduce((s:number,n:any)=>s+cents(n.labor),0),2816012);
const base="docs/reporting/jwt-701-labor-header-correction";
class RehearsalComplete extends Error{}
async function main(){
 const enterprise=await getEnterpriseByShopId(227);
 assert.equal(enterprise?.name,"JWT");
 assert.ok(enterprise.shopIds.some(id=>Number(id)===227));
 const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,
 connection:{options:`-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=30000 -c timezone=UTC${mode==="--plan"?" -c default_transaction_read_only=on":""}`}});
 const plan:any[]=[],validationFailures:any[]=[];const deadline=Date.now()+120000;
 try{
 for(let i=0;i<scope.length;i+=25){
 assert.ok(Date.now()<deadline,"Planning deadline");
 const ns=scope.slice(i,i+25);
 const rows=await pg.unsafe(`SELECT w.id,w.shop_id,w.work_order_number,w.status,w.labor_total,w.provenance,w.soft_delete,
 coalesce(w.closed_date,w.completed_date)::date::text business_date,
 w.raw_data->'customFields'->>'jwtRecoverySourceDigest' recovery_digest,
 w.raw_data->'rawPayload' source,md5(to_jsonb(w)::text) row_hash
 FROM normalized_work_orders w WHERE w.shop_id=227 AND w.work_order_number=ANY($1::text[])`,
 [`{${ns.map((n:any)=>n.wo).join(",")}}`]);
 assert.equal(rows.length,ns.length);
 const fallback=rows.filter(r=>!r.source?.InvoiceTime||!Number.isFinite(Date.parse(r.source.InvoiceTime))||
 new Date(r.source.InvoiceTime).toISOString().slice(0,10)!==ns.find((n:any)=>n.wo===r.work_order_number).date);
 const ids=fallback.flatMap(r=>(r.provenance?.sourceIds??[]).filter((s:any)=>s.system==="protractor"&&["invoice_id","work_order_id"].includes(s.idType)).map((s:any)=>String(s.idValue)));
 const cached=ids.length?await findCachedWorkOrdersByIds(227,ids,{maxTimeMS:2000}):[];
 for(const n of ns){
 const matches=rows.filter(r=>r.work_order_number===n.wo);assert.equal(matches.length,1);
 const row=matches[0];let source=row.source;
 if(fallback.includes(row)){
 const docs=cached.filter(d=>row.provenance?.sourceIds?.some((s:any)=>String(s.idValue)===String(d.workOrderId)));
 const payloads=docs.map(d=>d.rawPayload??d.data);
 assert.equal(payloads.length,1,"Ambiguous or missing canonical source");
 source=payloads[0];
 }
 try{validateLaborHeaderSource(row,n,source);}catch(e){
 if(mode!=="--plan")throw e;
 validationFailures.push({wo:n.wo,type:source?.Type,stage:source?.WorkflowStage,status:source?.Status??null,
 sourceInvoice:String(source?.InvoiceNumber),sourceWorkOrderMatches:String(source?.WorkOrderNumber)===n.wo,
 dateMatches:Number.isFinite(Date.parse(source?.InvoiceTime))&&new Date(source.InvoiceTime).toISOString().slice(0,10)===n.date,
 amountMatches:source?.Summary?.LaborTotal!=null&&cents(source.Summary.LaborTotal)===cents(n.labor),
 sourceGuidMatches:row.provenance?.sourceIds?.some((s:any)=>s.system==="protractor"&&String(s.idValue).toLowerCase()===String(source?.ID).toLowerCase()),
 reason:e instanceof assert.AssertionError?e.message:"Source validation failed"});
 continue;
 }
 plan.push({wo:n.wo,id:row.id,date:n.date,invoice:n.invoice,oldCents:cents(row.labor_total),
 sourceInvoiceNumber:String(source.InvoiceNumber),
 targetCents:cents(n.labor),rowHash:row.row_hash,
 sourceDigest:hash([source.ID,source.WorkOrderNumber,source.InvoiceNumber,source.InvoiceTime,source.Summary.LaborTotal])});
 }
 }
 if(validationFailures.length){
 writeFileSync(`${base}-validation.json`,JSON.stringify(validationFailures,null,2)+"\n");
 console.log(JSON.stringify({blocked:validationFailures.length,variants:[...new Set(validationFailures.map(({wo,reason,...v})=>JSON.stringify(v)))]}));
 throw new Error("Source validation blocked; no writes performed");
 }
 const pending=plan.filter(p=>p.oldCents!==p.targetCents);
 const planDigest=hash(plan.map(p=>[p.id,p.rowHash,p.targetCents,p.sourceDigest]).sort());
 const summary={mode,checkedAt:new Date().toISOString(),fingerprint,planDigest,
 candidates:plan.length,pending:pending.length,alreadyCorrect:plan.length-pending.length,
 correctionCents:pending.reduce((s,p)=>s+p.targetCents-p.oldCents,0),plan};
 writeFileSync(`${base}-plan.json`,JSON.stringify(summary,null,2)+"\n");
 if(mode==="--plan"||pending.length===0){console.log(JSON.stringify({...summary,plan:undefined}));return;}
 if(mode==="--apply-approved"){
 const rehearsal=JSON.parse(readFileSync(`${base}-rehearsal.json`,"utf8"));
 assert.equal(rehearsal.fingerprint,fingerprint);assert.equal(rehearsal.planDigest,planDigest);
 assert.equal(rehearsal.rolledBack,true);
 }
 let protectedVerified=false;
 try{
 await pg.begin("isolation level repeatable read",async tx=>{
 const locked=await tx.unsafe(`SELECT id,md5(to_jsonb(w)::text) row_hash,
 md5(((to_jsonb(w)-'labor_total'-'updated_at'-'raw_data')||
 jsonb_build_object('raw_data',CASE WHEN jsonb_typeof(w.raw_data)='object' THEN w.raw_data-'laborTotal' ELSE w.raw_data END))::text) protected_hash
 FROM normalized_work_orders w WHERE shop_id=227 AND id=ANY($1::text[]) ORDER BY id FOR UPDATE NOWAIT`,
 [`{${pending.map(p=>p.id).join(",")}}`]);
 assert.equal(locked.length,pending.length);
 for(const p of pending)assert.equal(locked.find(r=>r.id===p.id)?.row_hash,p.rowHash,"Concurrent record change");
 const changed=await tx.unsafe(`UPDATE normalized_work_orders w SET labor_total=v.amount,
 raw_data=CASE WHEN jsonb_typeof(w.raw_data)='object' THEN jsonb_set(w.raw_data,'{laborTotal}',to_jsonb(v.amount),true) ELSE w.raw_data END,
 updated_at=now()
 FROM jsonb_to_recordset($1::text::jsonb) AS v(id text,amount numeric)
 WHERE w.shop_id=227 AND w.id=v.id AND w.labor_total=0 RETURNING w.id`,
 [JSON.stringify(pending.map(p=>({id:p.id,amount:p.targetCents/100})))]);
 assert.equal(changed.length,pending.length);
 const after=await tx.unsafe(`SELECT id,labor_total,raw_data->>'laborTotal' mirror,
 jsonb_typeof(raw_data)='object' mirror_expected,
 md5(((to_jsonb(w)-'labor_total'-'updated_at'-'raw_data')||
 jsonb_build_object('raw_data',CASE WHEN jsonb_typeof(w.raw_data)='object' THEN w.raw_data-'laborTotal' ELSE w.raw_data END))::text) protected_hash
 FROM normalized_work_orders w WHERE shop_id=227 AND id=ANY($1::text[])`,
 [`{${pending.map(p=>p.id).join(",")}}`]);
 for(const p of pending){const r=after.find(r=>r.id===p.id)!;
 assert.equal(cents(r.labor_total),p.targetCents);if(r.mirror_expected)assert.equal(cents(r.mirror),p.targetCents);
 assert.equal(r.protected_hash,locked.find(r=>r.id===p.id)?.protected_hash,"Protected header changed");}
 protectedVerified=true;
 if(mode==="--rehearse-approved")throw new RehearsalComplete();
 });
 }catch(e){if(!(e instanceof RehearsalComplete))throw e;}
 const verify=await pg.unsafe(`SELECT id,labor_total,md5(to_jsonb(w)::text) row_hash FROM normalized_work_orders w
 WHERE shop_id=227 AND id=ANY($1::text[])`,[`{${pending.map(p=>p.id).join(",")}}`]);
 for(const p of pending){const r=verify.find(r=>r.id===p.id)!;
 assert.equal(cents(r.labor_total),mode==="--rehearse-approved"?p.oldCents:p.targetCents);
 if(mode==="--rehearse-approved")assert.equal(r.row_hash,p.rowHash,"Rehearsal did not roll back");}
 const audit={...summary,protectedVerified,rolledBack:mode==="--rehearse-approved",committed:mode==="--apply-approved"};
 writeFileSync(`${base}-${mode==="--rehearse-approved"?"rehearsal":"applied"}.json`,JSON.stringify(audit,null,2)+"\n");
 console.log(JSON.stringify({...audit,plan:undefined}));
 }finally{await pg.end({timeout:5});}
}
main().catch(e=>{console.error(e.name,e.code??"",e instanceof assert.AssertionError||e.code==="22023"?e.message:"Correction failed; inspect saved plan before any retry");process.exitCode=1;})
 .finally(async()=>{await(await getMongoClient()).close();});
