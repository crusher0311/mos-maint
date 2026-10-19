import {createHash} from "node:crypto";
import {ProtractorAdapter} from "../lib/integrations/core/normalized-adapter";
import {unwrapProtractorCollection} from "../lib/integrations/protractor/package-normalization";

const adapter=new ProtractorAdapter();
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const fields:Record<string,string[]>={
  normalized_service_jobs:["laborTotal","partsTotal","subletTotal","feesTotal","discountTotal","total",
    "laborHoursEstimated","laborHoursActual","laborHoursBilled"],
  normalized_line_items:["quantity","unitCost","unitPrice","extendedPrice","discountPercent","discountAmount",
    "taxRate","taxAmount","laborHours","laborRate","vendorCost","coreCharge"],
  normalized_payments:["amount","tipAmount","refundedAmount"],
};
export const childKinds:Record<string,string>={
  normalized_service_jobs:"service_job_id",normalized_line_items:"line_item_id",normalized_payments:"payment_id",
};
const column=(s:string)=>s.replace(/[A-Z]/g,c=>`_${c.toLowerCase()}`);
// Compare using the destination decimal scale, not floating point string formatting.
function value(v:any,field:string){
  if(v==null)return null;
  const n=Number(v);
  if(!Number.isFinite(n))throw new Error("Nonfinite financial evidence");
  return n.toFixed(field==="quantity"?3:field==="taxRate"?4:2);
}
export function financialProjection(table:string,row:any,stored=false){
  return Object.fromEntries(fields[table].map(f=>[f,value(row[stored?column(f):f],f)]));
}
export function collectChildEvidence(raws:any[],shop:number){
  const evidence=new Map<string,{owner:string;job:string|null;values:any;native:any;copy:string}[]>();
  let copy="";
  const add=(table:string,id:any,owner:string,job:string|null,mapped:any,native:any)=>{
    if(!id)return;
    const key=`${table}:${String(id).toLowerCase()}`;
    evidence.set(key,[...(evidence.get(key)??[]),{owner,job,values:financialProjection(table,mapped),native,copy}]);
  };
  for(const raw of raws){
    copy=hash(JSON.stringify(raw));
    const owner=hash(`${shop}:${String(raw.ID).toLowerCase()}`);
    // Inspect each retained occurrence independently: no latest-copy or merging override.
    for(const job of [...unwrapProtractorCollection(raw.ServicePackages),...unwrapProtractorCollection(raw.DeferredServicePackages)]){
      const id=job.ID??job.ServicePackageHeader?.ID;
      add("normalized_service_jobs",id,owner,null,adapter.mapServiceJob(shop,"",job),job);
      for(const line of adapter.extractLineItemsFromServiceJob(job)){
        add("normalized_line_items",line.ID??line.LineID,owner,String(id).toLowerCase(),
          adapter.mapLineItem(shop,"","",line),line);
      }
    }
    for(const payment of adapter.extractPaymentsFromWorkOrder(raw)){
      add("normalized_payments",payment.ID,owner,null,{
        amount:payment.Amount,tipAmount:payment.TipAmount,refundedAmount:payment.RefundedAmount,
      },payment);
    }
  }
  return evidence;
}
export function auditChild(table:string,row:any,expectedOwner:string,evidence:ReturnType<typeof collectChildEvidence>){
  const refs:any[]=(row.provenance?.sourceIds??[]).filter((s:any)=>
    s.system==="protractor"&&s.idType===childKinds[table]);
  const matches=refs.flatMap((s:any)=>evidence.get(`${table}:${String(s.idValue).toLowerCase()}`)??[]);
  const stored=financialProjection(table,row,true);
  if(!refs.length||refs.some((s:any)=>!evidence.has(`${table}:${String(s.idValue).toLowerCase()}`)))
    return {reason:"missing_source_child",stored};
  if(matches.some(m=>m.owner!==expectedOwner))return {reason:"conflicting_child_owner",stored};
  const keys=fields[table];
  const conflicts=keys.filter(f=>new Set(matches.map(m=>m.values[f])).size>1);
  if(conflicts.length)return {reason:"conflicting_child_values",fields:conflicts,stored};
  const mismatches=keys.filter(f=>stored[f]!==matches[0].values[f]);
  return {reason:mismatches.length?"stored_value_mismatch":"verified",fields:mismatches,stored,
    source:matches[0].values,sourceJobs:[...new Set(matches.map(m=>m.job))]};
}
