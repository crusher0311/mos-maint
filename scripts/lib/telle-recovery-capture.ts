/** Bounded capture engine. Transport and storage are supplied, never discovered from env. */
import {canonical} from "../../lib/protractor-exports/contract";
import {recoveryProofs,TELLE_RECOVERY_ROOT} from "../../lib/protractor-telle-recovery-policy";
import {reviewReference,validateReferences,evidenceHash,type Reference,type Capture} from "./telle-recovery-review";
export interface LookupReference extends Reference {copies:{provider_id?:string}[]}
export interface CaptureIO {
  /** Reserve durably before dispatch, including failed/ambiguous requests. Never refund. */
  reserve(endpoint:string):Promise<void>;
  /** Must enforce transport-level bytes/time limits, not just JSON validation below. */
  get(endpoint:string,signal:AbortSignal):Promise<unknown>;
  checkpoint?(captures:Capture[],outcomes:{invoiceNumber:string;status:string}[]):Promise<void>;
  now():number;
}
const guid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function endpointsFor(rows:LookupReference[]){
  return [...new Set(rows.flatMap(r=>{
    const ids=[...new Set((r.copies??[]).map(x=>String(x.provider_id??"").toLowerCase()).filter(x=>guid.test(x)))];
    if(ids.length)return ids.map(id=>`/Invoice/${id}`);
    const next=new Date(Date.parse(`${r.reportDate}T00:00:00Z`)+86400000).toISOString().slice(0,10);
    return [0,100,200].map(skip=>`/Invoice/?startDate=${r.reportDate}&endDate=${next}&take=100&skip=${skip}`);
  }))].sort();
}
export function validatedLookupScope(input:unknown):LookupReference[]{
  const refs=validateReferences(input),original=input as LookupReference[];
  const rows=refs.map(r=>({...r,copies:original.find(x=>x.invoiceNumber===r.invoiceNumber)?.copies??[]}));
  if(recoveryProofs(endpointsFor(rows)).root!==TELLE_RECOVERY_ROOT)throw Error("lookup_scope_changed");
  return rows;
}
/** Also exercised with fictional references; the public CLI validates the pinned scope first. */
export async function collectInvoiceEvidence(rows:LookupReference[],io:CaptureIO){
  if(!rows.length||rows.length>233||new Set(rows.map(r=>r.invoiceNumber)).size!==rows.length)throw Error("invalid_capture_scope");
  const started=io.now(),deadline=started+1800000,allowed=new Set(endpointsFor(rows));
  const captures:Capture[]=[],outcomes:{invoiceNumber:string;status:string}[]=[];
  let requests=0;
  const request=async(endpoint:string)=>{
    if(!allowed.has(endpoint)||io.now()>=deadline||requests>=500)throw Error("capture_limit");
    requests++;
    await io.reserve(endpoint);
    if(io.now()>=deadline)throw Error("capture_deadline");
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const data=await Promise.race([io.get(endpoint,controller.signal),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{controller.abort();reject(Error("capture_timeout"));},Math.min(45000,deadline-io.now()));
      })]);
      if(io.now()>=deadline)throw Error("capture_deadline");
      if(data===undefined||Buffer.byteLength(canonical(data))>4*1024*1024)throw Error("response_too_large");
      return data as any;
    }finally{clearTimeout(timer);controller.abort();}
  };
  const uniqueWO=(r:Reference)=>rows.filter(x=>x.workOrderNumber===r.workOrderNumber).length===1;
  const identity=(r:Reference,p:any)=>String(p?.InvoiceNumber??"")===r.invoiceNumber||
    ((!p?.InvoiceNumber||String(p.InvoiceNumber)==="0")&&uniqueWO(r)&&String(p?.WorkOrderNumber)===r.workOrderNumber);
  const record=(r:LookupReference,payloads:any[],complete:boolean)=>{
    if(!complete){outcomes.push({invoiceNumber:r.invoiceNumber,status:"incomplete_list"});return;}
    const matches=payloads.filter(p=>identity(r,p)).map(payload=>({shopId:282,
      providerId:String(payload.ID).toLowerCase(),capturedAt:new Date(io.now()).toISOString(),payload}));
    if(matches.length!==1){outcomes.push({invoiceNumber:r.invoiceNumber,status:matches.length?"ambiguous":"not_found"});return;}
    const decision=reviewReference(r,matches[0],[],io.now(),uniqueWO(r));
    if(decision.status==="held"){outcomes.push({invoiceNumber:r.invoiceNumber,status:"reason" in decision?decision.reason:"invalid"});return;}
    if(captures.some(c=>c.providerId===matches[0].providerId))throw Error("capture_identity_reused");
    captures.push(matches[0]);outcomes.push({invoiceNumber:r.invoiceNumber,status:"captured"});
  };
  const byDay=new Map<string,LookupReference[]>();
  for(const r of rows){
    const ids=[...new Set((r.copies??[]).map(x=>String(x.provider_id??"").toLowerCase()).filter(x=>guid.test(x)))];
    if(!ids.length){byDay.set(r.reportDate,[...(byDay.get(r.reportDate)??[]),r]);continue;}
    const payloads=[];
    for(const id of ids){
      const raw=await request(`/Invoice/${id}`);
      if(!guid.test(String(raw?.ID))||String(raw.ID).toLowerCase()!==id)throw Error("response_identity_mismatch");
      payloads.push(raw);
    }
    record(r,payloads,true);
    await io.checkpoint?.(captures,outcomes);
  }
  for(const [day,refs] of [...byDay].sort(([a],[b])=>a.localeCompare(b))){
    const next=new Date(Date.parse(`${day}T00:00:00Z`)+86400000).toISOString().slice(0,10);
    const found:any[]=[],seen=new Set<string>();let complete=false;
    for(let page=0;page<3;page++){
      const data=await request(`/Invoice/?startDate=${day}&endDate=${next}&take=100&skip=${page*100}`);
      const items=data?.ItemCollection;
      if(!Array.isArray(items)||items.length>100)throw Error("list_shape_or_size");
      for(const raw of items){
        const id=String(raw?.ID).toLowerCase();
        if(!guid.test(id)||seen.has(id))throw Error("duplicate_or_invalid_page_identity");
        seen.add(id);
        if(refs.some(r=>identity(r,raw)))found.push(raw);
      }
      if(items.length<100){complete=true;break;}
    }
    for(const r of refs)record(r,found,complete);
    await io.checkpoint?.(captures,outcomes);
  }
  return {shopId:282,startedAt:new Date(started).toISOString(),finishedAt:new Date(io.now()).toISOString(),
    requests,captures,outcomes,captureHash:evidenceHash(captures),complete:outcomes.every(x=>x.status==="captured"),
    sourceWrites:0,deliveries:0};
}
