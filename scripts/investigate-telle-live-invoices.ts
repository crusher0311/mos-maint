/** Approved read-only investigation. No cache writes, ingestion or delivery. */
import {readFile,writeFile} from "node:fs/promises";
import {localDate} from "./lib/telle-local-date";
import {recoveryProofs,TELLE_RECOVERY_ROOT} from "../lib/protractor-telle-recovery-policy";
import {runWithShopHistory,historyBindingDigest} from "../lib/integrations/protractor/shop-history-context";
const out="generated-artifacts/telle101-invoice-range-chicago";
const emit=(value:unknown)=>process.stdout.write(JSON.stringify(value)+"\n");
// The shared provider client can log response excerpts. Never expose those.
console.log=console.info=console.warn=console.error=console.debug=()=>{};
const guid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
async function main(){
  const rows:any[]=JSON.parse(await readFile(`${out}/missing-investigation.json`,"utf8"));
  const scoped=process.argv.includes("--scoped-recovery");
  const endpoints=rows.flatMap(r=>{
    const ids=[...new Set<string>(r.copies.map((x:any)=>String(x.provider_id??"").toLowerCase()).filter((x:string)=>guid.test(x)))];
    if(ids.length)return ids.map(id=>`/Invoice/${id}`);
    const next=new Date(Date.parse(`${r.reportDate}T00:00:00Z`)+86400000).toISOString().slice(0,10);
    return [0,100,200].map(skip=>`/Invoice/?startDate=${r.reportDate}&endDate=${next}&take=100&skip=${skip}`);
  });
  const manifest=recoveryProofs(endpoints);
  if(scoped&&(manifest.root!==TELLE_RECOVERY_ROOT||process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED!=="true"))
    throw Error("recovery_not_enabled");
  if(rows.length!==233||rows.some(r=>!r.reportDate?.startsWith("2026-")))throw Error("scope_invalid");
  const {resolveProtractorConfig,protractorFetch,getProtractorOutboundPolicy,getEffectiveProtractorOutboundPolicy}=await import("../lib/integrations/protractor/client");
  const policy=getProtractorOutboundPolicy();
  if(!policy.allowed){
    emit({stopped:true,reason:policy.reason,providerRequests:0});
    throw Error("local_policy_denied");
  }
  const effective=await getEffectiveProtractorOutboundPolicy();
  emit({event:"telle_access_check",allowed:effective.allowed,callbackOnly:effective.callbackOnly,
    requireTimedTrial:effective.requireTimedTrial,relayRequired:effective.relayRequired});
  if(!effective.allowed||(effective.callbackOnly&&!scoped)){
    emit({stopped:true,reason:"standalone_reads_not_permitted",providerRequests:0});
    throw Error("restricted_runtime");
  }
  const config=await resolveProtractorConfig(282);
  if(!config.configured||config.shopId!==282)throw Error("shop_unconfigured");
  const results:any[]=[];let requests=0;
  const request=async(endpoint:string)=>{
    if(++requests>500)throw Error("request_budget");
    const fetchOne=()=>protractorFetch<any>(endpoint,config,{method:"GET"},0,282,
      {maxRetries:0,timeoutMs:30000,deadlineAtMs:Date.now()+45000});
    let res;
    if(scoped){
      const {getDb}=await import("../lib/mongo");
      const state=await (await getDb()).collection("api_rate_limits").findOne(
        {_id:"protractor-physical-transport-v1" as any},{projection:{telleRecovery:1},maxTimeMS:3000});
      const grant=state?.telleRecovery;
      if(!grant||grant.bindingDigest!==historyBindingDigest(282,config.connectionId))throw Error("grant_missing_or_connection_changed");
      res=await runWithShopHistory(grant,{runId:grant.runId,shopId:282,day:"2026-01-01",
        pilot:"telleRecovery",endpoint,proof:manifest.proofs[endpoint]},fetchOne);
    }else res=await fetchOne();
    if(!res.ok){
      // Known policy denials are safe labels, never echo provider text.
      const denied=/requires approved relay|not enabled|scope|policy|paused|superseded|not active/i.test(res.error??"");
      emit({stopped:true,reason:denied?"provider_policy_denied":"provider_request_failed",requests,
        httpStatus:/^HTTP ([0-9]{3}):/.exec(res.error??"")?.[1],
        transportCategory:["timeout","deadline","rate limit","circuit breaker","relay","callback canary"]
          .find(x=>(res.error??"").toLowerCase().includes(x)),
        policyDetail:[
          ["Development Protractor traffic requires approved relay transport","development_requires_approved_relay"],
          ["Protractor outbound trial policy is not active","outbound_trial_not_active"],
          ["Protractor interactive transport is not enabled","interactive_transport_not_enabled"],
          ["Protractor callback-only transport requires a callback scope","callback_scope_required"],
          ["Protractor relay transport is required","relay_required"],
        ].find(([text])=>res.error?.includes(text))?.[1]??"not_classified",
        endpointKind:endpoint.includes("?")?"dated_invoice_list":"invoice_by_id"});
      throw Error("request_failed");
    }
    await new Promise(r=>setTimeout(r,250));
    return res.data;
  };
  const summarize=(raw:any)=>({id:raw.ID,invoiceNumber:String(raw.InvoiceNumber??""),
    workOrderNumber:String(raw.WorkOrderNumber??""),type:raw.Type,stage:raw.WorkflowStage,
    date:localDate(raw.InvoiceTime,"America/Chicago"),
    totalCents:raw.Summary?.GrandTotal==null?null:Math.round(Number(raw.Summary.GrandTotal)*100),
    hasServicePackages:Array.isArray(raw.ServicePackages?.ItemCollection)?
      raw.ServicePackages.ItemCollection.length>0:Array.isArray(raw.ServicePackages)&&raw.ServicePackages.length>0});
  const match=(r:any,raw:any)=>{
    const x=summarize(raw);
    const identity=x.invoiceNumber===r.invoiceNumber||
      ((!x.invoiceNumber||x.invoiceNumber==="0")&&x.workOrderNumber===r.workOrderNumber);
    return {...x,identityMatches:identity,dateMatches:x.date===r.reportDate,
      totalMatches:x.totalCents===r.expectedTotalCents};
  };
  const save=async()=>{
    await writeFile(`${out}/live-investigation.json`,JSON.stringify({requests,checkedAt:new Date().toISOString(),
      sourceWrites:0,azureRequests:0,results},null,2),{mode:0o600});
    emit({requests,checked:results.length,matched:results.filter(x=>x.status==="matched").length});
  };
  const noId:any[]=[];
  for(const r of rows){
    const ids=[...new Set<string>(r.copies.map((x:any)=>String(x.provider_id??"").toLowerCase()).filter((x:string)=>guid.test(x)))];
    if(!ids.length){noId.push(r);continue;}
    const observations=[];
    for(const id of ids){
      const raw=await request(`/Invoice/${id}`);
      if(!raw||String(raw.ID).toLowerCase()!==id)throw Error("identity_invalid");
      observations.push(match(r,raw));
    }
    const matched=observations.filter(x=>x.identityMatches&&x.dateMatches&&x.totalMatches);
    results.push({invoiceNumber:r.invoiceNumber,workOrderNumber:r.workOrderNumber,reportType:r.reportType,
      status:matched.length===1?"matched":"different_or_ambiguous",observations});
    await save();
    if(process.argv.includes("--probe"))return;
  }
  // Unknown GUIDs require bounded list lookup on their report dates, not an
  // unbounded history scan. Discard all unrelated customer records in memory.
  for(const day of [...new Set<string>(noId.map(r=>r.reportDate))].sort()){
    const expected=noId.filter(r=>r.reportDate===day),found=new Map<string,any>();
    const next=new Date(Date.parse(`${day}T00:00:00Z`)+86400000).toISOString().slice(0,10);
    let complete=false;
    for(let page=0;page<3;page++){
      const data=await request(`/Invoice/?startDate=${day}&endDate=${next}&take=100&skip=${page*100}`);
      if(!Array.isArray(data?.ItemCollection))throw Error("list_shape_invalid");
      for(const raw of data.ItemCollection){
        if(!guid.test(String(raw.ID)))throw Error("identity_invalid");
        if(expected.some(r=>String(raw.InvoiceNumber)===r.invoiceNumber||
          String(raw.WorkOrderNumber)===r.workOrderNumber))found.set(String(raw.ID).toLowerCase(),raw);
      }
      if(data.ItemCollection.length<100){complete=true;break;}
    }
    for(const r of expected){
      const observations=[...found.values()].filter(raw=>String(raw.InvoiceNumber)===r.invoiceNumber||
        String(raw.WorkOrderNumber)===r.workOrderNumber).map(raw=>match(r,raw));
      const matched=observations.filter(x=>x.identityMatches&&x.dateMatches&&x.totalMatches);
      results.push({invoiceNumber:r.invoiceNumber,workOrderNumber:r.workOrderNumber,reportType:r.reportType,
        status:matched.length===1&&complete?"matched":!complete?"page_budget":
          observations.length?"different_or_ambiguous":"not_in_dated_list",observations});
    }
    await save();
  }
  emit({finished:true,requests,checked:results.length,counts:results.reduce((a:any,r:any)=>
    ({...a,[r.status]:(a[r.status]??0)+1}),{}),sourceWrites:0,azureRequests:0});
}
main().then(()=>process.exit(0)).catch(()=>{emit({stopped:true,noSourceWrites:true,noAzureDelivery:true});process.exit(1)});
