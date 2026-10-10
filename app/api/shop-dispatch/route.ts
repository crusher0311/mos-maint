import { dispatchFailure, dispatchJson, dispatchSession, dispatchSnapshot, requestBody } from "@/lib/shop-dispatch/http";
import { executeDispatchMutation } from "@/lib/shop-dispatch/service";
import { readDispatchBoard, saveDispatchBoard } from "@/lib/data/repositories/shop-dispatch";
import { fetchDispatchWorkOrder, fetchDispatchWorkOrderByNumber } from "@/lib/shop-dispatch/protractor";
import { getSession } from "@/lib/auth";
import { fetchDispatchEmployee } from "@/lib/shop-dispatch/roster";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";
export const dynamic="force-dynamic";
export const runtime="nodejs";
export async function GET(){
  try{
    const session=await getSession();
    if(!session)return dispatchJson({error:"Sign in to use shop workflow"},401);
    return dispatchJson(await dispatchSnapshot(await dispatchSession(session)));
  }catch(e){return dispatchFailure(e);}
}
export async function POST(req:Request){
  try{
    const authenticated=await getSession();
    if(!authenticated)return dispatchJson({error:"Sign in to use shop workflow"},401);
    const session=await dispatchSession(authenticated),body=await requestBody(req);
    const board=await executeDispatchMutation(session,body,{read:readDispatchBoard,save:saveDispatchBoard,
      intake:(shopId,id)=>runWithProtractorInteractiveTransport(shopId,()=>fetchDispatchWorkOrder(shopId,id)),
      intakeByNumber:(shopId,number)=>runWithProtractorInteractiveTransport(shopId,()=>fetchDispatchWorkOrderByNumber(shopId,number)),
      employee:(shopId,id)=>runWithProtractorInteractiveTransport(shopId,()=>fetchDispatchEmployee(shopId,id)),now:()=>new Date().toISOString()});
    return dispatchJson(await dispatchSnapshot(session,board));
  }catch(e){return dispatchFailure(e);}
}
