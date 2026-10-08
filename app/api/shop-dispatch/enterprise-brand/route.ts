import { z } from "zod";
import { dispatchFailure, dispatchJson, dispatchSession, dispatchSnapshot, enterpriseContext, requestBody } from "@/lib/shop-dispatch/http";
import { brandSchema, requireThat } from "@/lib/shop-dispatch/model";
import { digest } from "@/lib/shop-dispatch/service";
import { readDispatchEnterpriseBrand, saveDispatchEnterpriseBrand } from "@/lib/data/repositories/shop-dispatch";
import { getSession } from "@/lib/auth";
export const dynamic="force-dynamic";
export const runtime="nodejs";
const schema=z.object({requestId:z.string().uuid(),revision:z.number().int().nonnegative(),brand:brandSchema.nullable()}).strict();
export async function POST(req:Request){
  try{
    const authenticated=await getSession();
    if(!authenticated)return dispatchJson({error:"Sign in to use shop workflow"},401);
    const session=await dispatchSession(authenticated);
    const context=await enterpriseContext(session);
    requireThat(context?.canEdit,"Enterprise owner/admin access required",403);
    const result=schema.safeParse(await requestBody(req));requireThat(result.success,"Invalid branding settings",400);
    const {requestId,revision,brand}=result.data,actor=session.email.toLowerCase(),hash=digest(brand);
    const existing=context.stored.receipts.find(r=>r.id===requestId);
    if(existing){requireThat(existing.actor===actor&&existing.digest===hash,"Request ID already used",409);}
    else{
      requireThat(revision===context.revision,"Enterprise brand changed. Refresh and review before saving.",409);
      requireThat(context.stored.receipts.length<5000,"Brand audit capacity reached; arrange archival.",409);
      const next={...context.stored,brand,revision:revision+1,receipts:[...context.stored.receipts,{id:requestId,actor,digest:hash}],
        audit:[...context.stored.audit,{at:new Date().toISOString(),actor,name:brand?.name??null,primary:brand?.primary??null,accent:brand?.accent??null,logoDigest:brand?.logo?digest(brand.logo):null}]};
      if(!await saveDispatchEnterpriseBrand(next,revision)){
        const latest=await readDispatchEnterpriseBrand(context.id);
        requireThat(latest.receipts.some(r=>r.id===requestId&&r.actor===actor&&r.digest===hash),"Enterprise brand changed. Refresh and retry.",409);
      }
    }
    return dispatchJson(await dispatchSnapshot(session));
  }catch(e){return dispatchFailure(e);}
}
