import {readFileSync,writeFileSync} from "node:fs";
import postgres from "postgres";
import {getDb,getMongoClient} from "../lib/mongo";
import {recoverJwtSource} from "./recover-jwt-approved-invoices";
const native=JSON.parse(readFileSync("/tmp/jwt-native-september.json","utf8"));
const result=JSON.parse(readFileSync("docs/reporting/jwt-701-september-recovery-results.json","utf8"));
const money=(v:any)=>Math.round(Number(v)*100);
async function main(){
 const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10,
 connection:{options:"-c default_transaction_read_only=on -c statement_timeout=5000 -c timezone=UTC"}});
 try{
 const rows:any[]=[];
 for(let i=0;i<native.length;i+=50){
 const ids=[...new Set(native.slice(i,i+50).flatMap((n:any)=>[n.wo,n.invoice]))];
 rows.push(...await pg.unsafe(`SELECT id,work_order_number,status,coalesce(closed_date,completed_date)::date::text AS "day",
 labor_total,soft_delete,vehicle_id,customer_id,provenance,
 raw_data->'customFields'->>'jwtRecoverySourceDigest' digest
 FROM normalized_work_orders WHERE shop_id=227 AND work_order_number=ANY($1::text[])`,[`{${ids.join(",")}}`]));
 }
 const stored=[...new Map(rows.map(r=>[r.id,r])).values()];
 const comparisons=native.map((n:any)=>{
 const found=stored.filter(r=>r.work_order_number===n.wo);
 const r=found.length===1?found[0]:null;
 const included=!!r&&!r.soft_delete?.isDeleted&&["closed","invoiced","paid"].includes(r.status)&&r.day===n.date;
 return {...n,included,storedStatus:r?.status??null,storedDay:r?.day??null,
 storedLabor:included&&r.labor_total!=null?String(r.labor_total):null,
 deltaCents:included&&r.labor_total!=null?money(r.labor_total)-money(n.labor):null,
 recovered:!!r?.digest,headerId:r?.id};
 });
 const hours:any[]=[];
 const parentIds=[...new Set(comparisons.filter((n:any)=>n.included).map((n:any)=>n.headerId))] as string[];
 for(let i=0;i<parentIds.length;i+=25){
 hours.push(...await pg.unsafe(`SELECT work_order_id,
 count(*) FILTER(WHERE status NOT IN ('declined','deferred'))::int jobs,
 count(*) FILTER(WHERE status NOT IN ('declined','deferred') AND labor_hours_billed IS NULL)::int missing,
 sum(labor_hours_billed) FILTER(WHERE status NOT IN ('declined','deferred'))::text hours
 FROM normalized_service_jobs WHERE shop_id=227 AND work_order_id=ANY($1::text[])
 AND NOT coalesce((soft_delete->>'isDeleted')::boolean,false) GROUP BY work_order_id`,
 [`{${parentIds.slice(i,i+25).join(",")}}`]));
 }
 for(const n of comparisons){const h=hours.find(h=>h.work_order_id===n.headerId);
 n.storedBilledHours=h?.jobs>0&&h.missing===0?h.hours:null;
 n.hoursDelta=n.storedBilledHours===null?null:Math.round((Number(n.storedBilledHours)-Number(n.hours))*10000)/10000;
 delete n.headerId;}
 const summaries=["Invoice","Credit Invoice"].map(kind=>{
 const ns=comparisons.filter((n:any)=>n.kind===kind),inc=ns.filter((n:any)=>n.included);
 return {kind,nativeCount:ns.length,included:inc.length,
 nativeHours:Math.round(ns.reduce((s:number,n:any)=>s+Number(n.hours),0)*10000)/10000,
 nativeLaborCents:ns.reduce((s:number,n:any)=>s+money(n.labor),0),
 includedNativeLaborCents:inc.reduce((s:number,n:any)=>s+money(n.labor),0),
 storedLaborCents:inc.reduce((s:number,n:any)=>s+money(n.storedLabor??0),0),
 missingStoredLabor:inc.filter((n:any)=>n.storedLabor===null).length,
 laborMismatches:inc.filter((n:any)=>n.deltaCents!==null&&n.deltaCents!==0).length,
 completeBilledHourRecords:inc.filter((n:any)=>n.storedBilledHours!==null).length,
 billedHourMismatches:inc.filter((n:any)=>n.hoursDelta!==null&&Math.abs(n.hoursDelta)>0.0001).length};
 });
 const db=await getDb(),held:any[]=[],contactIds=new Set<string>();
 for(const o of result.outcomes.filter((o:any)=>o.state==="held")){
 const doc=await db.collection("operator_invoice_recovery_sources").findOne({_id:`jwt-701-september-2026-v1:${o.wo}`} as any,{projection:{raw:1},maxTimeMS:3000});
 const r=doc?.raw,entry:any={...o,sourceAvailable:!!r};
 if(r){
 const old=stored.find(x=>x.work_order_number===o.wo);
 if(o.reason.includes("validation failed")){
 entry.financialEvidence={nativeLabor:comparisons.find((n:any)=>n.wo===o.wo)?.labor,summaryLabor:r.Summary?.LaborTotal,
 summaryDiscount:r.Summary?.DiscountTotal,
 packages:(r.ServicePackages?.ItemCollection??[]).map((p:any)=>({title:p.ServicePackageHeader?.Description??p.Description,
 invoicing:p.IsInvoicing,summary:p.PriceSummary,
 lines:(p.ServicePackageLines?.ItemCollection??[]).map((l:any)=>({type:l.Type,total:l.Total,discount:l.Discount,extended:l.ExtendedTotal}))}))};
 try{await recoverJwtSource(JSON.stringify({shopId:227,location:"701",date:comparisons.find((n:any)=>n.wo===o.wo)?.date,invoices:[r]}),{monthly:true,apply:false});entry.validation="passed read-only recheck";}
 catch(e:any){entry.validation={name:e.name,operator:e.operator,actual:typeof e.actual==="number"||typeof e.actual==="boolean"?e.actual:typeof e.actual,expected:typeof e.expected==="number"||typeof e.expected==="boolean"?e.expected:typeof e.expected};}
 }
 if(o.reason.includes("customer name")){
 const c=r.Contact,name=[c?.Name?.FirstName,c?.Name?.LastName].filter(Boolean).join(" ")||c?.FileAs||c?.Company||"";
 contactIds.add(String(c?.ID));
 const names=[...new Set([name,c?.FileAs,name.toUpperCase(),name.toLowerCase()].filter(Boolean))];
 const cs=await pg.unsafe(`SELECT id,provenance,soft_delete,
 coalesce(raw_data->'rawPayload'->'Contact'->>'ID',raw_data->'rawPayload'->>'ID') source_contact
 FROM normalized_customers WHERE shop_id=227 AND full_name=ANY($1::text[]) LIMIT 11`,[names]);
 entry.genericCashCustomerName=/cash|walk.?in|counter|retail|unknown/i.test(name);
 entry.customerCandidates=cs.map(c=>({active:!c.soft_delete?.isDeleted,providerContactMatch:c.provenance?.sourceIds?.some((x:any)=>String(x.idValue).toLowerCase()===String(r.Contact.ID).toLowerCase())??false,
 storedSourceContactMatch:String(c.source_contact??"").toLowerCase()===String(r.Contact.ID).toLowerCase()}));
 }
 if(o.reason.includes("vehicle")){
 const vin=String(r.ServiceItem?.VIN||r.ServiceItem?.Lookup||"").trim().toUpperCase();
 const vs=await pg.unsafe(`SELECT id,vin,year,make,model,soft_delete FROM normalized_vehicles WHERE shop_id=227 AND (vin=$1 OR id=$2) LIMIT 5`,[vin,old?.vehicle_id??""]);
 entry.vehicleEvidence={sourceFullVin:/^[A-HJ-NPR-Z0-9]{17}$/.test(vin),existingInvoice:!!old,
 candidates:vs.map(v=>({linked:v.id===old?.vehicle_id,active:!v.soft_delete?.isDeleted,fullVin:/^[A-HJ-NPR-Z0-9]{17}$/.test(v.vin??""),sameSourceVin:!!vin&&v.vin===vin,sameYear:Number(v.year)===Number(r.ServiceItem?.Year)}))};
 }
 if(o.reason.includes("service detail")){
 const packages=[...(r.ServicePackages?.ItemCollection??[]),...(r.DeferredServicePackages?.ItemCollection??[])];
 const js=await pg.unsafe(`SELECT id,title,status,provenance FROM normalized_service_jobs WHERE shop_id=227 AND work_order_id=$1 AND NOT coalesce((soft_delete->>'isDeleted')::boolean,false) LIMIT 501`,[old?.id??""]);
 entry.unmatchedJobs=js.filter(j=>!j.provenance?.sourceIds?.some((s:any)=>packages.some((p:any)=>String(p.ID).toLowerCase()===String(s.idValue).toLowerCase()))).map(j=>({id:j.id,title:j.title,status:j.status}));
 const ls=await pg.unsafe(`SELECT id,line_type,part_description,provenance,extended_price FROM normalized_line_items
 WHERE shop_id=227 AND work_order_id=$1 AND NOT coalesce((soft_delete->>'isDeleted')::boolean,false) LIMIT 1001`,[old?.id??""]);
 const rawLines=packages.flatMap((p:any)=>p.ServicePackageLines?.ItemCollection??[]);
 entry.unmatchedLines=ls.filter(l=>!l.provenance?.sourceIds?.some((s:any)=>rawLines.some((r:any)=>String(r.ID).toLowerCase()===String(s.idValue).toLowerCase()))).map(l=>({id:l.id,type:l.line_type,description:l.part_description,total:l.extended_price}));
 }
 }else entry.storedNumberMatches=stored.filter(x=>x.work_order_number===o.wo||x.work_order_number===comparisons.find((n:any)=>n.wo===o.wo)?.invoice).map(x=>({workOrder:x.work_order_number,status:x.status,day:x.day}));
 held.push(entry);
 }
 const report={checkedAt:new Date().toISOString(),readOnly:true,summaries,held,comparisons,distinctHeldCustomerSourceIds:contactIds.size,
 limitations:["Header labor and recorded billed hours compared with native export; not certified net labor or presented hours. Native dates lack timezone offsets.","Hours null when job evidence missing; no missing fields treated as zero.","No identity merges, history removals, provider requests or production writes."]};
 writeFileSync("docs/reporting/jwt-701-september-reconciliation.json",JSON.stringify(report,null,2)+"\n");
 console.log(JSON.stringify({summaries,held},null,2));
 }finally{await pg.end({timeout:5});}
}
main().catch(e=>{console.error(e.name,e.code,e.code==="42601"?e.message:"investigation failed");process.exitCode=1;}).finally(async()=>{await(await getMongoClient()).close();});
