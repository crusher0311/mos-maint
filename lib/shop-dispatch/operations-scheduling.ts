import {DispatchError,type Board} from "./model";
import {nextJobs} from "./operations";
import {availability,activeHolds,jobInterval,localParts,overlaps,slotIsFree} from "./schedule-engine";

export function assertPlanSkills(board:Board,jobId:string){
 const job=board.jobs.find(j=>j.id===jobId);
 if(!board.operationsEnabled||!job?.technicianId)return;
 const tech=board.technicians.find(t=>t.id===job.technicianId);
 const missing=job.operations?.requiredSkills.filter(key=>!tech?.skills?.some(s=>s.status==="confirmed"&&s.key.toLowerCase()===key.toLowerCase()))??[];
 if(missing.length)throw new DispatchError(409,`This technician needs manager-confirmed skills: ${missing.join(", ")}.`);
}

export function assertDependencyPlans(board:Board,changedJobId:string,now:number){
 const changed=board.jobs.find(j=>j.id===changedJobId);
 if(!changed)return;
 const affected=new Set([changedJobId]);
 for(let i=0;i<board.jobs.length;i++){
  let added=false;
  for(const j of board.jobs)if(j.prerequisites.some(id=>affected.has(id))&&!affected.has(j.id)){affected.add(j.id);added=true;}
  if(!added)break;
 }
 for(const job of board.jobs){
  if(!affected.has(job.id)||!job.plannedStart||job.status==="completed")continue;
  for(const id of job.prerequisites){
   const parent=board.jobs.find(j=>j.id===id&&j.visitId===job.visitId);
   if(!parent)throw new DispatchError(409,"A prerequisite is missing from this visit.");
   if(parent.status==="completed")continue;
   const interval=jobInterval(parent);
   if(!interval)throw new DispatchError(409,`Plan a known duration and start for "${parent.title}" before scheduling "${job.title}".`);
   const active=parent.activeMs+(parent.status==="active"&&parent.since?Math.max(0,now-Date.parse(parent.since)):0);
   const remaining=Math.max(0,interval.end-interval.start-active);
   const projectedFinish=Math.max(interval.start,now)+remaining;
   if(parent.status!=="paused"&&remaining>0&&projectedFinish<=Date.parse(job.plannedStart))continue;
   throw new DispatchError(409,`"${job.title}" cannot be planned before "${parent.title}" finishes. Review the prerequisite plan and any overruns.`);
  }
 }
}
/** Advisory: no automatic assignments. Missing shift/appointment evidence yields no recommendations. */
export function recommendNextJobs(board:Board,technicianId:string,now:number){
 const settings=board.schedule?.settings;
 if(!settings?.enabled)return [];
 const date=localParts(now,settings.timeZone).date,endDate=new Date(Date.parse(`${date}T00:00:00Z`)+86400000).toISOString().slice(0,10);
 return nextJobs(board,technicianId,now).filter(item=>{
  const job=board.jobs.find(j=>j.id===item.jobId)!;
  // Start enforcement conservatively protects every live held lane until its
  // short reservation expires; don't recommend work that Start would reject.
  if(activeHolds(board,now).some(h=>h.technicianId===technicianId||!!job.resource&&h.resourceId===job.resource))return false;
  const duration=job.estimatedMinutes??job.bookMinutes;
  if(!duration||duration<1||duration>480)return false;
  const remaining=Math.max(1,duration-job.activeMs/60000);
  // Booking lead time does not apply to a technician picking ready work now.
  // Keep the real clock for snapshot freshness and hold expiration.
  const view={...board,jobs:board.jobs.filter(j=>j.id!==job.id),schedule:{...board.schedule!,settings:{...settings,leadMinutes:0}}};
  // Deliberately keep source appointments in view: unverified/unmatched arrivals
  // must not disappear to manufacture capacity for a recommendation.
  const coverage=availability(view,{startDate:date,endDate,durationMinutes:Math.max(15,Math.ceil(remaining)),technicianId},now);
  return !coverage.reasons.length&&slotIsFree(view,{start:new Date(now).toISOString(),end:new Date(now+remaining*60000).toISOString(),technicianId,resourceId:job.resource},now);
 }).map(item=>({...item,reasons:[...item.reasons,"Configured shift, time off and known lane reservations checked"]}));
}
export function assertStartReservations(board:Board,jobId:string,now:number){
 const job=board.jobs.find(j=>j.id===jobId);if(!job)return;
 const duration=job.estimatedMinutes??job.bookMinutes;
 const end=duration&&duration>0?now+Math.max(1,duration-job.activeMs/60000)*60000:Infinity;
 const buffer=(board.schedule?.settings?.bufferMinutes??0)*60000;
 if(activeHolds(board,now).some(h=>(h.technicianId===job.technicianId||!!job.resource&&h.resourceId===job.resource)&&overlaps(now-buffer,end+buffer,Date.parse(h.start)-buffer,Date.parse(h.end)+buffer)))
  throw new DispatchError(409,"This work overlaps a scheduler hold. Release or resolve the reservation before starting.");
}
