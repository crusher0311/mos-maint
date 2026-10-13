import type { Board } from "./model";
import { readinessReasons, promiseRisk } from "./operations";
import { availability, localParts } from "./schedule-engine";
import { assertDependencyPlans } from "./operations-scheduling";

export function recommendJobOptions(board:Board,jobId:string,now:number){
  const options:{technicianId:string;start:string;end:string;reasons:string[];promiseImpact:string}[]=[];
  const reasons:string[]=[];
  const job=board.jobs.find(j=>j.id===jobId),visit=board.visits.find(v=>v.id===job?.visitId);
  const settings=board.schedule?.settings;
  const duration=job?.estimatedMinutes;
  if(!job||!visit||visit.closed||job.status!=="idle"||job.sourceRemoved)reasons.push("Open, idle work needs review before offering a window.");
  if(!duration||duration<15||duration>480)reasons.push("Enter a reviewed duration of 15–480 minutes; book time is not a completion estimate.");
  if(!job?.operations)reasons.push("Review parts, diagnostic readiness and required qualifications first.");
  if(!settings?.enabled)reasons.push("Configure working hours and refresh appointment coverage.");
  if(board.jobs.some(j=>j.id!==jobId&&j.status!=="completed"&&board.visits.some(v=>v.id===j.visitId&&!v.closed)&&(!j.plannedStart||j.estimatedMinutes===null)))
    reasons.push("Other unfinished work has no reviewed time plan. Review that backlog before offering capacity; hidden lanes are included.");
  if(!reasons.length&&job&&visit&&settings&&duration){
    const startDate=localParts(now,settings.timeZone).date;
    const endDate=new Date(Date.parse(`${startDate}T00:00:00Z`)+86400000).toISOString().slice(0,10);
    for(const tech of board.technicians.filter(t=>t.active)){
      const readiness=readinessReasons(board,job,tech.id);
      if(readiness.length){reasons.push(`${tech.name}: ${readiness.join("; ")}`);continue;}
      const view={...board,jobs:board.jobs.filter(j=>j.id!==jobId)};
      const result=availability(view,{startDate,endDate,durationMinutes:duration,technicianId:tech.id,...(job.resource?{resourceId:job.resource}:{})},now);
      reasons.push(...result.reasons);
      for(const slot of result.slots){
        const candidate={...board,jobs:board.jobs.map(j=>j.id===jobId?{...j,technicianId:tech.id,plannedStart:slot.start}:j)};
        try{assertDependencyPlans(candidate,jobId,now);}catch{continue;}
        const ownRisk=promiseRisk(candidate,visit.id,now);
        const otherRisks=board.visits.filter(v=>v.id!==visit.id&&!v.closed&&v.promiseAt&&promiseRisk(candidate,v.id,now).level!=="no-known-risk").length;
        options.push({technicianId:tech.id,start:slot.start,end:slot.end,reasons:[
          job.operations!.requiredSkills.length?"All required skills explicitly confirmed; history is not a qualification":"No required skills specified; staff must confirm suitability",
          "Reviewed readiness, shifts, time off, shared resources, holds and appointments checked",
          "Existing work is not moved; staff must review and revalidate before saving",
        ],promiseImpact:`This visit: ${ownRisk.level} (dependency-only estimate). ${otherRisks} other promised visit(s) still need review. This job window is not a whole-visit completion promise.`});
        break;
      }
    }
  }
  options.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||a.technicianId.localeCompare(b.technicianId));
  return {options:options.slice(0,5),reasons:[...new Set(reasons)],offer:options.length?
    "Review the earliest feasible service window below. Confirm the customer’s agreement separately; viewing an option does not reserve it.":
    "Discuss flexible drop-off or the next reserved opportunity after reviewing capacity. Agree a customer-update time separately; no assessment or same-day completion is promised."};
}
