/** Offline evidence review only. No database, provider, delivery or mutation imports. */
import {createHash} from "node:crypto";
import {canonical} from "../../lib/protractor-exports/contract";
import {localDate} from "./telle-local-date";

export const TELLE_REFERENCE_HASH="3145da884a9a21d5b2852ed426d11f13274b24ae562fde8033d6a2104485354a";
export interface Reference {
  invoiceNumber:string; workOrderNumber:string; reportDate:string;
  expectedTotalCents:number; reportType:"Invoice"|"Credit Invoice";
}
export interface Capture {shopId:number; providerId:string; capturedAt:string; payload:Record<string,any>}
export interface Retained {
  providerId:string; invoiceNumber:string; workOrderNumber:string;
  version:string; bodyHash:string;
}
export interface Inventory {
  shopId:number; referenceHash:string; capturedAt:string;
  complete:boolean; records:Retained[];
}
export const evidenceHash=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
const guid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const stamp=(value:unknown)=>{
  if(typeof value!=="string"||!/(Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))
    throw Error("invalid_timestamp");
  return Date.parse(value);
};
export function cents(value:unknown):number {
  if(typeof value!=="number"&&typeof value!=="string")throw Error("invalid_amount");
  const m=/^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if(!m||/[1-9]/.test((m[3]??"").slice(2)))throw Error("fractional_or_invalid_amount");
  const n=BigInt(m[2])*100n+BigInt((m[3]??"").padEnd(2,"0").slice(0,2));
  const signed=m[1]?-n:n;
  if(signed>BigInt(Number.MAX_SAFE_INTEGER)||signed<BigInt(Number.MIN_SAFE_INTEGER))throw Error("unsafe_amount");
  return Number(signed);
}
export function validateReferences(input:unknown):Reference[] {
  if(!Array.isArray(input)||input.length!==233)throw Error("reference_count_changed");
  const rows:Reference[]=input.map(r=>{
    if(!r||!/^\d+$/.test(r.invoiceNumber)||!/^\d+$/.test(r.workOrderNumber)||
      !/^\d{4}-\d{2}-\d{2}$/.test(r.reportDate)||r.reportDate<"2026-01-01"||r.reportDate>"2026-11-08"||
      !Number.isSafeInteger(r.expectedTotalCents)||!["Invoice","Credit Invoice"].includes(r.reportType))
      throw Error("invalid_reference");
    return {invoiceNumber:r.invoiceNumber,workOrderNumber:r.workOrderNumber,reportDate:r.reportDate,
      expectedTotalCents:r.expectedTotalCents,reportType:r.reportType};
  }).sort((a,b)=>a.invoiceNumber.localeCompare(b.invoiceNumber));
  if(new Set(rows.map(r=>r.invoiceNumber)).size!==233||evidenceHash(rows)!==TELLE_REFERENCE_HASH)
    throw Error("reference_manifest_changed");
  return rows;
}
function fresh(at:string,now:number,maxAge:number){
  const time=stamp(at);
  if(time>now+5000||now-time>maxAge)throw Error("stale_or_future_evidence");
}
function matches(ref:Reference,raw:any,uniqueWorkOrder:boolean){
  const invoice=String(raw.InvoiceNumber??"");
  return invoice===ref.invoiceNumber||((!invoice||invoice==="0")&&uniqueWorkOrder&&String(raw.WorkOrderNumber??"")===ref.workOrderNumber);
}
export function reviewReference(ref:Reference,capture:Capture|undefined,current:Retained[],
  now:number,uniqueWorkOrder=true){
  const base={invoiceNumber:ref.invoiceNumber,kind:ref.reportType==="Credit Invoice"?"credit":"invoice",
    expectedTotalCents:ref.expectedTotalCents,writeAuthorized:false,deliveryAuthorized:false};
  const hold=(reason:string)=>({...base,status:"held",reason});
  if(!capture)return hold("missing_capture");
  try{
    fresh(capture.capturedAt,now,30*60000);
    const raw=capture.payload;
    if(capture.shopId!==282||!guid.test(capture.providerId)||!raw||
      String(raw.ID).toLowerCase()!==capture.providerId.toLowerCase())return hold("identity_or_shop_mismatch");
    if(Buffer.byteLength(canonical(raw))>512*1024)return hold("payload_too_large");
    if(!matches(ref,raw,uniqueWorkOrder))return hold("reference_mismatch");
    if(raw.WorkflowStage!=="Invoice"||
      !(base.kind==="credit"?raw.Type==="CreditSlip":["WorkOrder","Invoice"].includes(raw.Type)))
      return hold("type_or_stage_mismatch");
    // A credit's original-invoice relationship is not its own identity.
    // Leave those relationships untouched for the credit contract review.
    if(base.kind==="invoice"){
      if(raw.InvoiceID&&String(raw.InvoiceID).toLowerCase()!==capture.providerId.toLowerCase())
        return hold("conflicting_invoice_identity");
      const payments=raw.Payments?.ItemCollection;
      if(payments!==undefined&&(!Array.isArray(payments)||payments.some((p:any)=>
        p?.InvoiceID&&String(p.InvoiceID).toLowerCase()!==capture.providerId.toLowerCase())))
        return hold("conflicting_payment_identity");
    }
    stamp(raw.InvoiceTime);
    if(localDate(raw.InvoiceTime,"America/Chicago")!==ref.reportDate)return hold("date_mismatch");
    if(cents(raw.Summary?.GrandTotal)!==ref.expectedTotalCents)return hold("amount_mismatch");
    const version=stamp(raw.Header?.LastModifiedTime);
    if(version>stamp(capture.capturedAt)+5000)return hold("future_provider_version");
    const bodyHash=evidenceHash(raw),id=capture.providerId.toLowerCase();
    const related=current.filter(x=>x.providerId.toLowerCase()===id||x.invoiceNumber===ref.invoiceNumber||
      (x.workOrderNumber===ref.workOrderNumber&&(!x.invoiceNumber||x.invoiceNumber==="0")));
    if(related.some(x=>x.providerId.toLowerCase()!==id))return hold("conflicting_existing_identity");
    // Multiple stores may contain copies; do not silently choose one authoritative copy.
    if(related.length>1)return hold("multiple_existing_copies");
    const prior=related[0];
    let change="create";
    if(prior){
      const oldVersion=stamp(prior.version);
      if(oldVersion>version)return hold("newer_record_exists");
      if(prior.bodyHash===bodyHash)change="unchanged";
      else if(oldVersion===version)return hold("same_version_conflict");
      else change="update";
    }
    // Credits remain a distinct review lane, never an implicit work-order import.
    return {...base,status:base.kind==="credit"?"credit_review_required":"reviewable",
      proposedChange:change,providerId:id,bodyHash,sourceVersion:raw.Header.LastModifiedTime,
      expectedBefore:prior?{version:prior.version,bodyHash:prior.bodyHash}:null,
      serviceHistoryAuthorized:false};
  }catch(e){return hold(e instanceof Error?e.message:"invalid_evidence");}
}
export function buildRecoveryReview(input:unknown,captures:Capture[],inventory:Inventory,now=Date.now()){
  const refs=validateReferences(input);
  if(!Number.isFinite(now)||inventory.shopId!==282||inventory.referenceHash!==TELLE_REFERENCE_HASH||
    inventory.complete!==true||!Array.isArray(inventory.records)||inventory.records.length>1000)
    throw Error("incomplete_or_wrong_inventory");
  fresh(inventory.capturedAt,now,5*60000);
  if(!Array.isArray(captures)||captures.length>233)throw Error("capture_budget");
  const seen=new Set<string>();
  for(const c of captures){
    if(!c||!guid.test(c.providerId)||seen.has(c.providerId.toLowerCase()))throw Error("duplicate_or_invalid_capture");
    seen.add(c.providerId.toLowerCase());
    if(c.shopId!==282||!refs.some(r=>matches(r,c.payload,refs.filter(x=>x.workOrderNumber===r.workOrderNumber).length===1)))
      throw Error("out_of_scope_capture");
  }
  for(const r of inventory.records){
    if(!r||!guid.test(r.providerId)||!/^[a-f0-9]{64}$/.test(r.bodyHash)||
      typeof r.invoiceNumber!=="string"||typeof r.workOrderNumber!=="string")throw Error("invalid_inventory_record");
    stamp(r.version);
    if(!refs.some(ref=>r.invoiceNumber===ref.invoiceNumber||r.workOrderNumber===ref.workOrderNumber))
      throw Error("out_of_scope_inventory");
  }
  const results=refs.map(ref=>{
    const unique=refs.filter(x=>x.workOrderNumber===ref.workOrderNumber).length===1;
    const candidates=captures.filter(c=>matches(ref,c.payload,unique));
    if(candidates.length>1)return {invoiceNumber:ref.invoiceNumber,status:"held",reason:"ambiguous_capture",
      writeAuthorized:false,deliveryAuthorized:false};
    return reviewReference(ref,candidates[0],inventory.records,now,unique);
  });
  return {mode:"offline_review",shopId:282,referenceHash:TELLE_REFERENCE_HASH,
    inputEvidenceHash:evidenceHash({captures,inventory}),generatedAt:new Date(now).toISOString(),
    writeAuthorized:false,deliveryAuthorized:false,providerRequests:0,
    counts:results.reduce<Record<string,number>>((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{}),
    results};
}
