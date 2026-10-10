import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DispatchError, requireThat, resourcesFor, type Board } from "./model";
import { availability, activeHolds, localParts, validateDateRange } from "./schedule-engine";
import { availabilityQuerySchema, scheduleSettingsSchema, type AppointmentSnapshot, type AvailabilityQuery, type ScheduleHold } from "./schedule-types";
import { digest } from "./service";

export interface ScheduleDependencies {
  read:(shopId:number)=>Promise<Board>;
  save:(shopId:number,revision:number,board:Board)=>Promise<boolean>;
  now:()=>number;
}
const instant=z.string().datetime({offset:true});
const laneId=z.string().trim().min(1).max(100).regex(/^[\w.:@+-]+$/);
export const holdRequestSchema=z.object({
  requestId:z.string().uuid(),start:instant,end:instant,technicianId:laneId,resourceId:laneId.nullable().default(null),
  skillKey:z.string().trim().min(1).max(160).nullable().default(null),
}).strict();
export const scheduleCommandSchema=z.discriminatedUnion("type",[
  z.object({type:z.literal("settings"),requestId:z.string().uuid(),revision:z.number().int().nonnegative(),settings:scheduleSettingsSchema}).strict(),
  z.object({type:z.literal("release"),requestId:z.string().uuid(),revision:z.number().int().nonnegative(),holdId:z.string().uuid()}).strict(),
]);
function readyToSave(board:Board,now:number,action:string,actor:string,target:string){
  requireThat(board.audit.length<5000,"Workflow audit capacity reached",409);
  board.revision++;board.updatedAt=new Date(now).toISOString();
  board.audit.push({at:board.updatedAt,actor,action,target,detail:action});
  requireThat(Buffer.byteLength(JSON.stringify(board),"utf8")<=8*1024*1024,"Workflow storage capacity reached",409);
}
export function publicHold(hold:ScheduleHold){
  const {owner,requestId,digest,...value}=hold;return value;
}
export async function createScheduleHold(shopId:number,owner:string,raw:unknown,deps:ScheduleDependencies){
  const parsed=holdRequestSchema.safeParse(raw);
  requireThat(parsed.success,"Invalid hold. Supply UTC/offset times, technician, and a UUID requestId.",400);
  const input=parsed.data,hash=digest(input);
  for(let attempt=0;attempt<4;attempt++){
    const now=deps.now(),board=await deps.read(shopId);
    const previous=board.schedule?.holds.find(h=>h.owner===owner&&h.requestId===input.requestId);
    if(previous){
      requireThat(previous.digest===hash,"requestId was already used for a different hold.",409);
      requireThat(!previous.releasedAt&&Date.parse(previous.expiresAt)>now,"This hold expired or was released. Use a new requestId to request a new slot.",410);
      return publicHold(previous);
    }
    const start=Date.parse(input.start),end=Date.parse(input.end),duration=(end-start)/60_000;
    requireThat(Number.isInteger(duration)&&duration>=15&&duration<=480&&start%900_000===0,"Use a 15-minute slot boundary and a duration of 15–480 minutes.",400);
    const settings=board.schedule?.settings;
    requireThat(settings?.enabled,"Scheduling is not enabled for this shop.",409);
    const date=localParts(start,settings.timeZone).date;
    const next=new Date(Date.parse(`${date}T00:00:00Z`)+86400_000).toISOString().slice(0,10);
    const query=availabilityQuerySchema.parse({startDate:date,endDate:next,durationMinutes:duration,technicianId:input.technicianId,...(input.resourceId?{resourceId:input.resourceId}:{}),...(input.skillKey?{skillKey:input.skillKey}:{})});
    const available=availability(board,query,now);
    requireThat(!available.reasons.length,available.reasons.join(" "),409);
    requireThat(available.slots.some(s=>Date.parse(s.start)===start&&Date.parse(s.end)===end),"This time is no longer available. Request availability again.",409);
    const holds=(board.schedule?.holds??[]).filter(h=>now-Date.parse(h.createdAt)<86400_000||Date.parse(h.expiresAt)>now);
    requireThat(holds.length<500,"Hold capacity reached. Try later.",429);
    const hold:ScheduleHold={...input,id:randomUUID(),owner,digest:hash,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+5*60_000).toISOString(),releasedAt:null};
    board.schedule={...board.schedule,holds:[...holds,hold]};
    const revision=board.revision;
    readyToSave(board,now,"schedule.hold","scheduler",hold.id);
    if(await deps.save(shopId,revision,board))return publicHold(hold);
  }
  throw new DispatchError(409,"Capacity changed during reservation. Retry the same requestId.");
}
export async function releaseScheduleHold(shopId:number,owner:string,holdId:string,deps:ScheduleDependencies,manager=false){
  for(let attempt=0;attempt<4;attempt++){
    const board=await deps.read(shopId),hold=board.schedule?.holds.find(h=>h.id===holdId);
    requireThat(hold&&(manager||hold.owner===owner),"Hold not found",404);
    if(hold.releasedAt)return publicHold(hold);
    const now=deps.now(),revision=board.revision;
    hold.releasedAt=new Date(now).toISOString();
    readyToSave(board,now,"schedule.release",manager?"manager":"scheduler",hold.id);
    if(await deps.save(shopId,revision,board))return publicHold(hold);
  }
  throw new DispatchError(409,"Workflow changed. Retry this release.");
}
export async function executeScheduleCommand(shopId:number,email:string,raw:unknown,deps:ScheduleDependencies){
  const parsed=scheduleCommandSchema.safeParse(raw);requireThat(parsed.success,"Invalid scheduling settings or command.",400);
  const command=parsed.data,board=await deps.read(shopId),hash=digest(command);
  const receipt=board.receipts.find(r=>r.id===command.requestId);
  if(receipt){requireThat(receipt.actor===email&&receipt.digest===hash,"Request ID reused",409);return board;}
  requireThat(command.revision===board.revision,"The board changed. Reload the latest scheduling form before saving.",409);
  const now=deps.now();
  if(command.type==="settings"){
    requireThat(activeHolds(board,now).length===0,"Release active holds before changing scheduling rules.",409);
    requireThat(new Set(command.settings.technicians.map(t=>t.id)).size===command.settings.technicians.length&&new Set(command.settings.resources.map(t=>t.id)).size===command.settings.resources.length,"Each technician or bay may have only one schedule.",400);
    requireThat(command.settings.technicians.every(t=>board.technicians.some(x=>x.id===t.id))&&command.settings.resources.every(r=>resourcesFor(board).some(x=>x.id===r.id)),"Schedule references an unknown technician or bay.",400);
    board.schedule={...board.schedule,holds:board.schedule?.holds??[],settings:command.settings};
  }else{
    const hold=board.schedule?.holds.find(h=>h.id===command.holdId);requireThat(hold,"Hold not found",404);hold.releasedAt=new Date(now).toISOString();
  }
  requireThat(board.receipts.length<5000,"Receipt capacity reached.",409);
  board.receipts.push({id:command.requestId,actor:email,digest:hash});
  readyToSave(board,now,`schedule.${command.type}`,email,command.type==="release"?command.holdId:"settings");
  requireThat(await deps.save(shopId,command.revision,board),"Workflow changed. Reload and review before saving.",409);
  return board;
}
/** Shared appointment snapshots commit under the same CAS as plans and holds. */
export async function storeAppointmentSnapshot(shopId:number,snapshot:AppointmentSnapshot,deps:ScheduleDependencies){
  validateDateRange(snapshot.startDate,snapshot.endDate);
  for(let attempt=0;attempt<4;attempt++){
    const board=await deps.read(shopId),revision=board.revision;
    // A slower older fetch must not replace a newer view of the provider.
    if(board.schedule?.appointments&&Date.parse(board.schedule.appointments.fetchedAt)>Date.parse(snapshot.fetchedAt))return board;
    board.schedule={...board.schedule,holds:board.schedule?.holds??[],appointments:snapshot};
    readyToSave(board,deps.now(),"schedule.appointments","provider-read","calendar");
    if(await deps.save(shopId,revision,board))return board;
  }
  throw new DispatchError(409,"Workflow changed while refreshing appointments. Retry.");
}
export const schedulerOwner=(keyHash:string)=>createHash("sha256").update(`schedule:${keyHash}`).digest("hex");
export function queryFromUrl(url:URL):AvailabilityQuery{
  const values=Object.fromEntries(url.searchParams);
  const parsed=availabilityQuerySchema.safeParse(values);requireThat(parsed.success,"Invalid availability parameters.",400);
  validateDateRange(parsed.data.startDate,parsed.data.endDate);return parsed.data;
}
