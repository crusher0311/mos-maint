import { getSession } from "@/lib/auth";
import { actorFor, requireThat } from "@/lib/shop-dispatch/model";
import { dispatchFailure,dispatchJson,dispatchSession,requestBody } from "@/lib/shop-dispatch/http";
import { availability } from "@/lib/shop-dispatch/schedule-engine";
import { refreshAppointments } from "@/lib/shop-dispatch/appointments";
import { executeScheduleCommand,queryFromUrl } from "@/lib/shop-dispatch/schedule-service";
import { scheduleDependencies as deps } from "@/lib/shop-dispatch/schedule-runtime";
import { scheduleBoardView } from "@/lib/shop-dispatch/schedule-view";
export const runtime="nodejs";
export const dynamic="force-dynamic";
async function manager(){
  const session=await dispatchSession(await getSession()),board=await deps.read(session.shopId);
  requireThat(actorFor(board,session.email,session.role).manager,"Only managers may manage scheduling",403);
  return session;
}
export async function GET(req:Request){
  try{
    const session=await manager(),query=queryFromUrl(new URL(req.url));
    const board=await refreshAppointments(session.shopId,query.startDate,query.endDate,deps);
    return dispatchJson({board:scheduleBoardView(board,session.email),availability:availability(board,query,deps.now())});
  }catch(error){return dispatchFailure(error);}
}
export async function POST(req:Request){
  try{
    const session=await manager(),body=await requestBody(req);
    const board=await executeScheduleCommand(session.shopId,session.email.toLowerCase(),body,deps);
    return dispatchJson({board:scheduleBoardView(board,session.email)});
  }catch(error){return dispatchFailure(error);}
}
