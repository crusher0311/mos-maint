import { getSession } from "@/lib/auth";
import { dispatchSession, dispatchFailure, dispatchJson, requestBody } from "@/lib/shop-dispatch/http";
import { actorFor, requireThat, DispatchError } from "@/lib/shop-dispatch/model";
import { scheduleBoardView } from "@/lib/shop-dispatch/schedule-view";
import { executeIntake } from "@/lib/shop-dispatch/intake-service";
import { intakeDependencies, intakeLookup } from "@/lib/shop-dispatch/intake-runtime";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";
export const dynamic="force-dynamic";
export const runtime="nodejs";
async function authorized(){
  const session=await dispatchSession(await getSession());
  requireThat(actorFor(await intakeDependencies.read(session.shopId),session.email,session.role).manager,"Manager access required",403);
  return session;
}
export async function GET(req:Request){
  try{
    const session=await authorized();
    return dispatchJson(await runWithProtractorInteractiveTransport(session.shopId,()=>intakeLookup(session.shopId,new URL(req.url))));
  }catch(error){return dispatchFailure(error);}
}
export async function POST(req:Request){
  try{
    const session=await authorized(),body=await requestBody(req);
    // Deadline bounds the HTTP response only; admitted provider I/O may continue.
    // Intent recovery never resends an attempted stage.
    const board=await runWithProtractorInteractiveTransport(session.shopId,async()=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        return await Promise.race([executeIntake(session,body,intakeDependencies),new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>reject(new DispatchError(503,"Intake outcome is uncertain. Refresh the board and recover the saved ticket operation; do not start another ticket.")),55000);
        })]);
      }finally{clearTimeout(timer);}
    });
    return dispatchJson({board:scheduleBoardView(board,session.email)});
  }catch(error){return dispatchFailure(error);}
}
