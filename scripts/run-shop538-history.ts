/**
 * Deliberately separate from the fleet scheduler and JWT financial recovery.
 * Only final invoice daily list reads. No provider writes, detail fan-out,
 * automatic night renewal, general-worker restart or fleet horizon changes.
 */
import {randomUUID,createHash} from "node:crypto";
import assert from "node:assert/strict";
import {getDb,getMongoClient} from "../lib/mongo";
import {resolveProtractorConfig,protractorFetch} from "../lib/integrations/protractor/client";
import {historyBindingDigest,runWithShopHistory} from "../lib/integrations/protractor/shop-history-context";
import {HISTORY_SHOP,HISTORY_FROM,HISTORY_UNTIL,HISTORY_START,HISTORY_END,historyEndpoint,validateHistoryGrant,type ShopHistoryGrant} from "../lib/protractor-shop-history-policy";
import {createIngestionService} from "../lib/integrations/core/normalized-ingestion";
import {loadActivityProfileMap} from "../lib/data/repositories/activity-profiles";
import {decideQuietWindowGate} from "../lib/integrations/activity-profile/profile";
import {extractJobIndexFromWorkOrder} from "../lib/job-index";
const JOB="shop538-history-2026-10-08",RATE="protractor-physical-transport-v1";
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const yesterday=(day:string)=>new Date(Date.parse(`${day}T00:00:00Z`)-86400000).toISOString().slice(0,10);
async function verifyWorkers(){
  assert.equal(process.env.WORKER_SCHEDULE_DISABLED,"true","General-worker scheduler must stay disabled");
  for(const id of ["srv-d86qipd7vvec73ahur00","srv-d8g15v3eo5us73fvajhg"]){
    const r=await fetch(`https://api.render.com/v1/services/${id}`,{
      headers:{Authorization:`Bearer ${process.env.RENDER_API_KEY_PROD}`},signal:AbortSignal.timeout(10000)});
    assert.ok(r.ok,"Worker status unavailable");
    assert.equal((await r.json()).suspended,"suspended","General workers must remain suspended");
  }
}
async function main(){
  assert.ok(process.env.RENDER && !process.env.REPLIT_DEV_DOMAIN,"Production execution required");
  assert.equal(process.env.NORMALIZED_INGEST_WRITE_CONCURRENCY,"1");
  const db=await getDb(),jobs=db.collection<any>("operator_history_import_jobs"),
    sources=db.collection<any>("operator_history_import_pages"),receipts=db.collection<any>("operator_history_import_receipts"),
    rates=db.collection<any>("api_rate_limits");
  if(process.argv.includes("--prepare-approved")){
    assert.ok(Date.now()<Date.parse(HISTORY_END)-60000,"Approved night has ended");
    await verifyWorkers();
    const config=await resolveProtractorConfig(HISTORY_SHOP);
    assert.ok(config.configured,"Shop-specific Protractor connection required");
    const state=await rates.findOne({_id:RATE},{maxTimeMS:5000});
    assert.ok(state?.canary?.mode==="live" && !state.operatorStop?.active && state.canary.workersSuspendedConfirmed);
    assert.ok(!state.shopHistory,"Existing history permission must not be replaced");
    assert.ok(!await jobs.findOne({_id:JOB}),"Existing job must not be reset");
    const grant:ShopHistoryGrant={version:1,shopId:HISTORY_SHOP,from:HISTORY_FROM,until:HISTORY_UNTIL,
      runId:randomUUID(),canaryGeneration:state.canary.generation,
      bindingDigest:historyBindingDigest(HISTORY_SHOP,config.connectionId),
      notBefore:new Date(HISTORY_START),expiresAt:new Date(HISTORY_END),
      maxRequests:1000,consumedRequests:0,stopped:true};
    validateHistoryGrant(grant);
    // Parked permission is harmless if creation of the matching job fails.
    const saved=await rates.updateOne({_id:RATE,shopHistory:{$exists:false},"operatorStop.active":false,
      "canary.generation":grant.canaryGeneration,"canary.mode":"live"},{$set:{shopHistory:grant}});
    assert.equal(saved.modifiedCount,1,"Admission state changed");
    await jobs.insertOne({_id:JOB,runId:grant.runId,grantDigest:hash(grant),status:"scheduled",stopped:false,
      shopId:HISTORY_SHOP,from:HISTORY_FROM,until:HISTORY_UNTIL,createdAt:new Date(),
      day:yesterday(HISTORY_UNTIL),page:0,completedDays:0,imported:0,failed:0});
    console.log(JSON.stringify({event:"shop_history_prepared",shopId:HISTORY_SHOP,from:HISTORY_FROM,
      untilExclusive:HISTORY_UNTIL,start:HISTORY_START,end:HISTORY_END,maxRequests:1000}));return;
  }
  assert.ok(Date.now()>=Date.parse(HISTORY_START) && Date.now()<Date.parse(HISTORY_END),"Outside approved night");
  await verifyWorkers();
  const state=await rates.findOne({_id:RATE},{maxTimeMS:5000});
  const job=await jobs.findOne({_id:JOB},{maxTimeMS:5000});
  const grant:ShopHistoryGrant=state?.shopHistory;validateHistoryGrant(grant);
  assert.ok(job && job.status==="scheduled" && !job.stopped && grant.stopped &&
    job.runId===grant.runId && job.grantDigest===hash(grant),"Missing operator-approved one-use job");
  const owner=randomUUID();
  const claimed=await jobs.updateOne({_id:JOB,status:"scheduled",stopped:false,runId:grant.runId},
    {$set:{status:"running",owner,startedAt:new Date()}});
  assert.equal(claimed.modifiedCount,1,"Already claimed");
  try{
    const opened=await rates.updateOne({_id:RATE,shopHistory:grant,"operatorStop.active":false,
      "canary.mode":"live","canary.generation":grant.canaryGeneration,"canary.workersSuspendedConfirmed":true},
      {$set:{"shopHistory.stopped":false}});
    assert.equal(opened.modifiedCount,1,"Permission changed");
    const service=createIngestionService(db,"protractor",HISTORY_SHOP,undefined,
      {ingestionVia:"backfill",dualWriteToJobIndex:true,dualWriteToRepairPatterns:false});
    let day=job.day,page=job.page,failures=0,attempts=0;
    let profiles=await loadActivityProfileMap([HISTORY_SHOP]),profileAt=Date.now();
    while(day>=HISTORY_FROM && Date.now()<Date.parse(HISTORY_END)-60000){
      const current=await jobs.findOne({_id:JOB},{maxTimeMS:5000});
      const live=await rates.findOne({_id:RATE},{maxTimeMS:5000});
      assert.ok(current?.owner===owner && !current.stopped && !live?.operatorStop?.active &&
        live?.shopHistory?.runId===grant.runId && !live.shopHistory.stopped,"Stopped or ownership changed");
      validateHistoryGrant(live.shopHistory);
      assert.ok(live.canary?.mode==="live" && live.canary.generation===grant.canaryGeneration &&
        live.canary.workersSuspendedConfirmed,"Fleet safety state changed");
      if(Date.now()-profileAt>60000){profiles=await loadActivityProfileMap([HISTORY_SHOP]);profileAt=Date.now();}
      // Operator confirmed this location closed for this exact one-off window.
      const closedShopApproval=grant.notBefore.toISOString()===HISTORY_START &&
        grant.expiresAt.toISOString()===HISTORY_END;
      if(!closedShopApproval && !decideQuietWindowGate({profile:profiles.get(HISTORY_SHOP),now:new Date(),minConfidence:.7}).eligible){
        await jobs.updateOne({_id:JOB,owner},{$set:{waitingForQuietWindow:true,lastCheckedAt:new Date()}});
        await sleep(30000);continue;
      }
      const config=await resolveProtractorConfig(HISTORY_SHOP);
      assert.ok(config.configured && historyBindingDigest(HISTORY_SHOP,config.connectionId)===grant.bindingDigest,"Shop connection changed");
      const pageId=`${JOB}:${day}:${page}`;
      let archived=await sources.findOne({_id:pageId},{maxTimeMS:5000});
      await jobs.updateOne({_id:JOB,owner},{$set:{day,page,waitingForQuietWindow:false,lastCheckedAt:new Date()}});
      if(!archived){
        const request={runId:grant.runId,shopId:HISTORY_SHOP,day};
        const response=await runWithShopHistory(live.shopHistory,request,()=>protractorFetch<any>(
          historyEndpoint(request,page),config,{method:"GET"},0,HISTORY_SHOP,{maxRetries:0,timeoutMs:45000}));
        if(!response.ok){
          if(++attempts>=3)throw Error("Provider reads failed repeatedly; page remains pending");
          await sleep(attempts*60000);continue;
        }
        const invoices=Array.isArray(response.data)?response.data:response.data?.ItemCollection;
        assert.ok(Array.isArray(invoices) && invoices.length<=100,"Unexpected invoice envelope");
        archived={_id:pageId,invoices,digest:hash(invoices),capturedAt:new Date()};
        await sources.insertOne(archived);
      }
      assert.equal(hash(archived.invoices),archived.digest,"Archived page changed");
      let pending=0;
      for(const invoice of archived.invoices){
        if(Date.now()>=Date.parse(HISTORY_END)-60000)throw Error("Morning cutoff; page retained");
        assert.ok(typeof invoice.ID==="string" && invoice.ID.length>0,"Invoice identity missing");
        const id=`${JOB}:${hash(invoice.ID)}`;
        if(await receipts.findOne({_id:id,status:"imported"},{projection:{_id:1},maxTimeMS:5000}))continue;
        try{
          // Do not silently complete thin list rows. Detail reads require a
          // separately reviewed scope rather than accidental fan-out.
          assert.ok(!(Number(invoice.Total)>0 && extractJobIndexFromWorkOrder(HISTORY_SHOP,invoice,"protractor").length===0),"Thin invoice; detail required");
          const result=await service.ingestWorkOrderWithAllEntities(invoice);
          assert.ok(result.workOrder.success && [...result.serviceJobs,...result.lineItems,
            ...result.payments,...result.inspections,...result.recommendations].every(r=>r.success),"Incomplete normalized ingestion");
          await receipts.updateOne({_id:id},{$set:{status:"imported",jobId:JOB,shopId:HISTORY_SHOP,day,
            sourceDigest:hash(invoice),completedAt:new Date()}},{upsert:true});
          await jobs.updateOne({_id:JOB,owner},{$inc:{imported:1},$set:{lastProgressAt:new Date()}});
        }catch{
          pending++;
          await receipts.updateOne({_id:id},{$set:{status:"pending",jobId:JOB,shopId:HISTORY_SHOP,day,
            lastFailedAt:new Date()},$inc:{attempts:1}},{upsert:true});
        }
        await sleep(100); // serial invoice normalization; shared databases stay bounded
      }
      if(pending){
        failures+=pending;
        await jobs.updateOne({_id:JOB,owner},{$set:{failed:failures,pendingOnPage:pending}});
        if(++attempts>=3)throw Error("Unresolved invoices; page retained for review");
        await sleep(attempts*60000);continue;
      }
      attempts=0;
      if(archived.invoices.length===100){
        assert.ok(page<49,"Full final page; do not silently advance");page++;
      }else{
        day=yesterday(day);page=0;
        await jobs.updateOne({_id:JOB,owner},{$inc:{completedDays:1}});
      }
      await jobs.updateOne({_id:JOB,owner},{$set:{day,page,pendingOnPage:0,lastProgressAt:new Date()}});
      console.log(JSON.stringify({event:"shop_history_progress",shopId:HISTORY_SHOP,day,page}));
      await sleep(2000);
    }
    await jobs.updateOne({_id:JOB,owner},{$set:{status:day<HISTORY_FROM?"completed":"morning-stop",endedAt:new Date()}});
  }catch(error){
    await jobs.updateOne({_id:JOB,owner},{$set:{status:"needs-attention",endedAt:new Date(),
      reason:error instanceof assert.AssertionError?String(error.message).slice(0,160):"Import stopped; checkpoint preserved"}});
    throw Error("Shop 538 history import stopped; see checkpoint");
  }finally{
    await rates.updateOne({_id:RATE,"shopHistory.runId":grant.runId},{$set:{"shopHistory.stopped":true}});
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{
  await(await getMongoClient()).close();process.exit(process.exitCode??0);
});
