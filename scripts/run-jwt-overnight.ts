import {createHash,randomUUID} from "node:crypto";
import {AssertionError} from "node:assert";
import {readFileSync} from "node:fs";
import postgres from "postgres";
import {getDb,getMongoClient} from "../lib/mongo";
import {getEnterpriseByShopId} from "../lib/enterprise";
import {resolveProtractorConfig,protractorFetch} from "../lib/integrations/protractor/client";
import {runWithJwtOvernightTransport} from "../lib/integrations/protractor/jwt-overnight-context";
import {compileJwtOvernightInvoiceRequest,validateJwtOvernightGrant} from "../lib/protractor-jwt-overnight-policy";
import {verifyOvernightHeader} from "../lib/jwt-overnight-header-guard";
import {JwtRecoveryHold,recoveryHoldReason} from "../lib/jwt-overnight-holds";
import {loadActivityProfileMap} from "../lib/data/repositories/activity-profiles";
import {decideQuietWindowGate} from "../lib/integrations/activity-profile/profile";
import {JWT_RESUME_PARENT,resumeWindows} from "../lib/jwt-overnight-resume";
import {overnightTransaction,JwtRolledBackTimeout} from "../lib/jwt-overnight-transaction";
import {deferRecoveryWindow,windowReady,type RecoveryDeferral} from "../lib/jwt-recovery-deferrals";
import {oct7Resume,OCT7_PARENT,OCT7_PARENT_RUN,OCT7_CONSUMED} from "../lib/jwt-overnight-resume-oct7";
import {validateEligibleHandoff,recoveryGrantDigest,recoverySchedule,nextEligibleWindow,scheduleCheckpoint} from "../lib/jwt-overnight-scheduler";

const ELIGIBLE_RESUME=process.argv.includes("--resume-eligible-2026-10-07");
const OCT7=ELIGIBLE_RESUME||process.argv.includes("--resume-2026-10-07");
const RESUME=OCT7||process.argv.includes("--resume-2026-10-06");
const PARENT=OCT7?OCT7_PARENT:JWT_RESUME_PARENT;
const PARENT_RUN=OCT7?OCT7_PARENT_RUN:"fa7377a4-5f91-4d75-b1a6-14eb24920b3e";
const CONSUMED=OCT7?OCT7_CONSUMED:RESUME?23:0;
const JOB=OCT7?"jwt-overnight-2026-10-07":RESUME?"jwt-overnight-2026-10-06":"jwt-overnight-2026-10-05", RATE="protractor-physical-transport-v1";
let START=new Date(OCT7?"2026-10-07T23:00:00Z":RESUME?"2026-10-07T03:00:00Z":"2026-10-06T03:00:00Z"),
 END=new Date(OCT7?"2026-10-08T10:00:00Z":RESUME?"2026-10-07T10:00:00Z":"2026-10-06T10:00:00Z");
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const digest=(v:string)=>createHash("sha256").update(v).digest("hex");
async function main(){
 if(!process.env.RENDER||process.env.REPLIT_DEV_DOMAIN)throw Error("Production execution required");
 if(!ELIGIBLE_RESUME&&Date.now()>=END.getTime())throw Error("Approved overnight window expired");
 const bytes=readFileSync("docs/reporting/jwt-overnight-native-manifest.json","utf8");
 if(digest(bytes)!=="2ce9dc85edc9a2d2d849e4831111977f12c20ee6edff1adc7aab96d4ca87f615")throw Error("Manifest mismatch");
 const native=JSON.parse(bytes), db=await getDb(), jobs=db.collection<{
   _id:string; holds?:any[]; results?:any[]; status:string; start:Date; expires:Date;
   cursor:number; page:number; runId:string; manifestHash:string; createdAt:Date;
   stopped?:boolean; owner?:string; leaseUntil?:Date; startedAt?:Date; endedAt?:Date;
   reason?:string; outcomes?:Record<string,number>; parentJobId?:string;
   eligibleResume?:any;completedWindowKeys?:string[];windowPages?:Record<string,number>;completedWindows?:number;
   deferredWindows?:Record<string,RecoveryDeferral>
 }>("operator_invoice_recovery_jobs");
 const rates=db.collection<any>("api_rate_limits"), sources=db.collection<any>("operator_invoice_recovery_sources");
 if(ELIGIBLE_RESUME){
  const [job,rate]=await Promise.all([jobs.findOne({_id:JOB}),rates.findOne({_id:RATE})]);
  validateEligibleHandoff(job,rate?.jwtOvernight);
  // Only the digest-bound, operator-approved permit can authorize a later
  // night. Never infer a new window or reset consumed requests automatically.
  START=rate.jwtOvernight.notBefore;END=rate.jwtOvernight.expiresAt;
  const previous=await fetch(`https://api.render.com/v1/services/srv-d55jaqkhg0os73a5dd8g/jobs/${job!.eligibleResume.renderJobId}`,{
   headers:{Authorization:`Bearer ${process.env.RENDER_API_KEY_PROD}`},signal:AbortSignal.timeout(8000)});
  if(!previous.ok)throw Error("Prior Render process cannot be verified");
  const prior=await previous.json();
  if(!["canceled","failed","succeeded"].includes(prior.status)||
     !prior.startCommand?.includes("scripts/run-jwt-overnight.ts"))
   throw Error("Prior recovery process has not been confirmed terminated");
 }
 await jobs.updateOne({_id:JOB},{$setOnInsert:{status:"scheduled",start:START,expires:END,cursor:0,page:0,
   runId:randomUUID(),manifestHash:digest(bytes),createdAt:new Date(),...(RESUME?{parentJobId:PARENT}:{})}},{upsert:true});
 while(Date.now()<START.getTime()){if((await jobs.findOne({_id:JOB}))?.stopped)return;await sleep(30_000);}
 const owner=randomUUID();
 const leased=await jobs.findOneAndUpdate(ELIGIBLE_RESUME?
   {_id:JOB,status:"paused",stopped:true,"eligibleResume.claimedBy":{$exists:false},"eligibleResume.approval":"eligible-shops-first"}:
   {_id:JOB,status:{$in:["scheduled","running"]},stopped:{$ne:true},
    $or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lt:new Date()}}]},
   {$set:{owner,leaseUntil:END,status:"running",startedAt:new Date(),
    ...(ELIGIBLE_RESUME?{stopped:false,"eligibleResume.claimedBy":owner}: {})},
    $unset:{reason:"",endedAt:""}},{returnDocument:"after"});
 if(!leased)return;
 const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL||process.env.DATAONE_DATABASE_URL||process.env.DATABASE_URL!,{
   max:1,connect_timeout:10,connection:{options:"-c statement_timeout=5000 -c lock_timeout=2000 -c timezone=UTC"}});
 let windows=[...native.windowKeys].sort((a:string,b:string)=>{
   const rank=(k:string)=>k==="233:2026-09-01"?0:k.includes("2026-09")?1:2;
   return rank(a)-rank(b)||a.localeCompare(b);
 });
 try{
 let recorded=new Set<string>();
 if(OCT7){
  const scope=oct7Resume(await jobs.findOne({_id:PARENT}),await jobs.findOne({_id:JWT_RESUME_PARENT}),windows,digest(bytes));
  windows=scope.windows;recorded=scope.recorded;
 }else if(RESUME)windows=resumeWindows(await jobs.findOne({_id:JWT_RESUME_PARENT}),windows,digest(bytes));
 for(const r of leased.results??[])recorded.add(`${r.shopId}:${r.day}:${r.wo}`);
 const verifyWorkers=async()=>{
   if(process.env.WORKER_SCHEDULE_DISABLED!=="true")throw Error("General-worker scheduler must stay disabled");
   for(const id of ["srv-d86qipd7vvec73ahur00","srv-d8g15v3eo5us73fvajhg"]){
     const response=await fetch(`https://api.render.com/v1/services/${id}`,{
       headers:{Authorization:`Bearer ${process.env.RENDER_API_KEY_PROD}`},signal:AbortSignal.timeout(8000)});
     if(!response.ok||(await response.json()).suspended!=="suspended")throw Error("General worker suspension not verified");
   }
 };
 await verifyWorkers();
 const state=await rates.findOne({_id:RATE});
 if(state?.operatorStop?.active||state?.canary?.mode!=="live"||!state.canary.workersSuspendedConfirmed)
   throw Error("Provider safety state disallows recovery");
 const grant=ELIGIBLE_RESUME?{...state.jwtOvernight,stopped:false}:{version:1 as const,runId:leased.runId,canaryGeneration:state.canary.generation,
   manifestHash:digest(bytes),notBefore:START,expiresAt:END,windowKeys:windows,maxRequests:1000,consumedRequests:CONSUMED,stopped:false};
 if(ELIGIBLE_RESUME&&(leased.eligibleResume.grantDigest!==recoveryGrantDigest(state.jwtOvernight)||
    state.jwtOvernight?.runId!==leased.runId||state.jwtOvernight?.stopped!==true||
    state.canary.generation!==grant.canaryGeneration||
    JSON.stringify(grant.windowKeys)!==JSON.stringify(windows)))throw Error("Handoff permit changed");
 if(RESUME && !ELIGIBLE_RESUME && (state.jwtOvernight?.runId!==PARENT_RUN ||
    state.jwtOvernight?.consumedRequests!==CONSUMED || !state.jwtOvernight?.stopped))throw Error("Previous permit changed");
 validateJwtOvernightGrant(grant);
 const registered=ELIGIBLE_RESUME?
 await rates.updateOne({_id:RATE,jwtOvernight:state.jwtOvernight,"canary.generation":grant.canaryGeneration,
   "canary.mode":"live","canary.workersSuspendedConfirmed":true,"operatorStop.active":{$ne:true}},
  {$set:{"jwtOvernight.stopped":false}}):
 await rates.updateOne({_id:RATE,"canary.generation":grant.canaryGeneration,
   "canary.mode":"live","operatorStop.active":{$ne:true},
   ...(RESUME?{"jwtOvernight.runId":PARENT_RUN,"jwtOvernight.consumedRequests":CONSUMED,"jwtOvernight.stopped":true}:{}),
   $or:[{jwtOvernight:{$exists:false}},{"jwtOvernight.expiresAt":{$lte:new Date()}}]},{$set:{jwtOvernight:grant}});
 if(!registered.modifiedCount)throw Error("Existing permit must not be replaced or refunded");
 const schedule=recoverySchedule(windows,leased);
 const deferredWindows:Record<string,RecoveryDeferral>={...(leased.deferredWindows??{})};
 const closedShopApproval=START.toISOString()==="2026-10-08T23:00:00.000Z" &&
  END.toISOString()==="2026-10-09T10:00:00.000Z";
 let consecutiveTimeouts=0;
 while(schedule.completed.size<windows.length){
   if(Date.now()>=END.getTime())break;
   const [control,authority]=await Promise.all([jobs.findOne({_id:JOB}),rates.findOne({_id:RATE})]);
   if(control?.owner!==owner||control.stopped||control.status!=="running"||
      authority?.operatorStop?.active||authority?.jwtOvernight?.stopped||
      authority?.jwtOvernight?.runId!==grant.runId)throw Error("Stopped; checkpoint retained");
   await verifyWorkers();
   const pendingShops=[...new Set(windows.filter(k=>!schedule.completed.has(k)).map(k=>Number(k.split(":")[0])))];
   const profiles=await loadActivityProfileMap(pendingShops);
   const cursor=nextEligibleWindow(windows,schedule.completed,
    (shopId,key)=>windowReady(deferredWindows[key])&&
     (closedShopApproval||decideQuietWindowGate({profile:profiles.get(shopId),now:new Date(),minConfidence:.7}).eligible));
   if(cursor<0){
    if(windows.filter(k=>!schedule.completed.has(k)).every(k=>deferredWindows[k]?.exhausted))break;
    await jobs.updateOne({_id:JOB,owner},{$set:{waitingForQuietWindow:true,lastCheckedAt:new Date(),
     ...scheduleCheckpoint(windows,schedule.completed,schedule.pages)}});
    await sleep(Math.min(60_000,Math.max(0,END.getTime()-Date.now())));continue;
   }
   const [shop,day]=windows[cursor].split(":"),shopId=Number(shop);
   const enterprise=await getEnterpriseByShopId(shopId);
   if(enterprise?.name!=="JWT"||!enterprise.shopIds.map(Number).includes(shopId))throw Error("Membership changed");
   const quiet=decideQuietWindowGate({profile:profiles.get(shopId),now:new Date(),minConfidence:.7});
   if(!closedShopApproval&&!quiet.eligible)continue;
   await jobs.updateOne({_id:JOB,owner},{$set:{activeWindow:windows[cursor],waitingForQuietWindow:false,lastCheckedAt:new Date()}});
   const config=await resolveProtractorConfig(shopId);
   const request={runId:grant.runId,shopId,day,operation:"invoice-day" as const,method:"GET" as const};
   for(let page=schedule.pages[windows[cursor]]??0;page<5;page++){
     let pageTimeout:JwtRolledBackTimeout|undefined;
     let pendingInvoices=0;
     if(!closedShopApproval&&!decideQuietWindowGate({profile:profiles.get(shopId),now:new Date(),minConfidence:.7}).eligible)
       throw Error("Shop quiet window ended; checkpoint retained");
     const live=await rates.findOne({_id:RATE});
     if(Date.now()>=END.getTime()||live?.operatorStop?.active||live?.jwtOvernight?.stopped||
       (await jobs.findOne({_id:JOB}))?.stopped)throw Error("Stopped");
     if(!live?.canary?.workersSuspendedConfirmed)throw Error("Worker safety state changed");
     // Reuse the reconciled partial page, rather than refetching changing data.
     const archived=await sources.findOne({_id:`${JOB}:${shopId}:${day}:${page}`})||
       (OCT7&&cursor===0&&page===0?await sources.findOne({_id:`${PARENT}:${shopId}:${day}:${page}`}):null);
     if(OCT7&&cursor===0&&page===0&&!archived)throw Error("Reconciled source page missing");
     if(archived&&digest(JSON.stringify(archived.invoices))!==archived.sourceDigest)throw Error("Archived source changed");
     const transportOptions={priority:false,maxRetries:0,timeoutMs:45_000,deadlineAtMs:Math.min(Date.now()+50_000,END.getTime())};
     const result=archived?{ok:true,data:archived.invoices,error:undefined}:await runWithJwtOvernightTransport(live.jwtOvernight,request,()=>protractorFetch<any>(
       compileJwtOvernightInvoiceRequest(request,page).endpoint,config,{method:"GET"},0,shopId,
       transportOptions));
     if(!result.ok)throw Error(`Provider read failed; checkpoint retained: ${String(result.error??"unknown").slice(0,180)}`);
     const invoices=Array.isArray(result.data)?result.data:result.data?.ItemCollection;
     if(!Array.isArray(invoices)||invoices.length>100)throw Error("Unexpected invoice envelope");
     // A source page is durably retained before any financial write.
     await sources.updateOne({_id:`${JOB}:${shopId}:${day}:${page}`},{$setOnInsert:{
       jobId:JOB,shopId,day,page,invoices,sourceDigest:digest(JSON.stringify(invoices)),capturedAt:new Date()}},{upsert:true});
     for(const source of invoices){
       if(Date.now()>=END.getTime())throw Error("Morning stop");
       if(!decideQuietWindowGate({profile:profiles.get(shopId),now:new Date(),minConfidence:.7}).eligible)
         throw Error("Shop quiet window ended; checkpoint retained");
       const n=native.orders.find((n:any)=>n.shopId===shopId&&n.date===day&&n.wo===String(source.WorkOrderNumber));
       if(!n)continue; // Credits and non-native records never qualify.
       const outcomeKey=`${shopId}:${day}:${n.wo}`;
       if(recorded.has(outcomeKey))continue;
       let outcome="held";
       let holdReason:string|undefined;
       try{
         outcome=await overnightTransaction<string>({
          transaction:body=>pg.begin(async tx=>body(tx)),
          beforeAttempt:async(attempt)=>{
           if(Date.now()>=END.getTime()-20_000)throw Error("Morning stop; insufficient transaction headroom");
           // The page already verified authority. Recheck it before every retry,
           // without multiplying Render API requests for ordinary invoices.
           if(attempt===1)return;
           await verifyWorkers();
           const [currentRate,currentJob,currentProfiles]=await Promise.all([
            rates.findOne({_id:RATE}),jobs.findOne({_id:JOB}),loadActivityProfileMap([shopId])
           ]);
           if(currentJob?.owner!==owner||currentJob.stopped||currentJob.status!=="running"||
              !currentJob.leaseUntil||currentJob.leaseUntil.getTime()<=Date.now()||
              currentRate?.operatorStop?.active||currentRate?.jwtOvernight?.stopped||
              currentRate?.jwtOvernight?.runId!==grant.runId||
              currentRate?.canary?.mode!=="live"||currentRate?.canary?.generation!==grant.canaryGeneration)
            throw Error("Recovery authority changed; checkpoint retained");
           if(!decideQuietWindowGate({profile:currentProfiles.get(shopId),now:new Date(),minConfidence:.7}).eligible)
            throw Error("Shop quiet window ended; checkpoint retained");
           if(Date.now()>=END.getTime()-20_000)throw Error("Morning stop; insufficient transaction headroom");
          },
          log:event=>console.error(JSON.stringify({event:"jwt_recovery_transaction_failed",jobId:JOB,shopId,day,page,cursor,
           invoiceIndex:invoices.indexOf(source),...event})),
          operation:async(tx,statement)=>{
           const rows=await statement<any[]>("lookup",()=>tx.unsafe(`SELECT *,to_char(coalesce(closed_date,completed_date),'YYYY-MM-DD') business_date
             FROM normalized_work_orders WHERE shop_id=$1 AND
             work_order_number=ANY($2::text[]) LIMIT 4 FOR UPDATE`,
             [shopId,[n.wo,n.invoice,String(source.ID)]]));
           if(rows.length!==1)throw new JwtRecoveryHold("Missing or ambiguous existing identity");
           const row=rows[0];
           let amount:number;
           try{amount=verifyOvernightHeader(row,n,source,shopId);}
           catch(error){
             if(error instanceof AssertionError)throw new JwtRecoveryHold(error.message.slice(0,500));
             throw error;
           }
           if(Number(row.labor_total)===amount)return "already-matches";
           if(Date.now()>=END.getTime()-10_000)throw Error("Morning stop");
           const updated=await statement<any[]>("update",()=>tx.unsafe(`UPDATE normalized_work_orders SET labor_total=$1,
             raw_data=jsonb_set(coalesce(raw_data,'{}'::jsonb),'{laborTotal}',to_jsonb($1::numeric))
             WHERE id=$2 AND shop_id=$3 AND labor_total=$4 RETURNING id`,
             [amount,row.id,shopId,row.labor_total]));
           if(updated.length!==1)throw Error("Guarded update failed");
           return "corrected";
          }
         });
       }catch(error){
        if(error instanceof JwtRolledBackTimeout){
         pageTimeout=error;pendingInvoices++;consecutiveTimeouts++;
         // Persist the page before continuing. Never count a timeout as a hold,
         // record its invoice as completed, or advance past its source page.
         schedule.pages[windows[cursor]]=page;
         const deferred=deferRecoveryWindow(deferredWindows[windows[cursor]],page,pendingInvoices,error.phase,error.sqlState);
         const saved=await jobs.updateOne({_id:JOB,owner,status:"running",stopped:{$ne:true}},{$set:{
          [`deferredWindows.${windows[cursor]}`]:deferred,
          ...scheduleCheckpoint(windows,schedule.completed,schedule.pages)}});
         if(saved.matchedCount!==1)throw Error("Deferred checkpoint ownership lost");
         if(consecutiveTimeouts>=3)break; // cool down a database-wide brownout
         continue;
        }
        holdReason=recoveryHoldReason(error);outcome="held";
       }
       consecutiveTimeouts=0;
       await jobs.updateOne({_id:JOB,owner},{$inc:{[`outcomes.${outcome}`]:1},
         $push:{results:{shopId,wo:n.wo,day,outcome,...(holdReason?{holdReason}:{})}}});
       recorded.add(outcomeKey);
     }
     if(pageTimeout){
      deferredWindows[windows[cursor]]=deferRecoveryWindow(deferredWindows[windows[cursor]],page,pendingInvoices,pageTimeout.phase,pageTimeout.sqlState);
      await jobs.updateOne({_id:JOB,owner},{$set:{deferredWindows}});
      console.info(JSON.stringify({event:"jwt_recovery_window_deferred",jobId:JOB,shopId,day,
       ...deferredWindows[windows[cursor]]}));
      if(consecutiveTimeouts>=3){
       await sleep(Math.min(60_000,Math.max(0,END.getTime()-Date.now())));consecutiveTimeouts=0;
      }
      break; // other eligible windows continue; this page remains pending
     }
     delete deferredWindows[windows[cursor]];
     if(invoices.length<100){
      schedule.completed.add(windows[cursor]);delete schedule.pages[windows[cursor]];
      await jobs.updateOne({_id:JOB,owner},{$set:{...scheduleCheckpoint(windows,schedule.completed,schedule.pages),deferredWindows,lastProgressAt:new Date()}});
      break;
     }
     if(page===4)throw Error("Day exceeds safe pagination bound");
     schedule.pages[windows[cursor]]=page+1;
     await jobs.updateOne({_id:JOB,owner},{$set:{...scheduleCheckpoint(windows,schedule.completed,schedule.pages),deferredWindows}});
     await sleep(5000);
   }
   await sleep(5000);
 }
 await jobs.updateOne({_id:JOB,owner},{$set:{status:Date.now()>=END.getTime()?"morning-stop":
  schedule.completed.size===windows.length?"completed":"needs-attention",endedAt:new Date(),
  pendingWindows:windows.length-schedule.completed.size,deferredWindows}});
 }catch(e){await jobs.updateOne({_id:JOB,owner},{$set:{status:"paused",reason:(e as Error).message,endedAt:new Date()}});throw e;}
 finally{await rates.updateOne({_id:RATE,"jwtOvernight.runId":leased.runId},{$set:{"jwtOvernight.stopped":true}});await pg.end({timeout:5});}
}
main().catch(e=>{console.error("JWT overnight stopped:",e.message);process.exitCode=1;})
 .finally(async()=>{await(await getMongoClient()).close();});
