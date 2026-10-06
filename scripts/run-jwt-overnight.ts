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

const RESUME=process.argv.includes("--resume-2026-10-06");
const JOB=RESUME?"jwt-overnight-2026-10-06":"jwt-overnight-2026-10-05", RATE="protractor-physical-transport-v1";
const START=new Date(RESUME?"2026-10-07T03:00:00Z":"2026-10-06T03:00:00Z"),
 END=new Date(RESUME?"2026-10-07T10:00:00Z":"2026-10-06T10:00:00Z");
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const digest=(v:string)=>createHash("sha256").update(v).digest("hex");
async function main(){
 if(!process.env.RENDER||process.env.REPLIT_DEV_DOMAIN)throw Error("Production execution required");
 if(Date.now()>=END.getTime())throw Error("Approved overnight window expired");
 const bytes=readFileSync("docs/reporting/jwt-overnight-native-manifest.json","utf8");
 if(digest(bytes)!=="2ce9dc85edc9a2d2d849e4831111977f12c20ee6edff1adc7aab96d4ca87f615")throw Error("Manifest mismatch");
 const native=JSON.parse(bytes), db=await getDb(), jobs=db.collection<{
   _id:string; holds?:any[]; results?:any[]; status:string; start:Date; expires:Date;
   cursor:number; page:number; runId:string; manifestHash:string; createdAt:Date;
   stopped?:boolean; owner?:string; leaseUntil?:Date; startedAt?:Date; endedAt?:Date;
   reason?:string; outcomes?:Record<string,number>; parentJobId?:string
 }>("operator_invoice_recovery_jobs");
 const rates=db.collection<any>("api_rate_limits"), sources=db.collection<any>("operator_invoice_recovery_sources");
 await jobs.updateOne({_id:JOB},{$setOnInsert:{status:"scheduled",start:START,expires:END,cursor:0,page:0,
   runId:randomUUID(),manifestHash:digest(bytes),createdAt:new Date(),...(RESUME?{parentJobId:JWT_RESUME_PARENT}:{})}},{upsert:true});
 while(Date.now()<START.getTime()){if((await jobs.findOne({_id:JOB}))?.stopped)return;await sleep(30_000);}
 const owner=randomUUID();
 const leased=await jobs.findOneAndUpdate({_id:JOB,status:{$in:["scheduled","running"]},stopped:{$ne:true},
   $or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lt:new Date()}}]},
   {$set:{owner,leaseUntil:END,status:"running",startedAt:new Date()}},{returnDocument:"after"});
 if(!leased)return;
 const pg=postgres(process.env.SUPABASE_PROD_DATABASE_URL||process.env.DATAONE_DATABASE_URL||process.env.DATABASE_URL!,{
   max:1,connect_timeout:10,connection:{options:"-c statement_timeout=5000 -c lock_timeout=2000 -c timezone=UTC"}});
 let windows=[...native.windowKeys].sort((a:string,b:string)=>{
   const rank=(k:string)=>k==="233:2026-09-01"?0:k.includes("2026-09")?1:2;
   return rank(a)-rank(b)||a.localeCompare(b);
 });
 try{
 if(RESUME)windows=resumeWindows(await jobs.findOne({_id:JWT_RESUME_PARENT}),windows,digest(bytes));
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
 const grant={version:1 as const,runId:leased.runId,canaryGeneration:state.canary.generation,
   manifestHash:digest(bytes),notBefore:START,expiresAt:END,windowKeys:windows,maxRequests:1000,consumedRequests:RESUME?23:0,stopped:false};
 if(RESUME && (state.jwtOvernight?.runId!=="fa7377a4-5f91-4d75-b1a6-14eb24920b3e" ||
    state.jwtOvernight?.consumedRequests!==23 || !state.jwtOvernight?.stopped))throw Error("Previous permit changed");
 validateJwtOvernightGrant(grant);
 const registered=await rates.updateOne({_id:RATE,"canary.generation":grant.canaryGeneration,
   "canary.mode":"live","operatorStop.active":{$ne:true},
   ...(RESUME?{"jwtOvernight.runId":state.jwtOvernight.runId,"jwtOvernight.consumedRequests":23,"jwtOvernight.stopped":true}:{}),
   $or:[{jwtOvernight:{$exists:false}},{"jwtOvernight.expiresAt":{$lte:new Date()}}]},{$set:{jwtOvernight:grant}});
 if(!registered.modifiedCount)throw Error("Existing permit must not be replaced or refunded");
 for(let cursor=leased.cursor;cursor<windows.length;cursor++){
   if(Date.now()>=END.getTime())break;
   await verifyWorkers();
   const [shop,day]=windows[cursor].split(":"),shopId=Number(shop);
   const enterprise=await getEnterpriseByShopId(shopId);
   if(enterprise?.name!=="JWT"||!enterprise.shopIds.map(Number).includes(shopId))throw Error("Membership changed");
   const profiles=await loadActivityProfileMap([shopId]);
   const quiet=decideQuietWindowGate({profile:profiles.get(shopId),now:new Date(),minConfidence:.7});
   if(!quiet.eligible){await sleep(Math.min(60_000,Math.max(0,END.getTime()-Date.now())));cursor--;continue;}
   const config=await resolveProtractorConfig(shopId);
   const request={runId:grant.runId,shopId,day,operation:"invoice-day" as const,method:"GET" as const};
   for(let page=cursor===leased.cursor?leased.page:0;page<5;page++){
     const live=await rates.findOne({_id:RATE});
     if(Date.now()>=END.getTime()||live?.operatorStop?.active||live?.jwtOvernight?.stopped||
       (await jobs.findOne({_id:JOB}))?.stopped)throw Error("Stopped");
     if(!live?.canary?.workersSuspendedConfirmed)throw Error("Worker safety state changed");
     const transportOptions={priority:false,maxRetries:0,timeoutMs:45_000,deadlineAtMs:Math.min(Date.now()+50_000,END.getTime())};
     const result=await runWithJwtOvernightTransport(live.jwtOvernight,request,()=>protractorFetch<any>(
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
       const n=native.orders.find((n:any)=>n.shopId===shopId&&n.date===day&&n.wo===String(source.WorkOrderNumber));
       if(!n)continue; // Credits and non-native records never qualify.
       let outcome="held";
       let holdReason:string|undefined;
       try{
         await pg.begin(async tx=>{
           const rows=await tx.unsafe(`SELECT *,to_char(coalesce(closed_date,completed_date),'YYYY-MM-DD') business_date
             FROM normalized_work_orders WHERE shop_id=$1 AND
             work_order_number=ANY($2::text[]) LIMIT 4 FOR UPDATE`,
             [shopId,[n.wo,n.invoice,String(source.ID)]]);
           if(rows.length!==1)throw new JwtRecoveryHold("Missing or ambiguous existing identity");
           const row=rows[0];
           let amount:number;
           try{amount=verifyOvernightHeader(row,n,source,shopId);}
           catch(error){
             if(error instanceof AssertionError)throw new JwtRecoveryHold(error.message.slice(0,500));
             throw error;
           }
           if(Number(row.labor_total)===amount){outcome="already-matches";return;}
           if(Date.now()>=END.getTime()-10_000)throw Error("Morning stop");
           const updated=await tx.unsafe(`UPDATE normalized_work_orders SET labor_total=$1,
             raw_data=jsonb_set(coalesce(raw_data,'{}'::jsonb),'{laborTotal}',to_jsonb($1::numeric))
             WHERE id=$2 AND shop_id=$3 AND labor_total=$4 RETURNING id`,
             [amount,row.id,shopId,row.labor_total]);
           if(updated.length!==1)throw Error("Guarded update failed");
           outcome="corrected";
         });
       }catch(error){holdReason=recoveryHoldReason(error);outcome="held";}
       await jobs.updateOne({_id:JOB,owner},{$inc:{[`outcomes.${outcome}`]:1},
         $push:{results:{shopId,wo:n.wo,day,outcome,...(holdReason?{holdReason}:{})}}});
     }
     if(invoices.length<100){await jobs.updateOne({_id:JOB,owner},{$set:{cursor:cursor+1,page:0}});break;}
     if(page===4)throw Error("Day exceeds safe pagination bound");
     await jobs.updateOne({_id:JOB,owner},{$set:{cursor,page:page+1}});
     await sleep(5000);
   }
   await sleep(5000);
 }
 await jobs.updateOne({_id:JOB,owner},{$set:{status:Date.now()>=END.getTime()?"morning-stop":"completed",endedAt:new Date()}});
 }catch(e){await jobs.updateOne({_id:JOB,owner},{$set:{status:"paused",reason:(e as Error).message,endedAt:new Date()}});throw e;}
 finally{await rates.updateOne({_id:RATE,"jwtOvernight.runId":leased.runId},{$set:{"jwtOvernight.stopped":true}});await pg.end({timeout:5});}
}
main().catch(e=>{console.error("JWT overnight stopped:",e.message);process.exitCode=1;})
 .finally(async()=>{await(await getMongoClient()).close();});
