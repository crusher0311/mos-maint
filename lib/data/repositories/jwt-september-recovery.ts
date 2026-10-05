import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/mongo";
import { advanceRecovery, initialRecoveryState, JWT_RECOVERY_ID, recoveryCandidates, type RecoveryDeps } from "@/lib/jwt-september-recovery";

async function stores() {
  const db=await getDb();
  return {jobs:db.collection<any>("operator_invoice_recovery_jobs"),sources:db.collection<any>("operator_invoice_recovery_sources")};
}
function publicState(job:any) {
  return {ok:true,status:!job?"idle":job.state.phase==="complete"?"complete":job.pauseRequested?"paused":"running",
    phase:job?.state.phase??"collect",sourceScanned:job?.state.offset??0,
    total:recoveryCandidates.length,processed:job?.state.outcomes.length??0,
    outcomes:(job?.state.outcomes??[]).map((x:any)=>({wo:x.wo,state:x.state,...(x.reason?{reason:x.reason}:{})})),
    ...(job?.error?{error:job.error}:{})};
}
export async function recoveryStatus() {
  const {jobs}=await stores();return publicState(await jobs.findOne({_id:JWT_RECOVERY_ID}));
}
export async function recoveryControl(action:"start"|"pause") {
  const {jobs}=await stores();
  if(action==="start") {
    await jobs.updateOne({_id:JWT_RECOVERY_ID},{$setOnInsert:{state:initialRecoveryState(),createdAt:new Date()}},{upsert:true});
    await jobs.updateOne({_id:JWT_RECOVERY_ID},{$set:{pauseRequested:false},$unset:{error:""}});
  } else await jobs.updateOne({_id:JWT_RECOVERY_ID},{$set:{pauseRequested:true}});
  return recoveryStatus();
}
export async function recoveryStep(readPage:RecoveryDeps["readPage"],recover:RecoveryDeps["recover"]) {
  const {jobs,sources}=await stores();
  const token=randomUUID();
  const job=await jobs.findOneAndUpdate({_id:JWT_RECOVERY_ID,pauseRequested:false,"state.phase":{$ne:"complete"},
    $or:[{leaseUntil:{$exists:false}},{leaseUntil:{$lt:new Date()}}]},
    {$set:{leaseToken:token,leaseUntil:new Date(Date.now()+180000)}},{returnDocument:"after"});
  if(!job) return {...await recoveryStatus(),busy:true};
  let leaseLost=false;
  const renew=setInterval(()=>{void jobs.updateOne({_id:JWT_RECOVERY_ID,leaseToken:token},
    {$set:{leaseUntil:new Date(Date.now()+180000)}}).then(r=>{if(!r.matchedCount)leaseLost=true;}).catch(()=>{leaseLost=true;});},20000);
  const key=(wo:string)=>`${JWT_RECOVERY_ID}:${wo}`;
  try {
    const state=await advanceRecovery(job.state,{
      readPage,
      saveSource:async(wo,raw,page,digest)=>{
        const id=key(wo);
        await sources.updateOne({_id:id},{$setOnInsert:{jobId:JWT_RECOVERY_ID,raw,page,digest,createdAt:new Date()}},{upsert:true});
        if(typeof raw.ID==="string") await sources.updateOne(
          {_id:`${JWT_RECOVERY_ID}:provider:${raw.ID.toLowerCase()}`},
          {$setOnInsert:{jobId:JWT_RECOVERY_ID},$addToSet:{workOrders:wo}},{upsert:true});
        const saved=await sources.findOne({_id:id},{projection:{page:1,digest:1}});
        return saved?.page===page && saved?.digest===digest;
      },
      loadSource:async wo=>{
        const source=await sources.findOne({_id:key(wo)});
        if(typeof source?.raw?.ID==="string") {
          const identity=await sources.findOne({_id:`${JWT_RECOVERY_ID}:provider:${source.raw.ID.toLowerCase()}`});
          if(identity?.workOrders?.length!==1 || identity.workOrders[0]!==wo) return null;
        }
        return source?.raw??null;
      },
      recover:async text=>{if(leaseLost)throw new Error("Lease lost");return recover(text);},
    });
    if(leaseLost) throw new Error("Lease lost");
    const saved=await jobs.updateOne({_id:JWT_RECOVERY_ID,leaseToken:token},{$set:{state,updatedAt:new Date()},$unset:{error:""}});
    if(!saved.matchedCount) throw new Error("Lease lost");
    // Never return private source payloads in progress. Successful sources are
    // preserved canonically; held source evidence remains private for review.
    const finished=state.phase==="complete"?state.outcomes:state.outcomes.slice(job.state.outcomes.length);
    const cleanup=finished.filter(o=>["applied","already-applied"].includes(o.state)).map(o=>key(o.wo));
    if(cleanup.length) await sources.deleteMany({_id:{$in:cleanup}});
  } catch {
    await jobs.updateOne({_id:JWT_RECOVERY_ID,leaseToken:token},{$set:{pauseRequested:true,
      error:"Recovery paused after a source, policy, database or lease failure. Progress is saved; resume retries the unfinished step."}});
  } finally {
    clearInterval(renew);
    await jobs.updateOne({_id:JWT_RECOVERY_ID,leaseToken:token},{$unset:{leaseToken:"",leaseUntil:""}});
  }
  return recoveryStatus();
}
