import { ZodError } from "zod";
import { staffAccess } from "@/lib/auto-dvi/staff/access";
import { handoffRO } from "@/lib/auto-dvi/staff/ro-handoff";
import { readDispatchBoard,saveDispatchBoard } from "@/lib/data/repositories/shop-dispatch";
import { fetchDispatchWorkOrder } from "@/lib/shop-dispatch/protractor";
import { dispatchJson,dispatchFailure,requestBody } from "@/lib/shop-dispatch/http";
import { getSession } from "@/lib/auth";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { DispatchError } from "@/lib/shop-dispatch/model";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(){
  try{
    const session=await getSession(),token=(await cookies()).get("session_token")?.value;
    if(!session?.email||!token||session.token!==token||session.isTestAuth||session.token==="dev-auto-login"||/^exts?_/.test(token))
      return dispatchJson({error:"Dashboard sign-in required"},401);
    const context={shopId:Number(session.shopId),actorKey:createHash("sha256").update(`staff|${session.shopId}|${session.email.toLowerCase()}`).digest("hex")};
    try{const a=await staffAccess();return dispatchJson({enabled:a.canEdit,...context});}
    catch(e){if(e instanceof DispatchError&&e.status===403)return dispatchJson({enabled:false,...context});throw e;}
  }catch(e){return dispatchFailure(e);}
}
export async function POST(req:Request){
  try{return dispatchJson(await handoffRO(await requestBody(req),{
    access:staffAccess,read:readDispatchBoard,save:saveDispatchBoard,
    fetch:fetchDispatchWorkOrder,now:()=>new Date().toISOString(),
  }));}
  catch(e){return e instanceof ZodError?dispatchJson({error:"Invalid confirmed RO"},400):dispatchFailure(e);}
}
