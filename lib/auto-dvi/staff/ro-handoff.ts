import { z } from "zod";
import { applyCommand, requireThat, type Board, type Intake } from "@/lib/shop-dispatch/model";
import { assertHeldCapacityPreserved } from "@/lib/shop-dispatch/schedule-engine";
export const handoffSchema = z.object({
  requestId:z.string().uuid(),workOrderId:z.string().uuid().transform(s=>s.toLowerCase()),
  workOrderNumber:z.number().int().positive(),
}).strict();
type Access = {shopId:number;actor:string;email:string;canEdit:boolean};
export async function handoffRO(raw:unknown,deps:{
  access:()=>Promise<Access>;read:(shop:number)=>Promise<Board>;
  save:(shop:number,revision:number,board:Board)=>Promise<boolean>;
  fetch:(shop:number,id:string)=>Promise<Intake>;now:()=>string;
}) {
  const req=handoffSchema.parse(raw),access=await deps.access();
  requireThat(access.canEdit,"DVI intake is not enabled for this location or user",403);
  const intake=await deps.fetch(access.shopId,req.workOrderId);
  requireThat(intake.sourceId.toLowerCase()===req.workOrderId&&Number(intake.ro)===req.workOrderNumber,
    "The confirmed RO does not match the provider ticket",409);
  for(let attempt=0;attempt<3;attempt++){
    const fresh=await deps.access();
    requireThat(fresh.canEdit&&fresh.shopId===access.shopId&&fresh.actor===access.actor,"DVI access changed",403);
    const before=await deps.read(access.shopId);
    const existing=before.visits.find(v=>v.provider==="protractor"&&v.sourceId===req.workOrderId);
    requireThat(!existing?.closed,"Closed visits cannot start a new DVI",409);
    const now=deps.now(),next=applyCommand(before,{type:"sync",workOrderId:req.workOrderId},
      {email:access.email,manager:true,technicianId:null},now,intake);
    assertHeldCapacityPreserved(before,next,Date.parse(now));
    requireThat(next.visits.length<=500&&next.jobs.length<=2500&&next.audit.length<=5000&&
      Buffer.byteLength(JSON.stringify(next))<8*1024*1024,"Workflow storage capacity reached",409);
    if(await deps.save(access.shopId,before.revision,next)){
      const visit=next.visits.find(v=>v.provider==="protractor"&&v.sourceId===req.workOrderId)!;
      return {visitId:visit.id,href:`/dashboard/shop-workflow?visit=${encodeURIComponent(visit.id)}&dvi=1`};
    }
  }
  requireThat(false,"RO exists, but workflow changed during handoff. Retry opening DVI, not creating the RO.",409);
}
