import { DispatchError, resourcesFor, type Board, type Job } from "./model";
import type { AvailabilityQuery, AvailabilityResult, AvailableSlot, ScheduleSettings } from "./schedule-types";

export const APPOINTMENT_FRESH_MS=5*60_000;
const formatters=new Map<string,Intl.DateTimeFormat>();
export function localParts(time:number,timeZone:string){
  let formatter=formatters.get(timeZone);
  if(!formatter){formatter=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});formatters.set(timeZone,formatter);}
  const parts=Object.fromEntries(formatter.formatToParts(new Date(time)).map(p=>[p.type,p.value]));
  const date=`${parts.year}-${parts.month}-${parts.day}`;
  return {date,minute:Number(parts.hour)*60+Number(parts.minute),day:new Date(`${date}T12:00:00Z`).getUTCDay()};
}
export function validateDateRange(start:string,end:string){
  const a=Date.parse(`${start}T00:00:00Z`),b=Date.parse(`${end}T00:00:00Z`);
  if(!Number.isFinite(a)||!Number.isFinite(b)||new Date(a).toISOString().slice(0,10)!==start||new Date(b).toISOString().slice(0,10)!==end||b<=a||b-a>7*86400_000)
    throw new DispatchError(400,"Use valid dates and an exclusive end date, at most seven days after the start.");
  return {a,b};
}
export const overlaps=(a:number,b:number,c:number,d:number)=>a<d&&c<b;
const minutes=(value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3));
export function activeHolds(board:Board,now:number){return (board.schedule?.holds??[]).filter(h=>!h.releasedAt&&Date.parse(h.expiresAt)>now);}
function withinHours(weekly:ScheduleSettings["weekly"],start:number,end:number,tz:string){
  const first=localParts(start,tz),last=localParts(end-1,tz);
  if(first.date!==last.date)return false;
  // Conservatively exclude intervals spanning a clock change, rather than invent
  // nonexistent local minutes or stretch a shift through a repeated hour.
  if(last.minute-first.minute!==Math.floor((end-start-1)/60_000))return false;
  return weekly.some(w=>w.day===first.day&&minutes(w.start)<=first.minute&&minutes(w.end)>last.minute);
}
export function jobInterval(job:Job):{start:number;end:number}|null{
  const start=job.plannedStart?Date.parse(job.plannedStart):NaN;
  const duration=job.estimatedMinutes??job.bookMinutes;
  return Number.isFinite(start)&&duration!==null&&duration>0?{start,end:start+duration*60_000}:null;
}
function sameLanes(tech:string,resource:string|null,otherTech:string|null,otherResource:string|null){
  return !otherTech||tech===otherTech||!!resource&&resource===otherResource;
}
export function slotIsFree(board:Board,slot:AvailableSlot,now:number,ignoreHoldId?:string):boolean{
  const settings=board.schedule?.settings;
  if(!settings?.enabled)return false;
  const start=Date.parse(slot.start),end=Date.parse(slot.end),buffer=settings.bufferMinutes*60_000;
  const busyStart=start-buffer,busyEnd=end+buffer;
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||start<now+settings.leadMinutes*60_000)return false;
  const tech=board.technicians.find(t=>t.id===slot.technicianId&&t.active);
  const shift=settings.technicians.find(t=>t.id===slot.technicianId);
  if(!tech||!shift||!withinHours(settings.weekly,busyStart,busyEnd,settings.timeZone)||!withinHours(shift.weekly,busyStart,busyEnd,settings.timeZone))return false;
  if(shift.timeOff.some(t=>overlaps(busyStart,busyEnd,Date.parse(t.start),Date.parse(t.end))))return false;
  if(slot.resourceId){
    if(!resourcesFor(board).some(r=>r.id===slot.resourceId&&r.active))return false;
    const resource=settings.resources.find(r=>r.id===slot.resourceId);
    if(resource&&(!withinHours(resource.weekly,busyStart,busyEnd,settings.timeZone)||resource.timeOff.some(t=>overlaps(busyStart,busyEnd,Date.parse(t.start),Date.parse(t.end)))))return false;
  }
  for(const hold of activeHolds(board,now)){
    if(hold.id===ignoreHoldId)continue;
    if(sameLanes(slot.technicianId,slot.resourceId,hold.technicianId,hold.resourceId)&&overlaps(busyStart,busyEnd,Date.parse(hold.start)-buffer,Date.parse(hold.end)+buffer))return false;
  }
  for(const job of board.jobs){
    if(job.status==="completed"||board.visits.find(v=>v.id===job.visitId)?.closed)continue;
    if(!sameLanes(slot.technicianId,slot.resourceId,job.technicianId,job.resource))continue;
    // Active/paused work has an uncertain finish. Never promise its lane is free.
    if(job.status==="active"||job.status==="paused")return false;
    const interval=jobInterval(job);
    if(interval&&overlaps(busyStart,busyEnd,interval.start-buffer,interval.end+buffer))return false;
    if(job.plannedStart&&!interval&&localParts(Date.parse(job.plannedStart),settings.timeZone).date===localParts(start,settings.timeZone).date)return false;
  }
  for(const appointment of board.schedule?.appointments?.appointments??[]){
    const visit=board.visits.find(v=>v.provider==="protractor"&&v.sourceId?.toLowerCase()===appointment.id.toLowerCase());
    const planned=visit?board.jobs.filter(j=>j.visitId===visit.id):[];
    // Once all of this appointment's work has an explicit local plan, those
    // job intervals (above) own the capacity; don't reserve the arrival twice.
    if(planned.length&&planned.every(j=>j.status==="completed"||!!j.technicianId&&!!jobInterval(j)))continue;
    if(!appointment.start)return false;
    const a=Date.parse(appointment.start),b=appointment.end?Date.parse(appointment.end):null;
    const linked=appointment.technicianSourceIds.map(id=>board.technicians.find(t=>t.active&&t.sourceId?.toLowerCase()===id.toLowerCase())?.id);
    const allShop=!linked.length||linked.some(id=>!id);
    if(!allShop&&!linked.includes(slot.technicianId))continue;
    if(b!==null?overlaps(busyStart,busyEnd,a-buffer,b+buffer):localParts(a,settings.timeZone).date===localParts(start,settings.timeZone).date)return false;
  }
  return true;
}
export function assertLocalPlanAvailable(before:Board,after:Board,jobId:string,now:number){
  if(!before.schedule?.settings?.enabled)return;
  const job=after.jobs.find(j=>j.id===jobId),interval=job&&jobInterval(job);
  if(job?.resource&&job.plannedStart&&(!job.technicianId||!interval))
    throw new DispatchError(409,"Assign a technician and a known duration before scheduling shared equipment.");
  if(!job?.technicianId||!interval)return;
  const visit=after.visits.find(v=>v.id===job.visitId);
  const view={...after,jobs:after.jobs.filter(j=>j.id!==job.id),schedule:after.schedule?{...after.schedule,appointments:after.schedule.appointments?{
    ...after.schedule.appointments,appointments:after.schedule.appointments.appointments.filter(a=>a.id.toLowerCase()!==visit?.sourceId?.toLowerCase()),
  }:undefined}:undefined};
  const date=localParts(interval.start,before.schedule.settings.timeZone).date;
  const next=new Date(Date.parse(`${date}T00:00:00Z`)+86400_000).toISOString().slice(0,10);
  const result=availability(view,{startDate:date,endDate:next,durationMinutes:(interval.end-interval.start)/60_000,technicianId:job.technicianId,...(job.resource?{resourceId:job.resource}:{})},now);
  if(result.reasons.length||!slotIsFree(view,{start:new Date(interval.start).toISOString(),end:new Date(interval.end).toISOString(),technicianId:job.technicianId,resourceId:job.resource},now))
    throw new DispatchError(409,result.reasons.join(" ")||"This plan conflicts with shop hours, time off, appointments, other work or a temporary hold.");
}
export function availability(board:Board,query:AvailabilityQuery,now:number):AvailabilityResult{
  const {a,b}=validateDateRange(query.startDate,query.endDate);
  const settings=board.schedule?.settings,snapshot=board.schedule?.appointments;
  const result:AvailabilityResult={timeZone:settings?.timeZone??null,revision:board.revision,generatedAt:new Date(now).toISOString(),appointmentFetchedAt:snapshot?.fetchedAt??null,available:false,reasons:[],warnings:[],slots:[],truncated:false};
  if(!settings?.enabled)result.reasons.push("Scheduling is disabled. Configure shop hours and technician shifts first.");
  if(a>now+90*86400_000||b<now-86400_000)result.reasons.push("Availability is limited to today through the next 90 days.");
  if(!snapshot?.complete||!Number.isFinite(Date.parse(snapshot.fetchedAt))||snapshot.startDate>query.startDate||snapshot.endDate<query.endDate||now-Date.parse(snapshot.fetchedAt)>APPOINTMENT_FRESH_MS||Date.parse(snapshot.fetchedAt)>now+5000)
    result.reasons.push("Appointment coverage is missing, incomplete or stale. Refresh the calendar before reserving capacity.");
  if(!settings||result.reasons.length)return result;
  let technicians=board.technicians.filter(t=>t.active&&(!query.technicianId||t.id===query.technicianId));
  if(query.skillKey)technicians=technicians.filter(t=>t.skills?.some(s=>s.key.toLowerCase()===query.skillKey!.toLowerCase()&&s.status==="confirmed"));
  technicians=technicians.filter(t=>settings.technicians.some(s=>s.id===t.id&&s.weekly.length));
  if(!technicians.length)result.reasons.push("No active technician has configured shifts and the requested confirmed skill.");
  if(query.resourceId&&!resourcesFor(board).some(r=>r.id===query.resourceId&&r.active))result.reasons.push("The requested bay is unavailable.");
  if(board.jobs.some(j=>j.status!=="completed"&&!j.plannedStart))result.warnings.push("Unscheduled backlog is not a timed reservation. Assign future work before sharing capacity.");
  if(board.jobs.some(j=>j.status==="active"||j.status==="paused"))result.warnings.push("Active or paused work blocks its lane until completed or replanned.");
  if(snapshot!.appointments.some(p=>!p.start||!p.end||!p.technicianSourceIds.length))result.warnings.push("Unassigned or incomplete appointments conservatively block shop capacity; they are arrival times, not verified work plans.");
  if(result.reasons.length)return result;
  // UTC iteration handles gaps and duplicate local times correctly. API slots include offsets (Z).
  for(let start=Math.max(a-86400_000,Math.ceil((now+settings.leadMinutes*60_000)/900_000)*900_000);start<b+86400_000;start+=900_000){
    const local=localParts(start,settings.timeZone);
    if(local.date<query.startDate||local.date>=query.endDate||local.minute%15!==0)continue;
    for(const tech of technicians){
      const slot={start:new Date(start).toISOString(),end:new Date(start+query.durationMinutes*60_000).toISOString(),technicianId:tech.id,resourceId:query.resourceId??null};
      if(slotIsFree(board,slot,now)){
        if(result.slots.length===1000){result.truncated=true;result.available=true;return result;}
        result.slots.push(slot);
      }
    }
  }
  result.available=result.slots.length>0;return result;
}
/** Called before a local plan/start can occupy a live integrator hold. */
export function assertHeldCapacityPreserved(before:Board,after:Board,now:number){
  const holds=activeHolds(before,now),buffer=(before.schedule?.settings?.bufferMinutes??0)*60_000;
  if(!holds.length)return;
  for(const hold of holds){
    const tech=after.technicians.find(t=>t.id===hold.technicianId&&t.active);
    if(!tech||hold.resourceId&&!resourcesFor(after).some(r=>r.id===hold.resourceId&&r.active)||
      hold.skillKey&&!tech.skills?.some(s=>s.key.toLowerCase()===hold.skillKey!.toLowerCase()&&s.status==="confirmed"))
      throw new DispatchError(409,"Release the scheduler hold before changing its technician, skill or bay availability.");
  }
  for(const job of after.jobs){
    const old=before.jobs.find(j=>j.id===job.id);
    if(old&&old.technicianId===job.technicianId&&old.resource===job.resource&&old.plannedStart===job.plannedStart&&old.estimatedMinutes===job.estimatedMinutes&&old.bookMinutes===job.bookMinutes&&old.status===job.status)continue;
    if(job.status==="completed")continue;
    const interval=jobInterval(job);
    for(const hold of holds){
      if(!sameLanes(job.technicianId??"",job.resource,hold.technicianId,hold.resourceId)&&job.technicianId)continue;
      if(job.status==="active"||job.status==="paused"||interval&&overlaps(interval.start-buffer,interval.end+buffer,Date.parse(hold.start)-buffer,Date.parse(hold.end)+buffer))
        throw new DispatchError(409,"This technician or bay has a temporary scheduler hold. Release the hold or choose another time.");
    }
  }
}
