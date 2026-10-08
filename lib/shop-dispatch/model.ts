import { z } from "zod";

export const idSchema = z.string().trim().min(1).max(100).regex(/^[\w.:@+-]+$/);
const text = z.string().trim().min(1).max(160);
const timestamp = z.string().datetime();
export function isRasterLogo(value:string|null):boolean {
  if(value===null)return true;
  try{
    const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if(!match||match[2].length%4!==0)return false;
    const head=atob(match[2].slice(0,32));
    return match[1]==="png"?head.startsWith("\x89PNG\r\n\x1a\n"):
      match[1]==="jpeg"?head.startsWith("\xff\xd8\xff"):head.startsWith("RIFF")&&head.slice(8,12)==="WEBP";
  }catch{return false;}
}
export const brandSchema = z.object({
  name: z.string().trim().min(1).max(60),
  primary: z.string().regex(/^#[0-9a-f]{6}$/i),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i),
  // No external requests, executable SVGs or customer data in logos.
  logo: z.string().max(180000).nullable().refine(isRasterLogo,"Use an embedded PNG, JPEG or WebP logo under 120 KB"),
}).strict();
export type Brand = z.infer<typeof brandSchema>;
export const DEFAULT_BRAND: Brand = { name: "Detect Dog", primary: "#285746", accent: "#d66a35", logo: null };
export const transportSchema = z.object({
  customerPlan: z.enum(["unknown", "waiting", "drop-off", "returning"]),
  ride: z.enum(["none", "needed", "arranged", "completed"]),
  loaner: z.enum(["none", "requested", "assigned", "returned"]),
  loanerId: z.string().trim().max(60),
  pickupAt: timestamp.nullable(), notes: z.string().trim().max(500),
}).strict().refine(v => v.loaner !== "assigned" || !!v.loanerId, "Assigned loaners need an identifier");
export type Transport = z.infer<typeof transportSchema>;
export interface Technician { id: string; name: string; email: string; active: boolean }
export type JobStatus = "idle" | "active" | "paused" | "completed";
export interface Job {
  id: string; visitId: string; title: string; technicianId: string | null;
  plannedStart: string | null; estimatedMinutes: number | null; bookMinutes: number | null;
  prerequisites: string[]; resource: "rack" | null; status: JobStatus;
  activeMs: number; waitingMs: number; since: string | null; pauseReason: string | null;
  sourceId: string | null; sourceRemoved: boolean; authorized: boolean;
}
export interface Visit {
  id: string; ro: string; vehicle: string; customer: string;
  arrivalAt: string | null; promiseAt: string | null; transport: Transport;
  closed: boolean; provider: "manual" | "protractor"; sourceId: string | null;
  sourceStatus: string | null; sourceFetchedAt: string | null;
}
export interface Audit { at: string; actor: string; action: string; target: string; detail: string }
export interface Receipt { id: string; actor: string; digest: string }
export interface Board {
  revision: number; updatedAt: string | null; technicians: Technician[];
  visits: Visit[]; jobs: Job[]; audit: Audit[]; receipts: Receipt[];
  locationBrand: Brand | null;
}
export interface Actor { email: string; manager: boolean; technicianId: string | null }
export const intakeSchema = z.object({
  sourceId: idSchema, ro: text, vehicle: text, customer: z.string().max(160),
  sourceStatus: z.string().max(80),
  jobs: z.array(z.object({ sourceId: idSchema, title: text, bookMinutes: z.number().min(0).max(10000).nullable() }).strict()).max(80),
}).strict();
export type Intake = z.infer<typeof intakeSchema>;
export const commandSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("technician"), id:idSchema, name:text, email:z.string().trim().email().max(160), active:z.boolean()}).strict(),
  z.object({type:z.literal("visit"), id:idSchema, ro:text, vehicle:text, customer:z.string().trim().max(160)}).strict(),
  z.object({type:z.literal("transport"), visitId:idSchema, transport:transportSchema, arrivalAt:timestamp.nullable(), promiseAt:timestamp.nullable()}).strict(),
  z.object({type:z.literal("job"), id:idSchema, visitId:idSchema, title:text, bookMinutes:z.number().min(0).max(10000).nullable()}).strict(),
  z.object({type:z.literal("plan"), jobId:idSchema, technicianId:idSchema.nullable(), plannedStart:timestamp.nullable(), estimatedMinutes:z.number().int().min(1).max(1440).nullable(), prerequisites:z.array(idSchema).max(20), resource:z.enum(["rack"]).nullable(), authorized:z.boolean()}).strict(),
  z.object({type:z.literal("start"), jobId:idSchema, pauseCurrent:z.boolean().default(false)}).strict(),
  z.object({type:z.literal("pause"), jobId:idSchema, reason:z.string().trim().min(1).max(160)}).strict(),
  z.object({type:z.literal("complete"), jobId:idSchema}).strict(),
  z.object({type:z.literal("correct"), jobId:idSchema, activeMinutes:z.number().min(0).max(100000), waitingMinutes:z.number().min(0).max(100000), reason:text}).strict(),
  z.object({type:z.literal("close"), visitId:idSchema}).strict(),
  z.object({type:z.literal("brand"), brand:brandSchema.nullable()}).strict(),
  z.object({type:z.literal("sync"), workOrderId:z.string().uuid()}).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export const mutationSchema = z.object({
  requestId:z.string().uuid(), revision:z.number().int().nonnegative(), command:commandSchema,
}).strict();
export function emptyBoard(): Board {
  return {revision:0,updatedAt:null,technicians:[],visits:[],jobs:[],audit:[],receipts:[],locationBrand:null};
}
export class DispatchError extends Error {
  constructor(public status:number, message:string) { super(message); }
}
export function requireThat(value:unknown, message:string, status=422): asserts value {
  if (!value) throw new DispatchError(status,message);
}
export function actorFor(board:Board,email:string,role:string):Actor {
  return {email:email.toLowerCase(),manager:["owner","admin","manager"].includes(role),
    technicianId:board.technicians.find(t=>t.active && t.email===email.toLowerCase())?.id ?? null};
}
export function elapsed(job:Job,now:number) {
  const delta=job.since ? Math.max(0,now-Date.parse(job.since)) : 0;
  return {activeMs:job.activeMs+(job.status==="active"?delta:0),waitingMs:job.waitingMs+(job.status==="paused"?delta:0)};
}
export function blockers(board:Board,job:Job):string[] {
  const reasons=job.prerequisites.filter(id=>board.jobs.find(j=>j.id===id)?.status!=="completed").map(id=>board.jobs.find(j=>j.id===id)?.title ?? "Missing prerequisite");
  if (!job.authorized) reasons.push("Manager authorization required");
  if (job.sourceRemoved) reasons.push("Package no longer present upstream");
  return reasons;
}
export function applyCommand(input:Board,command:Command,actor:Actor,now:string,intake?:Intake):Board {
  const board:Board=structuredClone(input);
  const managerOnly=!["start","pause","complete"].includes(command.type);
  requireThat(!managerOnly || actor.manager,"Manager access required",403);
  requireThat(board.audit.length<5000,"Pilot audit capacity reached. Export and arrange archival before continuing.",409);
  const visit=(id:string)=>{const v=board.visits.find(v=>v.id===id);requireThat(v && !v.closed,"Visit not found or closed",404);return v;};
  const settle=(j:Job)=>{Object.assign(j,elapsed(j,Date.parse(now)));j.since=null;};
  let target="board", detail="";
  if(command.type==="technician"){
    requireThat(!board.technicians.some(t=>t.id!==command.id&&t.email===command.email.toLowerCase()),"Email is already mapped");
    requireThat(command.active || !board.jobs.some(j=>j.technicianId===command.id&&j.status!=="completed"),"Reassign unfinished jobs before deactivating");
    const tech={id:command.id,name:command.name,email:command.email.toLowerCase(),active:command.active};
    const index=board.technicians.findIndex(t=>t.id===tech.id);
    if(index<0){requireThat(board.technicians.length<40,"Pilot supports up to 40 technicians");board.technicians.push(tech);}else board.technicians[index]=tech;
    target=tech.id;
  }else if(command.type==="visit"){
    requireThat(!board.visits.some(v=>v.id===command.id),"Visit already exists",409);
    board.visits.push({id:command.id,ro:command.ro,vehicle:command.vehicle,customer:command.customer,arrivalAt:null,promiseAt:null,
      transport:{customerPlan:"unknown",ride:"none",loaner:"none",loanerId:"",pickupAt:null,notes:""},closed:false,provider:"manual",sourceId:null,sourceStatus:null,sourceFetchedAt:null});
    target=command.id;
  }else if(command.type==="transport"){
    const v=visit(command.visitId);target=v.id;
    requireThat(!(command.arrivalAt&&command.promiseAt) || Date.parse(command.promiseAt)>=Date.parse(command.arrivalAt),"Promise must be after arrival");
    const assigned=command.transport;
    requireThat(assigned.loaner!=="assigned" || !board.visits.some(other=>other.id!==v.id&&!other.closed&&other.transport.loaner==="assigned"&&other.transport.loanerId.toLowerCase()===assigned.loanerId.toLowerCase()),"This loaner is assigned to another visit",409);
    Object.assign(v,{transport:assigned,arrivalAt:command.arrivalAt,promiseAt:command.promiseAt});
  }else if(command.type==="job"){
    visit(command.visitId);requireThat(!board.jobs.some(j=>j.id===command.id),"Job already exists",409);
    board.jobs.push(newJob(command.id,command.visitId,command.title,command.bookMinutes));target=command.id;
  }else if(command.type==="brand"){board.locationBrand=command.brand;}
  else if(command.type==="close"){
    const v=visit(command.visitId);
    requireThat(board.jobs.filter(j=>j.visitId===v.id).every(j=>j.status==="completed"),"Complete all jobs before closing");
    requireThat(!["assigned","requested"].includes(v.transport.loaner)&&!["needed","arranged"].includes(v.transport.ride),"Resolve transportation and return the loaner first");
    v.closed=true;target=v.id;
  }else if(command.type==="sync"){
    requireThat(intake,"Integration did not return a verified work order",502);
    requireThat(intake.sourceId.toLowerCase()===command.workOrderId.toLowerCase(),"Upstream work order identity mismatch",502);
    const sourceId=intake.sourceId.toLowerCase();
    let v=board.visits.find(v=>v.provider==="protractor"&&v.sourceId===sourceId);
    requireThat(!v?.closed,"This visit was closed locally; it will not be reopened by sync",409);
    if(!v){
      const id=`protractor:${sourceId}`;
      v={id,ro:intake.ro,vehicle:intake.vehicle,customer:intake.customer,arrivalAt:null,promiseAt:null,transport:{customerPlan:"unknown",ride:"none",loaner:"none",loanerId:"",pickupAt:null,notes:""},closed:false,provider:"protractor",sourceId,sourceStatus:null,sourceFetchedAt:null};
      board.visits.push(v);
    }
    Object.assign(v,{ro:intake.ro,vehicle:intake.vehicle,customer:intake.customer,sourceStatus:intake.sourceStatus,sourceFetchedAt:now});
    for(const source of intake.jobs){
      const id=`${v.id}:${source.sourceId.toLowerCase()}`;
      let job=board.jobs.find(j=>j.id===id);
      if(!job){job=newJob(id,v.id,source.title,source.bookMinutes);job.authorized=false;job.sourceId=source.sourceId.toLowerCase();board.jobs.push(job);}
      Object.assign(job,{title:source.title,bookMinutes:source.bookMinutes,sourceRemoved:false});
    }
    for(const job of board.jobs.filter(j=>j.visitId===v!.id&&j.sourceId)){
      job.sourceRemoved=!intake.jobs.some(s=>s.sourceId.toLowerCase()===job.sourceId);
      if(job.sourceRemoved && job.status==="active"){settle(job);job.status="paused";job.since=now;job.pauseReason="Package removed upstream; manager review required";}
    }
    target=v.id;
  }else{
    const job=board.jobs.find(j=>j.id===command.jobId);requireThat(job,"Job not found",404);
    visit(job.visitId);target=job.id;
    requireThat(actor.manager || (!!actor.technicianId&&actor.technicianId===job.technicianId),"You can control only your assigned jobs",403);
    if(command.type==="plan"){
      requireThat(!["active","completed"].includes(job.status),"Pause active work before editing; completed work is locked");
      requireThat(!command.technicianId || board.technicians.some(t=>t.id===command.technicianId&&t.active),"Choose an active technician");
      requireThat(new Set(command.prerequisites).size===command.prerequisites.length,"Duplicate prerequisites");
      requireThat(command.prerequisites.every(id=>id!==job.id&&board.jobs.some(j=>j.id===id&&j.visitId===job.visitId)),"Prerequisites must be other jobs in this visit");
      const reaches=(id:string,seen=new Set<string>()):boolean=>{
        if(id===job.id)return true;if(seen.has(id))return false;seen.add(id);
        return (board.jobs.find(j=>j.id===id)?.prerequisites ?? []).some(next=>reaches(next,seen));
      };
      requireThat(!command.prerequisites.some(id=>reaches(id)),"Dependencies cannot form a cycle");
      Object.assign(job,{technicianId:command.technicianId,plannedStart:command.plannedStart,estimatedMinutes:command.estimatedMinutes,prerequisites:command.prerequisites,resource:command.resource,authorized:command.authorized});
    }else if(command.type==="start"){
      requireThat(job.status==="idle"||job.status==="paused","Job is already active or completed",409);
      requireThat(blockers(board,job).length===0,`Blocked: ${blockers(board,job).join(", ")}`,409);
      requireThat(board.technicians.some(t=>t.id===job.technicianId&&t.active),"Assign an active technician before starting");
      requireThat(!job.resource || !board.jobs.some(j=>j.id!==job.id&&j.resource===job.resource&&j.status==="active"),"Alignment rack is occupied",409);
      const current=board.jobs.find(j=>j.technicianId===job.technicianId&&j.status==="active");
      requireThat(!current||command.pauseCurrent,"Another job is active. Confirm pausing it before starting this one.",409);
      if(current){settle(current);current.status="paused";current.since=now;current.pauseReason="Switched to another job";detail=`Paused ${current.id}`;}
      settle(job);job.status="active";job.since=now;job.pauseReason=null;
    }else if(command.type==="pause"||command.type==="complete"){
      requireThat(job.status==="active","Start or resume this job first",409);settle(job);
      job.status=command.type==="pause"?"paused":"completed";job.since=command.type==="pause"?now:null;
      job.pauseReason=command.type==="pause"?command.reason:null;detail=job.pauseReason ?? "";
    }else if(command.type==="correct"){
      requireThat(job.status!=="active","Pause work before correcting time");settle(job);
      detail=`${command.reason}; active ${job.activeMs}->${command.activeMinutes*60000}; waiting ${job.waitingMs}->${command.waitingMinutes*60000}`;
      job.activeMs=command.activeMinutes*60000;job.waitingMs=command.waitingMinutes*60000;job.since=job.status==="paused"?now:null;
    }
  }
  requireThat(board.visits.length<=500&&board.jobs.length<=2500,"Pilot capacity reached; arrange archival before adding work",409);
  if(!detail)detail=command.type==="brand"?
    JSON.stringify(command.brand?{name:command.brand.name,primary:command.brand.primary,accent:command.brand.accent,hasLogo:!!command.brand.logo}:"inherit enterprise"):
    JSON.stringify(command);
  board.audit.push({at:now,actor:actor.email,action:command.type,target,detail});
  board.revision++;board.updatedAt=now;return board;
}
function newJob(id:string,visitId:string,title:string,bookMinutes:number|null):Job {
  return {id,visitId,title,bookMinutes,technicianId:null,plannedStart:null,estimatedMinutes:null,prerequisites:[],resource:null,status:"idle",activeMs:0,waitingMs:0,since:null,pauseReason:null,sourceId:null,sourceRemoved:false,authorized:true};
}
