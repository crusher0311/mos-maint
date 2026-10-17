/** Operator-only evidence capture. No normalized-data or financial writes. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {INVOICE_RECOVERY as LIMITS} from "../lib/protractor-invoice-recovery-policy";
import {callbackQuietEvidence} from "../lib/protractor-weekend-policy";
import {runWithShopHistory} from "../lib/integrations/protractor/shop-history-context";
import {historyEndpoint,type ShopHistoryRequest} from "../lib/protractor-shop-history-policy";
import {protractorFetch} from "../lib/integrations/protractor/client";
import {pilotInvoiceIds} from "../lib/protractor-afton-pilot-report";
import {binding,collections,fleet,hash,log,RATE,recentActivity,runtime,sleep,workersSuspended} from "./protractor-weekend/shared";

async function run(){
  runtime();await workersSuspended();
  const plan=JSON.parse(readFileSync(process.argv[2],"utf8"));
  assert.equal(plan.requestCap,1000);
  assert.deepEqual(plan.shops,[227,228,229,230,231,232,233,234,235,236]);
  const groups=plan.groups.filter((g:any)=>g.day>=LIMITS.from&&g.day<LIMITS.until)
    .map((g:any)=>({shopId:g.shopId,day:g.day}));
  log("invoice_recovery_scope",{heldDateGroups:plan.groups.length-groups.length});
  assert.ok(groups.length>0&&groups.length<=10000);
  const runId=randomUUID(),owner=randomUUID(),jobId="invoice-evidence-recovery-2026-10-17";
  for(const g of groups)historyEndpoint({...g,runId,pilot:"invoiceRecovery",recoveryOwner:owner},0);
  assert.equal(new Set(groups.map((g:any)=>`${g.shopId}:${g.day}`)).size,groups.length);
  const {jobs,rates,pages}=await collections();
  const state=await rates.findOne({_id:RATE},{maxTimeMS:5000});fleet(state);
  // Never reset admissions or steal a lease. A stopped/failed run requires a reviewed resume.
  assert.ok(!state.invoiceRecovery,"Existing recovery permission: resume must preserve its budget");
  assert.ok(!await jobs.findOne({_id:jobId},{maxTimeMS:5000}),"Existing recovery checkpoint");
  const campaign=await jobs.findOne({_id:"protractor-weekend-2026-10-17"},{maxTimeMS:5000});
  assert.ok(campaign&&campaign.canaryGeneration===state.canary.generation);
  const evidence=new Map<number,Date[]>();
  const bindings=new Map<number,string>();
  for(const shop of plan.shops){
    const entry=campaign.shops.find((s:any)=>s.shopId===shop);assert.ok(entry);
    evidence.set(shop,entry.callbackEvidence.map((d:string)=>new Date(d)));
    bindings.set(shop,(await binding(shop)).digest);
  }
  if(process.argv.includes("--preflight")){
    const activity=await recentActivity();
    log("invoice_recovery_preflight",{groups:groups.length,cap:1000,
      eligibleShops:plan.shops.filter((s:number)=>callbackQuietEvidence(evidence.get(s)!,new Date())&&!activity.active.has(s)),
      delayedCallbacks:activity.delayed,providerRequests:0});
    return;
  }
  const first=groups[0],until=(d:string)=>new Date(Date.parse(d)+86400000).toISOString().slice(0,10);
  const grant={version:5,runId,owner,shopId:first.shopId,from:first.day,until:until(first.day),
    notBefore:new Date(LIMITS.start),expiresAt:new Date(LIMITS.end),
    canaryGeneration:state.canary.generation,bindingDigest:bindings.get(first.shopId),
    maxRequests:1000,consumedRequests:0,stopped:true,runnerLeaseUntil:new Date(Date.now()+120000),
    activityCheckedAt:new Date(0)};
  await jobs.insertOne({_id:jobId,runId,owner,status:"preparing",groups,planDigest:hash(groups),createdAt:new Date()});
  const admitted=await rates.updateOne({_id:RATE,invoiceRecovery:{$exists:false},
    "operatorStop.active":false,"canary.generation":state.canary.generation},{$set:{invoiceRecovery:grant}});
  assert.equal(admitted.matchedCount,1);
  let stopping=false,busy=false;
  const stop=()=>{stopping=true};process.on("SIGTERM",stop);process.on("SIGINT",stop);
  const heartbeat=setInterval(async()=>{
    if(busy||stopping)return;busy=true;
    try{
      const r=await rates.updateOne({_id:RATE,"invoiceRecovery.owner":owner,
        "invoiceRecovery.runnerLeaseUntil":{$gt:new Date()},"operatorStop.active":false},
        {$set:{"invoiceRecovery.runnerLeaseUntil":new Date(Date.now()+120000)}});
      if(r.matchedCount!==1)stopping=true;
    }catch{stopping=true}finally{busy=false}
  },30000);
  let nextRead=0,lastWorkers=Date.now(),completed=0;
  const cursors=groups.map((g:any)=>({...g,page:0,done:false,errors:0,retryAt:0}));
  try{
    await jobs.updateOne({_id:jobId,owner},{$set:{status:"running"}});
    log("invoice_recovery_running",{groups:groups.length,cap:1000});
    while(!stopping&&Date.now()<Date.parse(LIMITS.end)-180000&&completed<cursors.length){
      let worked=false;
      const deferredShops=new Set<number>();
      for(const c of cursors){
        if(stopping||Date.now()>=Date.parse(LIMITS.end)-180000)break;
        if(c.done||c.retryAt>Date.now()||deferredShops.has(c.shopId))continue;
        if(!callbackQuietEvidence(evidence.get(c.shopId)!,new Date())){deferredShops.add(c.shopId);continue;}
        await sleep(Math.max(0,nextRead-Date.now()));
        if(stopping)break;
        if(Date.now()-lastWorkers>60000){await workersSuspended();lastWorkers=Date.now();}
        const activity=await recentActivity();
        if(activity.delayed>=25){log("invoice_recovery_yield",{reason:"callback_delay"});break;}
        if(activity.active.has(c.shopId)){deferredShops.add(c.shopId);continue;}
        const current=await binding(c.shopId);assert.equal(current.digest,bindings.get(c.shopId));
        const live=await rates.findOne({_id:RATE},{maxTimeMS:5000});fleet(live);
        assert.equal(live.canary.generation,grant.canaryGeneration);
        assert.equal(live.invoiceRecovery.owner,owner);
        if(live.invoiceRecovery.consumedRequests>=1000){stopping=true;break;}
        const r:ShopHistoryRequest={runId,shopId:c.shopId,day:c.day,pilot:"invoiceRecovery",recoveryOwner:owner};
        const pageId=`${jobId}:${c.shopId}:${c.day}:${c.page}`;
        const checkpoint={shopId:c.shopId,day:c.day,page:c.page};
        try{
          let cached=await pages.findOne({_id:pageId},{maxTimeMS:5000});
          if(!cached&&c.day<"2026-10-17"&&
            campaign.shops.find((s:any)=>s.shopId===c.shopId)?.bindingDigest===current.digest){
            const existing=await pages.findOne({
              _id:`protractor-weekend-2026-10-17:${c.shopId}:${c.day}:${c.page}`,
              shopId:c.shopId,day:c.day,page:c.page,
            },{maxTimeMS:5000});
            if(existing){
              assert.equal(hash(existing.invoices),existing.digest);
              cached={_id:pageId,campaignId:jobId,...checkpoint,invoices:existing.invoices,
                digest:existing.digest,bindingDigest:current.digest,capturedAt:existing.capturedAt,
                reusedExistingPage:true};
              await pages.insertOne(cached);
            }
          }
          if(cached){
            assert.equal(hash(cached.invoices),cached.digest);
            assert.equal(cached.bindingDigest,current.digest);
            c.page++;c.done=cached.invoices.length<100;
            assert.ok(c.done||c.page<100,"Page cap reached; do not claim completion");
            if(c.done)completed++;
            await jobs.updateOne({_id:jobId,owner},{$set:{cursors,completed,lastProgressAt:new Date()}});
            worked=true;continue;
          }
          const fresh=await recentActivity();
          if(fresh.delayed>=25||fresh.active.has(c.shopId))continue;
          const ready=await rates.updateOne({_id:RATE,"invoiceRecovery.owner":owner,
            "invoiceRecovery.runnerLeaseUntil":{$gt:new Date()},"operatorStop.active":false,
            "canary.generation":grant.canaryGeneration},{$set:{
            "invoiceRecovery.shopId":c.shopId,"invoiceRecovery.from":c.day,"invoiceRecovery.until":until(c.day),
            "invoiceRecovery.bindingDigest":current.digest,"invoiceRecovery.stopped":false,
            "invoiceRecovery.activityCheckedAt":fresh.checkedAt}});
          assert.equal(ready.matchedCount,1);
          const active=(await rates.findOne({_id:RATE},{maxTimeMS:5000})).invoiceRecovery;
          nextRead=Date.now()+30000;
          const response=await runWithShopHistory(active,r,()=>protractorFetch<any>(
            historyEndpoint(r,c.page),current.config,{method:"GET"},0,c.shopId,
            {maxRetries:0,timeoutMs:10000,deadlineAtMs:Date.now()+12000}));
          assert.ok(response.ok,"Provider deferred");pilotInvoiceIds(response.data);
          const invoices=Array.isArray(response.data)?response.data:response.data.ItemCollection;
          // Captures only; NEVER call the history ingester or normalization pipeline.
          await pages.insertOne({_id:pageId,campaignId:jobId,...checkpoint,
            invoices,digest:hash(invoices),bindingDigest:current.digest,capturedAt:new Date()});
          c.errors=0;c.page++;c.done=invoices.length<100;
          assert.ok(c.done||c.page<100,"Page cap reached; do not claim completion");
          if(c.done)completed++;
          await jobs.updateOne({_id:jobId,owner},{$set:{cursors,completed,lastProgressAt:new Date()}});
          log("invoice_recovery_page",{...checkpoint,invoices:invoices.length,completed});
          worked=true;
        }catch{
          c.errors++;c.retryAt=Date.now()+15*60000;
          await jobs.updateOne({_id:jobId,owner},{$set:{cursors,lastDeferredAt:new Date()}});
          log("invoice_recovery_deferred",checkpoint);
          if(c.errors>=3){stopping=true;break;}
        }finally{
          await rates.updateOne({_id:RATE,"invoiceRecovery.owner":owner},{$set:{"invoiceRecovery.stopped":true}});
        }
      }
      if(!worked&&!stopping)await sleep(60000);
    }
  }finally{
    stopping=true;clearInterval(heartbeat);
    await rates.updateOne({_id:RATE,"invoiceRecovery.owner":owner},
      {$set:{"invoiceRecovery.stopped":true,"invoiceRecovery.runnerLeaseUntil":new Date()}});
    await jobs.updateOne({_id:jobId,owner},{$set:{status:completed===cursors.length?"captured":"paused",
      cursors,completed,endedAt:new Date()}});
    process.off("SIGTERM",stop);process.off("SIGINT",stop);
  }
}
run().then(()=>process.exit(0)).catch(e=>{
  log("invoice_recovery_stopped",{type:e?.name,code:e?.code??"GUARD"});process.exit(1);
});
