/**
 * Explicit operator-approved one-time handoff. Cancels only the known waiting
 * Render job, verifies termination and an unchanged checkpoint, then parks the
 * SAME permit and job for the new scheduler. Never changes limits or outcomes.
 */
import assert from "node:assert/strict";
import {getDb,getMongoClient} from "../lib/mongo";
import {recoveryCheckpointDigest,recoveryGrantDigest,validateEligibleHandoff} from "../lib/jwt-overnight-scheduler";
const JOB="jwt-overnight-2026-10-07",RATE="protractor-physical-transport-v1";
const SERVICE="srv-d55jaqkhg0os73a5dd8g",RENDER_JOB="job-db3ci03tqb8s73de7l3g";
async function render(path:string,method="GET"){
 const response=await fetch(`https://api.render.com/v1/services/${SERVICE}/jobs/${RENDER_JOB}${path}`,{
  method,headers:{Authorization:`Bearer ${process.env.RENDER_API_KEY_PROD}`},signal:AbortSignal.timeout(15000)});
 assert.ok(response.ok,`Render status ${response.status}`);
 return response.json();
}
async function main(){
 assert.ok(process.argv.includes("--apply-approved-handoff"),"Explicit operator approval required");
 assert.ok(Date.now()<new Date("2026-10-08T05:00:00Z").getTime(),"Waiting-job handoff approval expired");
 const db=await getDb(),jobs=db.collection<any>("operator_invoice_recovery_jobs"),rates=db.collection<any>("api_rate_limits");
 const before=await jobs.findOne({_id:JOB},{maxTimeMS:5000});
 assert.equal(before?.status,"running");assert.equal(before.cursor,61);assert.equal(before.page,0);
 assert.ok(!before.stopped&&!before.eligibleResume);
 const state=await rates.findOne({_id:RATE},{maxTimeMS:5000});
 assert.equal(state?.jwtOvernight.runId,before.runId);assert.equal(state.jwtOvernight.stopped,false);
 assert.ok(!state.operatorStop?.active);
 const current=await render("");
 assert.equal(current.status,"running");
 assert.ok(current.startCommand.includes("--resume-2026-10-07"));
 const checkpointDigest=recoveryCheckpointDigest(before);
 await render("/cancel","POST");
 let terminal=false;
 for(let i=0;i<30;i++){
  if((await render("")).status==="canceled"){terminal=true;break;}
  await new Promise(r=>setTimeout(r,2000));
 }
 assert.ok(terminal,"Previous Render job is not confirmed terminated; do not resume");
 const after=await jobs.findOne({_id:JOB},{maxTimeMS:5000});
 assert.equal(recoveryCheckpointDigest(after),checkpointDigest,"Checkpoint changed during cancellation; reconcile before handoff");
 const rate=await rates.findOne({_id:RATE},{maxTimeMS:5000});
 assert.equal(recoveryGrantDigest({...rate?.jwtOvernight,stopped:false}),
  recoveryGrantDigest(state.jwtOvernight),"Permit changed during cancellation");
 const parked={...rate.jwtOvernight,stopped:true};
 const proof={approval:"eligible-shops-first",approvedAt:new Date(),renderJobId:RENDER_JOB,
  checkpointDigest,grantDigest:recoveryGrantDigest(parked)};
 validateEligibleHandoff({...after,status:"paused",stopped:true,eligibleResume:proof},parked);
 const parkedRate=await rates.updateOne({_id:RATE,jwtOvernight:rate.jwtOvernight,
  "operatorStop.active":{$ne:true},"canary.mode":"live","canary.generation":parked.canaryGeneration},
  {$set:{"jwtOvernight.stopped":true}});
 assert.equal(parkedRate.matchedCount,1,"Permit CAS failed");
 const parkedJob=await jobs.updateOne({_id:JOB,owner:after.owner,status:after.status,
  cursor:after.cursor,page:after.page,outcomes:after.outcomes,"eligibleResume":{$exists:false}},
  {$set:{status:"paused",stopped:true,endedAt:new Date(),reason:"Approved eligible-first scheduler handoff",eligibleResume:proof}});
 assert.equal(parkedJob.modifiedCount,1,"Job CAS failed; leave permit stopped");
 console.log(JSON.stringify({handoffPrepared:true,renderStatus:"canceled",cursor:after.cursor,page:after.page,
  outcomes:after.outcomes,consumedRequests:parked.consumedRequests,maxRequests:parked.maxRequests,expiresAt:parked.expiresAt}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{(await getMongoClient()).close();});
