import { deriveIdempotentUpstreamId } from "../idempotent-create-id";
import { actorFor, applyCommand, requireThat, type Board, type Intake, type Job, type Visit } from "./model";
import { digest, type Principal } from "./service";
import { intakeRequestSchema, type IntakeDetails, type TicketIntent } from "./intake-types";
import { assertHeldCapacityPreserved } from "./schedule-engine";

export interface IntakeDependencies {
  read:(shop:number)=>Promise<Board>;
  save:(shop:number,revision:number,board:Board)=>Promise<boolean>;
  now:()=>string;
  verifyIdentity:(shop:number,details:IntakeDetails)=>Promise<void>;
  byNumber:(shop:number,number:string)=>Promise<Intake>;
  /** Exact-ID reads must verify the contact/vehicle relationship and every package. */
  confirm:(shop:number,intent:TicketIntent)=>Promise<{intake:Intake;packages:{jobId:string;sourceId:string}[]}|null>;
  confirmEntity:(shop:number,intent:TicketIntent,stage:"contact"|"vehicle")=>Promise<boolean>;
  write:(shop:number,intent:TicketIntent,stage:"contact"|"vehicle"|"workOrder")=>Promise<void>;
}
const manager=(board:Board,p:Principal)=>{const a=actorFor(board,p.email,p.role);requireThat(a.manager,"Manager access required",403);return a;};
const getVisit=(board:Board,id:string)=>{const v=board.visits.find(v=>v.id===id&&!v.closed);requireThat(v,"Open workflow visit not found",404);return v;};
function changed(board:Board,p:Principal,now:string,action:string,target:string,detail:string){
  requireThat(board.audit.length<5000,"Workflow audit capacity reached",409);
  board.audit.push({at:now,actor:p.email,action,target,detail});
  board.revision++;board.updatedAt=now;
  requireThat(board.visits.length<=500&&board.jobs.length<=2500&&Buffer.byteLength(JSON.stringify(board))<8*1024*1024,"Workflow storage capacity reached",409);
}
async function persist(p:Principal,before:Board,after:Board,deps:IntakeDependencies){
  assertHeldCapacityPreserved(before,after,Date.parse(deps.now()));
  requireThat(await deps.save(p.shopId,before.revision,after),"Workflow changed. Refresh and review; no new provider write was admitted.",409);
}
function localJobs(visitId:string,details:IntakeDetails):Job[]{
  return details.concerns.map((title,index)=>({id:`${visitId}:intake:${index}`,visitId,title,technicianId:null,plannedStart:null,estimatedMinutes:null,bookMinutes:null,
    prerequisites:[],resource:null,status:"idle",activeMs:0,waitingMs:0,since:null,pauseReason:null,sourceId:null,sourceRemoved:false,authorized:false}));
}
/** Merge by verified provider identity only; never by RO-number coincidence. */
export function bindTicket(board:Board,visitId:string,intake:Intake,now:string,packages:{jobId:string;sourceId:string}[]=[]){
  const visit=getVisit(board,visitId),id=intake.sourceId.toLowerCase();
  requireThat(!visit.sourceId||visit.sourceId===id,"Visit is already linked to a different ticket",409);
  const other=board.visits.find(v=>v.id!==visit.id&&v.provider==="protractor"&&v.sourceId===id);
  if(other){
    requireThat(!other.closed&&!other.intake,"Ticket belongs to another checked-in or closed visit; manager resolution required",409);
    // Conflicting customer plans cannot be silently overwritten.
    requireThat(!other.arrivalAt&&!other.promiseAt&&other.transport.customerPlan==="unknown"&&other.transport.ride==="none"&&other.transport.loaner==="none"&&!other.transport.notes&&!other.transport.pickupAt,
      "Imported visit has local customer commitments; resolve them before linking",409);
    for(const job of board.jobs.filter(j=>j.visitId===other.id))job.visitId=visit.id;
    board.visits=board.visits.filter(v=>v.id!==other.id);
    // Audit targets remain unchanged: append the reconciliation identity.
    board.audit.push({at:now,actor:"system:ticket-link",action:"merge-visit",target:visit.id,detail:`Retained all jobs and history from ${other.id}`});
  }
  for(const mapping of packages){
    requireThat(intake.jobs.some(j=>j.sourceId.toLowerCase()===mapping.sourceId.toLowerCase()),"Expected package is not verified",409);
    const local=board.jobs.find(j=>j.id===mapping.jobId&&j.visitId===visitId);
    requireThat(local,"Local intake job is missing",409);
    const duplicate=board.jobs.find(j=>j.id!==local.id&&j.visitId===visitId&&j.sourceId===mapping.sourceId.toLowerCase());
    // Never discard a job that has been planned, worked, reviewed or referenced.
    if(duplicate){
      requireThat(duplicate.status==="idle"&&!duplicate.technicianId&&!duplicate.plannedStart&&!duplicate.resource&&!duplicate.operations&&!duplicate.activeMs&&!duplicate.waitingMs&&!duplicate.authorized&&!board.jobs.some(j=>j.prerequisites.includes(duplicate.id)),
        "Imported package has local work; explicit package reconciliation required",409);
      board.jobs=board.jobs.filter(j=>j.id!==duplicate.id);
    }
    local.sourceId=mapping.sourceId.toLowerCase();
  }
  Object.assign(visit,{provider:"protractor",sourceId:id});
  // Existing model uses explicit package sourceId, keeping manual job IDs stable.
  const synced=applyCommand(board,{type:"sync",workOrderId:id},{email:"system:ticket-link",manager:true,technicianId:null},now,intake);
  // Outer transaction owns the single revision.
  synced.revision=board.revision;
  return synced;
}

export async function executeIntake(p:Principal,raw:unknown,deps:IntakeDependencies):Promise<Board>{
  const parsed=intakeRequestSchema.safeParse(raw);requireThat(parsed.success,"Invalid intake details",400);
  const req=parsed.data;
  let before=await deps.read(p.shopId);manager(before,p);
  if(req.action==="reconcile")return recoverTicket(p,req.visitId,deps);
  const hash=digest(req),receipt=before.receipts.find(r=>r.id===req.requestId);
  if(receipt){requireThat(receipt.actor===p.email&&receipt.digest===hash,"Request ID is already bound to different intake details",409);return before;}
  requireThat(before.revision===req.revision,"Workflow changed. Refresh and explicitly review the intake before resubmitting.",409);
  requireThat(before.receipts.length<5000,"Workflow receipt capacity reached",409);
  let board=structuredClone(before);const now=deps.now();
  let target:string;
  if(req.action==="checkIn"){
    const existing=req.appointmentId?board.visits.find(v=>v.intake?.appointmentId===req.appointmentId):undefined;
    if(existing)return before; // Different staff/key may only open the original check-in.
    if(req.appointmentId){
      const snapshot=board.schedule?.appointments;
      requireThat(snapshot?.appointments.some(a=>a.id===req.appointmentId),"Appointment is not in this shop's snapshot",409);
      requireThat(snapshot?.complete&&Date.parse(now)-Date.parse(snapshot.fetchedAt)<=300000&&Date.parse(snapshot.fetchedAt)<=Date.parse(now)+5000,"Refresh stale or incomplete appointments before check-in",409);
    }
    if(req.details.vehicleId)requireThat(!board.visits.some(v=>!v.closed&&v.intake?.details.vehicleId===req.details.vehicleId),"This vehicle already has an open intake; open that visit instead",409);
    if(req.details.identityConfirmed)await deps.verifyIdentity(p.shopId,req.details);
    const id=`intake:${digest([p.shopId,req.appointmentId??req.requestId]).slice(0,32)}`;target=id;
    board.visits.push({id,ro:"Local draft",vehicle:req.details.vehicle,customer:req.details.customer,arrivalAt:now,promiseAt:req.details.promiseAt,
      transport:{customerPlan:req.details.customerPlan,ride:"none",loaner:"none",loanerId:"",pickupAt:null,notes:""},
      closed:false,provider:"manual",sourceId:null,sourceStatus:null,sourceFetchedAt:null,
      intake:{requestId:req.requestId,appointmentId:req.appointmentId,checkedInAt:now,checkedInBy:p.email,details:req.details}});
    board.jobs.push(...localJobs(id,req.details));
  }else{
    const visit=getVisit(board,req.visitId);target=visit.id;
    const intent=board.ticketIntents?.find(i=>i.visitId===visit.id);
    if(req.action==="update"){
      if(intent||visit.sourceId){
        if(visit.intake){
          const identity=(d:IntakeDetails)=>[d.customer,d.vehicle,d.contactId,d.vehicleId,d.newCustomer,d.newVehicle,d.identityConfirmed,d.concerns];
          requireThat(digest(identity(req.details))===digest(identity(visit.intake.details)),"Ticket identity and requested concerns are locked; customer commitments can still be updated",409);
        }else requireThat(!intent,"Recover the saved ticket operation before changing identity",409);
      }
      if(req.details.identityConfirmed)await deps.verifyIdentity(p.shopId,req.details);
      // Editable customer details never recreate/erase existing jobs or their plans.
      if(visit.intake)requireThat(JSON.stringify(req.details.concerns)===JSON.stringify(visit.intake.details.concerns),"Edit requested jobs individually after check-in",409);
      else{
        visit.intake={appointmentId:null,checkedInAt:now,checkedInBy:p.email,details:req.details};
        visit.arrivalAt=visit.arrivalAt??now;
        board.jobs.push(...localJobs(visit.id,req.details));
      }
      visit.intake.details=req.details;visit.customer=req.details.customer;visit.vehicle=req.details.vehicle;
      visit.promiseAt=req.details.promiseAt;visit.transport.customerPlan=req.details.customerPlan;
    }else if(req.action==="link"){
      requireThat(!intent,"Recover the pending ticket operation before linking a different ticket",409);
      const upstream=await deps.byNumber(p.shopId,req.roNumber);
      requireThat(upstream.sourceId.toLowerCase()===req.expectedSourceId.toLowerCase(),"Ticket identity changed since review. Look it up and confirm again.",409);
      board=bindTicket(board,visit.id,upstream,now);
    }else{
      requireThat(!visit.sourceId,"This visit already has an official ticket",409);
      if(intent)return recoverTicket(p,visit.id,deps);
      const details=visit.intake?.details;requireThat(details?.identityConfirmed,"Confirm customer and vehicle identity first",409);
      requireThat((details.contactId||details.newCustomer)&&(details.vehicleId||details.newVehicle),"Choose or create both customer and vehicle",409);
      requireThat(!details.newCustomer||!details.vehicleId,"A new customer requires a new vehicle in this intake",409);
      await deps.verifyIdentity(p.shopId,details);
      const upstream=(kind:"contact"|"vehicle"|"workOrder")=>deriveIdempotentUpstreamId(kind,p.shopId,"workflow-intake",visit.id);
      const op:TicketIntent={id:req.requestId,visitId:visit.id,actor:p.email,digest:digest(details),createdAt:now,status:"pending",message:"Ticket creation admitted; verification pending.",
        payload:structuredClone(details),contactId:details.contactId??upstream("contact"),vehicleId:details.vehicleId??upstream("vehicle"),workOrderId:upstream("workOrder"),attempted:[]};
      board.ticketIntents=[...(board.ticketIntents??[]),op];
    }
  }
  board.receipts.push({id:req.requestId,actor:p.email,digest:hash});
  changed(board,p,now,`intake-${req.action}`,target,"Staff-confirmed intake action; no repair authorization or capacity release");
  try{await persist(p,before,board,deps);}
  catch(error){
    // A lost write acknowledgment or simultaneous identical check-in can have
    // committed already. Return that durable result, never tell the client to
    // generate another walk-in identity.
    const latest=await deps.read(p.shopId);manager(latest,p);
    if(latest.receipts.some(r=>r.id===req.requestId&&r.actor===p.email&&r.digest===hash))return latest;
    if(req.action==="checkIn"&&req.appointmentId&&latest.visits.some(v=>v.intake?.appointmentId===req.appointmentId))return latest;
    throw error;
  }
  return req.action==="create"?recoverTicket(p,req.visitId,deps):board;
}

/** Each stage is admitted by CAS before I/O. An ambiguous stage is read-only
 * thereafter: timeout does not cancel the upstream request, nor authorize replay.
 * Another manager can finish unattempted stages using the saved immutable payload. */
export async function recoverTicket(p:Principal,visitId:string,deps:IntakeDependencies):Promise<Board>{
  try{
    for(const stage of ["contact","vehicle","workOrder"] as const){
      const before=await deps.read(p.shopId);manager(before,p);getVisit(before,visitId);
      const op=before.ticketIntents?.find(i=>i.visitId===visitId);requireThat(op,"No pending ticket operation",404);
      if(op.status==="confirmed")return before;
      if(stage==="contact"&&!op.payload.newCustomer||stage==="vehicle"&&!op.payload.newVehicle)continue;
      const confirmed=stage==="workOrder"?await deps.confirm(p.shopId,op):await deps.confirmEntity(p.shopId,op,stage);
      if(confirmed)continue;
      if(op.attempted.includes(stage))return markUncertain(p,visitId,deps,`Awaiting exact-ID ${stage} verification. No duplicate write was sent. Refresh verification; if the provider never accepted it, an operator must resolve the saved operation.`);
      const board=structuredClone(before),next=board.ticketIntents!.find(i=>i.visitId===visitId)!;
      next.attempted.push(stage);next.status="pending";next.message=`${stage} write admitted; awaiting provider verification.`;
      changed(board,p,deps.now(),"ticket-stage",visitId,stage);
      await persist(p,before,board,deps);
      await deps.write(p.shopId,next,stage);
      const verified=stage==="workOrder"?await deps.confirm(p.shopId,next):await deps.confirmEntity(p.shopId,next,stage);
      if(!verified)return markUncertain(p,visitId,deps,`${stage} response is not yet verified. Retry verification, not creation.`);
    }
    for(let attempt=0;attempt<4;attempt++){
      const before=await deps.read(p.shopId);manager(before,p);
      const op=before.ticketIntents!.find(i=>i.visitId===visitId)!;
      if(op.status==="confirmed")return before;
      const verified=await deps.confirm(p.shopId,op);
      if(!verified)return markUncertain(p,visitId,deps,"Official ticket or packages are incomplete. Retry exact-ID verification; local work is preserved.");
      let board=bindTicket(structuredClone(before),visitId,verified.intake,deps.now(),verified.packages);
      const next=board.ticketIntents!.find(i=>i.visitId===visitId)!;next.status="confirmed";next.message="Official ticket and requested concern packages verified.";
      changed(board,p,deps.now(),"ticket-confirmed",visitId,op.workOrderId);
      assertHeldCapacityPreserved(before,board,Date.parse(deps.now()));
      if(await deps.save(p.shopId,before.revision,board))return board;
    }
    return markUncertain(p,visitId,deps,"Provider result awaits local finalization. Retry verification; do not create another ticket.");
  }catch{
    return markUncertain(p,visitId,deps,"Provider completion is uncertain or local finalization needs review. Retry verification; attempted writes are never automatically replayed.");
  }
}
async function markUncertain(p:Principal,visitId:string,deps:IntakeDependencies,message:string){
  for(let attempt=0;attempt<4;attempt++){
    const before=await deps.read(p.shopId);manager(before,p);
    const board=structuredClone(before),op=board.ticketIntents?.find(i=>i.visitId===visitId);
    requireThat(op,"No pending ticket operation",404);
    if(op.status==="confirmed")return before;
    op.status="uncertain";op.message=message;
    changed(board,p,deps.now(),"ticket-uncertain",visitId,"Verification required; upstream work may still be running");
    if(await deps.save(p.shopId,before.revision,board))return board;
  }
  requireThat(false,"Ticket intent is saved but its latest outcome is unconfirmed. Refresh and recover it.",503);
}
