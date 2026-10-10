import {z} from "zod";
import type {Board,Job} from "./model";
const id=z.string().trim().min(1).max(100).regex(/^[\w.:@+-]+$/);
const text=z.string().trim().min(1).max(160);
export const readinessSchema=z.object({
 parts:z.enum(["unknown","not-needed","ordered","partial","received","incorrect"]),
 diagnostics:z.enum(["unknown","needed","ready","not-needed"]),
 requiredSkills:z.array(text).max(20),
 blockers:z.array(z.object({id,reason:text,owner:text,resolved:z.boolean()}).strict()).max(20),
 checks:z.array(z.object({id,label:text}).strict()).max(20),
}).strict();
export interface Operations {
 reviewedAt:string;reviewedBy:string;
 parts:z.infer<typeof readinessSchema>["parts"];diagnostics:z.infer<typeof readinessSchema>["diagnostics"];
 requiredSkills:string[];
 blockers:{id:string;reason:string;owner:string;resolved:boolean;openedAt:string;resolvedAt:string|null}[];
 checks:{id:string;label:string;completedAt:string|null;completedBy:string|null}[];
 handoff?:{note:string;by:string;at:string;acknowledgedBy:string|null;acknowledgedAt:string|null};
}
export const operationCommands=[
 z.object({type:z.literal("operationsMode"),enabled:z.boolean()}).strict(),
 z.object({type:z.literal("readiness"),jobId:id,readiness:readinessSchema}).strict(),
 z.object({type:z.literal("handoff"),jobId:id,note:z.string().trim().min(1).max(1000)}).strict(),
 z.object({type:z.literal("acknowledgeHandoff"),jobId:id}).strict(),
 z.object({type:z.literal("quality"),jobId:id,checkId:id,done:z.boolean()}).strict(),
] as const;
export function readinessReasons(board:Board,job:Job,technicianId=job.technicianId):string[]{
 const o=job.operations;
 if(!o)return ["Readiness has not been reviewed"];
 const reasons:string[]=[];
 if(!["received","not-needed"].includes(o.parts))reasons.push(`Parts: ${o.parts}`);
 if(!["ready","not-needed"].includes(o.diagnostics))reasons.push(`Diagnostic information: ${o.diagnostics}`);
 reasons.push(...o.blockers.filter(b=>!b.resolved).map(b=>`${b.reason} — ${b.owner}`));
 const tech=board.technicians.find(t=>t.id===technicianId&&t.active);
 for(const skill of o.requiredSkills)if(!tech?.skills?.some(s=>s.key.toLowerCase()===skill.toLowerCase()&&s.status==="confirmed"))reasons.push(`Confirmed skill required: ${skill}`);
 if(o.handoff&&!o.handoff.acknowledgedAt)reasons.push("Handoff acknowledgment required");
 return reasons;
}
export function dependencySuggestions(board:Board,job:Job):{jobId:string;reason:string}[]{
 if(!/\balign(?:ment)?\b/i.test(job.title)||job.status==="completed")return [];
 return board.jobs.filter(j=>j.visitId===job.visitId&&j.id!==job.id&&!j.sourceRemoved&&!job.prerequisites.includes(j.id)&&
   /\b(replace(?:ment)?|renew|install)\b/i.test(j.title)&&/\b(control arm|tie rod|strut|steering rack|ball joint|suspension)\b/i.test(j.title))
 .map(j=>({jobId:j.id,reason:"Review repair-before-alignment sequence against the actual work and applicable procedure."}));
}
/** Conservative dependency lower bound, not an optimized completion promise. */
export function promiseRisk(board:Board,visitId:string,now:number):{level:"unknown"|"at-risk"|"no-known-risk";reasons:string[];earliestFinish:string|null}{
 const visit=board.visits.find(v=>v.id===visitId),jobs=board.jobs.filter(j=>j.visitId===visitId&&j.status!=="completed");
 if(!visit?.promiseAt)return {level:"unknown",reasons:["No customer promise time"],earliestFinish:null};
 const reasons:string[]=[],memo=new Map<string,number>(),visiting=new Set<string>();
 if(board.operationsEnabled)for(const job of board.jobs.filter(j=>j.visitId===visitId))
   if(!job.operations||job.operations.checks.some(c=>!c.completedAt))reasons.push(`${job.title}: readiness/final checks pending`);
 function finish(job:Job):number{
  if(job.status==="completed")return now;
  if(memo.has(job.id))return memo.get(job.id)!;
  if(visiting.has(job.id)){reasons.push("Dependency cycle needs review");return now;}
  visiting.add(job.id);
  const duration=job.estimatedMinutes??job.bookMinutes;
  if(duration===null||duration<=0)reasons.push(`${job.title}: duration unknown`);
  if(!job.technicianId)reasons.push(`${job.title}: unassigned`);
  if(!job.authorized||job.sourceRemoved)reasons.push(`${job.title}: authorization/source review needed`);
  if(job.status==="paused")reasons.push(`${job.title}: paused; finish uncertain`);
  if(board.operationsEnabled)reasons.push(...readinessReasons(board,job).map(r=>`${job.title}: ${r}`));
  const parents=job.prerequisites.map(id=>board.jobs.find(j=>j.id===id&&j.visitId===job.visitId));
  if(parents.some(p=>!p))reasons.push("Missing prerequisite");
  const active=job.activeMs+(job.status==="active"&&job.since?Math.max(0,now-Date.parse(job.since)):0);
  const remaining=Math.max(0,(duration??0)*60000-active);
  if(job.status==="active"&&remaining===0)reasons.push(`${job.title}: estimate exceeded`);
  const value=Math.max(now,job.plannedStart?Date.parse(job.plannedStart):now,...parents.filter((p):p is Job=>!!p).map(finish))+remaining;
  memo.set(job.id,value);visiting.delete(job.id);return value;
 }
 const finishAt=Math.max(now,...jobs.map(finish)),promise=Date.parse(visit.promiseAt);
 if(finishAt>promise&&jobs.length)reasons.unshift("Even the dependency-only estimate exceeds the promised time");
 return {level:finishAt>promise&&jobs.length?"at-risk":reasons.length?"unknown":"no-known-risk",reasons:[...new Set(reasons)],earliestFinish:new Date(finishAt).toISOString()};
}
export function nextJobs(board:Board,technicianId:string,now:number):{jobId:string;reasons:string[]}[]{
 const tech=board.technicians.find(t=>t.id===technicianId&&t.active);
 if(!tech||!board.operationsEnabled||board.jobs.some(j=>j.technicianId===technicianId&&j.status==="active"))return [];
 return board.jobs.filter(job=>{
  const visit=board.visits.find(v=>v.id===job.visitId);
  return visit&&!visit.closed&&job.status!=="completed"&&job.status!=="active"&&(!job.technicianId||job.technicianId===technicianId)&&job.authorized&&!job.sourceRemoved&&
   (!job.plannedStart||Date.parse(job.plannedStart)<=now)&&
   job.prerequisites.every(id=>board.jobs.find(j=>j.id===id)?.status==="completed")&&
   !readinessReasons(board,job,technicianId).length&&
   (!job.resource||!board.jobs.some(j=>j.resource===job.resource&&j.status==="active"))&&
   (!job.resource||(board.resources??[{id:"rack",active:true}]).some(r=>r.id===job.resource&&r.active));
 }).sort((a,b)=>{
  const va=board.visits.find(v=>v.id===a.visitId)!,vb=board.visits.find(v=>v.id===b.visitId)!;
  return Number(vb.transport.customerPlan==="waiting")-Number(va.transport.customerPlan==="waiting")||
   (va.promiseAt?Date.parse(va.promiseAt):Infinity)-(vb.promiseAt?Date.parse(vb.promiseAt):Infinity)||a.id.localeCompare(b.id);
 }).slice(0,5).map(job=>({jobId:job.id,reasons:["Readiness reviewed; prerequisites complete",job.operations!.requiredSkills.length?"Required skills confirmed":"No skills specified; manager must verify suitability","Ordered by waiting customer, then promise time"]}));
}
