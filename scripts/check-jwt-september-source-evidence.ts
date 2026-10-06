import postgres from "postgres";
import {readFileSync,writeFileSync} from "node:fs";
import {protractorInvoiceLaborEvidence} from "../lib/integrations/protractor/labor-evidence";
import {findCachedWorkOrdersByIds} from "../lib/data/repositories/protractor-work-orders";
import {getMongoClient} from "../lib/mongo";
import {extractProtractorServicePackages,getProtractorPackageLines} from "../lib/integrations/protractor/package-normalization";
const path="docs/reporting/jwt-701-september-reconciliation.json";
async function main(){
 const report=JSON.parse(readFileSync(path,"utf8"));
 const ns=report.comparisons.filter((n:any)=>n.included&&n.kind==="Invoice");
 const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,
 connection:{options:"-c default_transaction_read_only=on -c statement_timeout=5000"}});
 const evidence:any[]=[];
 const deadline=Date.now()+120000;
 try{
 for(let i=0;i<ns.length;i+=25){
 if(Date.now()>deadline)throw Error("Assessment deadline exceeded");
 const batch=ns.slice(i,i+25);
 const rows=await pg.unsafe(`SELECT work_order_number,provenance->'sourceIds' source_ids,
 jsonb_build_object('ID',raw_data->'rawPayload'->'ID',
 'InvoiceTime',raw_data->'rawPayload'->'InvoiceTime',
 'ServicePackages',raw_data->'rawPayload'->'ServicePackages',
 'DeferredServicePackages',raw_data->'rawPayload'->'DeferredServicePackages',
 'Summary',raw_data->'rawPayload'->'Summary',
 'Discount',raw_data->'rawPayload'->'Discount',
 'DiscountTotal',raw_data->'rawPayload'->'DiscountTotal') raw
 FROM normalized_work_orders WHERE shop_id=227 AND work_order_number=ANY($1::text[])`,
 [`{${batch.map((n:any)=>n.wo).join(",")}}`]);
 const valid=(r:any,n:any)=>r?.InvoiceTime&&Number.isFinite(Date.parse(r.InvoiceTime))&&new Date(r.InvoiceTime).toISOString().slice(0,10)===n.date;
 const missing=rows.filter(r=>!valid(r.raw,batch.find((n:any)=>n.wo===r.work_order_number)));
 const ids=missing.flatMap(r=>(r.source_ids??[]).filter((s:any)=>s.system==="protractor"&&["work_order_id","invoice_id"].includes(s.idType)).map((s:any)=>String(s.idValue)));
 const cache=ids.length?await findCachedWorkOrdersByIds(227,ids,{maxTimeMS:2000}):[];
 for(const n of batch){
 const row=rows.find(r=>r.work_order_number===n.wo);
 let raw=row?.raw,source="canonical-pg";
 if(!valid(raw,n)){
 const doc=cache.find(d=>row?.source_ids?.some((s:any)=>String(s.idValue)===String(d.workOrderId)));
 raw=doc?.rawPayload??doc?.data;source="canonical-cache";
 }
 const eligible=valid(raw,n)&&row?.source_ids?.some((s:any)=>String(s.idValue).toLowerCase()===String(raw?.ID).toLowerCase());
 const e=eligible?protractorInvoiceLaborEvidence(raw):null;
 const shape=(v:any)=>Array.isArray(v)?"array":Array.isArray(v?.ItemCollection)?"collection-array":v?.ItemCollection===null?"collection-null":v===null?"null":v===undefined?"missing":"other";
 const packages=eligible?extractProtractorServicePackages(raw):[];
 evidence.push({wo:n.wo,source:eligible?source:null,nativeHours:Number(n.hours),nativeLabor:Number(n.labor),
 sourceHeaderLabor:eligible&&typeof raw?.Summary?.LaborTotal==="number"?raw.Summary.LaborTotal:null,
 sold:e?.sold??null,presented:e?.presented??null,net:e?.net??null,
 unavailableReason:e?.sold==null?{regular:shape(raw?.ServicePackages),deferred:shape(raw?.DeferredServicePackages),
 statuses:[...new Set(packages.map((p:any)=>String(p.Status??"missing")))],
 lineTypes:[...new Set(packages.flatMap((p:any)=>getProtractorPackageLines(p).map((l:any)=>String(l.Type??l.LineType??"missing"))))]}:undefined});
 }
 }
 const supported=evidence.filter(e=>e.sold!==null);
 const oldMismatch=report.comparisons.filter((n:any)=>n.included&&!n.recovered&&n.deltaCents!==0);
 report.sourceEvidence={checkedAt:new Date().toISOString(),includedInvoices:ns.length,
 sourceMatched:evidence.filter(e=>e.source!==null).length,soldCovered:supported.length,
 soldHours:Math.round(supported.reduce((s,e)=>s+e.sold,0)*100)/100,
 nativeHoursOnCovered:Math.round(supported.reduce((s,e)=>s+e.nativeHours,0)*100)/100,
 soldMismatches:supported.filter(e=>Math.abs(e.sold-e.nativeHours)>0.005),
 netCovered:evidence.filter(e=>e.net!==null).length,
 oldHeaderMismatches:oldMismatch.length,
 oldHeaderMismatchesWithMatchingSource:evidence.filter(e=>oldMismatch.some((n:any)=>n.wo===e.wo)&&e.sourceHeaderLabor!==null&&Math.abs(e.sourceHeaderLabor-e.nativeLabor)<0.005).length,
 records:evidence};
 // Preserve the immutable pre-correction approval baseline.
 writeFileSync("docs/reporting/jwt-701-september-sold-hours-check.json",JSON.stringify(report.sourceEvidence,null,2)+"\n");
 const {records,...summary}=report.sourceEvidence;console.log(JSON.stringify(summary,null,2));
 }finally{await pg.end({timeout:5});}
}
main().catch(e=>{console.error(e.name,e.code??"source assessment failed");process.exitCode=1;}).finally(async()=>{await(await getMongoClient()).close();});
