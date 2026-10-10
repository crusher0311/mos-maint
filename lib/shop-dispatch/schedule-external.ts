import { NextRequest } from "next/server";
import type { ExternalApiContext } from "@/lib/external-api/middleware";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { DispatchError, requireThat } from "./model";
import { dispatchFailure,dispatchJson } from "./http";
import { scheduleDependencies as deps } from "./schedule-runtime";
import { refreshAppointments } from "./appointments";
import { availability,localParts } from "./schedule-engine";
import { createScheduleHold,releaseScheduleHold,holdRequestSchema,queryFromUrl,schedulerOwner,publicHold } from "./schedule-service";
import { z } from "zod";

async function allowed(context:ExternalApiContext){
  // Do not accept arbitrary shop query/body IDs or a global partner key's shopId=0.
  requireThat(!context.isPartner&&Number.isSafeInteger(context.shopId)&&context.shopId>0,"Use a shop-scoped scheduler API key.",403);
  const entitlements=await getFeatureEntitlements(context.shopId);
  requireThat(entitlements.isFeatureEnabled("shop_workflow"),"Workflow is not enabled for this shop.",403);
}
async function boundedJson(req:Request){
  requireThat((req.headers.get("content-type")??"").split(";")[0]==="application/json","JSON required",415);
  const reader=req.body?.getReader();requireThat(reader,"Body required",400);
  const chunks:Uint8Array[]=[];let length=0;
  for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>8192){await reader.cancel();throw new DispatchError(413,"Request exceeds size limit");}chunks.push(next.value);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{return null;}
}
export async function externalAvailability(req:NextRequest,context:ExternalApiContext){
  try{
    await allowed(context);const query=queryFromUrl(req.nextUrl);
    const board=await refreshAppointments(context.shopId,query.startDate,query.endDate,deps);
    const result=availability(board,query,deps.now());
    return dispatchJson(result,result.reasons.length?409:200);
  }catch(error){return dispatchFailure(error);}
}
export async function externalCreateHold(req:NextRequest,context:ExternalApiContext){
  try{
    await allowed(context);
    const parsed=holdRequestSchema.safeParse(await boundedJson(req));requireThat(parsed.success,"Invalid hold request.",400);
    const board=await deps.read(context.shopId),settings=board.schedule?.settings;
    requireThat(settings?.enabled,"Scheduling is disabled.",409);
    const date=localParts(Date.parse(parsed.data.start),settings.timeZone).date;
    const end=new Date(Date.parse(`${date}T00:00:00Z`)+86400_000).toISOString().slice(0,10);
    const previous=board.schedule?.holds.find(h=>h.owner===schedulerOwner(context.apiKey.keyHash)&&h.requestId===parsed.data.requestId);
    if(!previous)await refreshAppointments(context.shopId,date,end,deps,true);
    const hold=await createScheduleHold(context.shopId,schedulerOwner(context.apiKey.keyHash),parsed.data,deps);
    return dispatchJson({hold,reservedIn:"MOS",providerAppointmentCreated:false},201);
  }catch(error){return dispatchFailure(error);}
}
export async function externalReadHold(req:NextRequest,context:ExternalApiContext){
  try{
    await allowed(context);const parsed=z.object({holdId:z.string().uuid()}).strict().safeParse(Object.fromEntries(req.nextUrl.searchParams));
    requireThat(parsed.success,"Supply holdId",400);
    const board=await deps.read(context.shopId),hold=board.schedule?.holds.find(h=>h.id===parsed.data.holdId&&h.owner===schedulerOwner(context.apiKey.keyHash));
    requireThat(hold,"Hold not found",404);
    return dispatchJson({hold:publicHold(hold),active:!hold.releasedAt&&Date.parse(hold.expiresAt)>deps.now()});
  }catch(error){return dispatchFailure(error);}
}
export async function externalReleaseHold(req:NextRequest,context:ExternalApiContext){
  try{
    await allowed(context);const parsed=z.object({holdId:z.string().uuid()}).strict().safeParse(await boundedJson(req));
    requireThat(parsed.success,"Supply holdId",400);
    return dispatchJson({hold:await releaseScheduleHold(context.shopId,schedulerOwner(context.apiKey.keyHash),parsed.data.holdId,deps)});
  }catch(error){return dispatchFailure(error);}
}
