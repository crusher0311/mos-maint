/**
 * Read-only by default. --apply-approved-window is an operator-only mutation.
 * Reconcile first, retain all counters/checkpoints, and replace ONLY an expired,
 * stopped permit after verifying termination of the previous Render job.
 */
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {getDb,getMongoClient} from "../lib/mongo";
import {recoveryCheckpointDigest,recoveryGrantDigest,validateEligibleHandoff} from "../lib/jwt-overnight-scheduler";
import {validateJwtOvernightGrant} from "../lib/protractor-jwt-overnight-policy";
const JOB="jwt-overnight-2026-10-07",RATE="protractor-physical-transport-v1";
const arg=(key:string)=>process.argv.find(a=>a.startsWith(`--${key}=`))?.slice(key.length+3);
async function main(){
 const apply=process.argv.includes("--apply-approved-window");
 const db=await getDb(),jobs=db.collection<any>("operator_invoice_recovery_jobs"),rates=db.collection<any>("api_rate_limits");
 const job=await jobs.findOne({_id:JOB},{maxTimeMS:5000});
 const state=await rates.findOne({_id:RATE},{maxTimeMS:5000});
 assert.ok(job&&["paused","morning-stop","needs-attention"].includes(job.status));
 const previous=state?.jwtOvernight;
 assert.equal(previous?.runId,job.runId);assert.equal(previous.stopped,true);
 const early=process.argv.includes("--approved-closed-shops-oct8");
 assert.ok(previous.expiresAt.getTime()<=Date.now() ||
   (early && ((job.stopped===true && !job.eligibleResume?.claimedBy &&
    previous.notBefore.toISOString()==="2026-10-09T03:00:00.000Z") ||
    (job.status==="paused" && previous.notBefore.toISOString()==="2026-10-08T23:00:00.000Z" &&
     previous.expiresAt.toISOString()==="2026-10-09T10:00:00.000Z"))),
   "Previous permit must expire or be an unclaimed approved continuation");
 validateJwtOvernightGrant(previous);
 const done=new Set<string>(job.completedWindowKeys??[]);
 const remaining:string[]=previous.windowKeys.filter((k:string)=>!done.has(k));
 assert.ok(remaining.length>0,"No remaining batches");
 const summary={readOnly:!apply,pendingWindows:remaining.length,
  byShop:remaining.reduce((out:Record<string,number>,key)=>{const shop=key.split(":")[0];out[shop]=(out[shop]??0)+1;return out},{}),
  outcomes:job.outcomes,consumedRequests:previous.consumedRequests,
  remainingRequests:previous.maxRequests-previous.consumedRequests,
  checkpointDigest:recoveryCheckpointDigest(job)};
 if(!apply){console.log(JSON.stringify(summary));return;}
 const renderJobId=arg("previous-render-job");
 assert.ok(/^job-[a-z0-9]+$/.test(renderJobId??""),"Previous Render job required");
 const response=await fetch(`https://api.render.com/v1/services/srv-d55jaqkhg0os73a5dd8g/jobs/${renderJobId}`,{
  headers:{Authorization:`Bearer ${process.env.RENDER_API_KEY_PROD}`},signal:AbortSignal.timeout(15000)});
 assert.ok(response.ok,"Previous process status unavailable");
 const processState=await response.json();
 assert.ok(["failed","canceled","succeeded"].includes(processState.status));
 assert.ok(processState.startCommand?.includes("scripts/run-jwt-overnight.ts"));
 const notBefore=new Date(arg("start")??""),expiresAt=new Date(arg("end")??"");
 const grant={...previous,notBefore,expiresAt}; // consumedRequests is NEVER reset
 validateJwtOvernightGrant(grant);
 assert.ok(notBefore.getTime()>=Date.now() || (early &&
   notBefore.toISOString()==="2026-10-08T23:00:00.000Z" &&
   expiresAt.toISOString()==="2026-10-09T10:00:00.000Z" && Date.now()<expiresAt.getTime()),
   "Approve a future window or the explicit closed-shop exception");
 assert.ok(!state.operatorStop?.active&&state.canary?.mode==="live"&&state.canary.workersSuspendedConfirmed);
 assert.equal(state.canary.generation,grant.canaryGeneration);
 // This subprocess is read-only and verifies both stores and archived pages.
 execFileSync(process.execPath,["--require","./scripts/_stubs/server-only-stub.cjs","--import","tsx",
  "scripts/reconcile-jwt-overnight.ts",`--job=${JOB}`],{stdio:"pipe",timeout:180000});
 const proof={approval:"eligible-shops-first",approvedAt:new Date(),renderJobId,
  checkpointDigest:summary.checkpointDigest,grantDigest:recoveryGrantDigest(grant)};
 validateEligibleHandoff({...job,status:"paused",stopped:true,eligibleResume:proof},grant,notBefore);
 const fresh=await jobs.findOne({_id:JOB},{maxTimeMS:5000});
 assert.equal(recoveryCheckpointDigest(fresh),summary.checkpointDigest);
 const permit=await rates.updateOne({_id:RATE,jwtOvernight:previous,"operatorStop.active":{$ne:true},
  "canary.mode":"live","canary.workersSuspendedConfirmed":true,"canary.generation":grant.canaryGeneration},
  {$set:{jwtOvernight:grant}});
 // Reauthorizing a stopped run inside the same approved window can be a
 // no-op on the permit. Matching the full old permit still proves the CAS.
 assert.equal(permit.matchedCount,1,"Permit changed; no resume");
 const prepared=await jobs.updateOne({_id:JOB,status:job.status,owner:job.owner,
  outcomes:job.outcomes,eligibleResume:job.eligibleResume},{$set:{
   status:"paused",stopped:true,eligibleResume:proof,start:notBefore,expires:expiresAt,
   reason:"Approved continuation window; awaiting launch"}});
 assert.equal(prepared.modifiedCount,1,"Checkpoint changed; leave permit stopped");
 console.log(JSON.stringify({...summary,prepared:true,start:notBefore,end:expiresAt}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{(await getMongoClient()).close();});
