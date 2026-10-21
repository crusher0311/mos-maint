import { getSession } from "@/lib/auth";
import { staffAccess,staffMemberAccess } from "@/lib/auto-dvi/staff/access";
import { CheckInDrafts } from "@/lib/data/repositories/check-in-drafts";
import { dispatchFailure,dispatchJson,requestBody } from "@/lib/shop-dispatch/http";
import { requireThat } from "@/lib/shop-dispatch/model";
import { z,ZodError } from "zod";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const drafts=new CheckInDrafts();
async function access(){
  requireThat(await getSession(),"Sign in required",401);
  const a=await staffAccess();
  requireThat(a.canEdit&&a.canReview,"Advisor check-in access required",403);
  return a;
}
export async function GET(req:Request){
  try{
    const a=await access(),email=new URL(req.url).searchParams.get("email");
    if(email){
      const target=await staffMemberAccess(a.shopId,z.string().email().max(254).parse(email).toLowerCase());
      requireThat(target.canEdit&&target.canReview&&target.actor!==a.actor,"Select another authorized advisor",403);
      return dispatchJson({coworker:{email:target.email,actor:target.actor}});
    }
    return dispatchJson({offers:await drafts.offers(a)});
  }catch(e){return e instanceof ZodError?dispatchJson({error:"Invalid coworker"},400):dispatchFailure(e);}
}
export async function POST(req:Request){
  try{
    const a=await access(),body=await requestBody(req,4096);
    const row=await drafts.transfer(a,body,async email=>{
      const member=await staffMemberAccess(a.shopId,email);
      requireThat(member.canEdit&&member.canReview,"Coworker permission revoked or unavailable",403);
      return member;
    },a.email);
    return dispatchJson({draft:drafts.public(row)});
  }catch(e){return e instanceof ZodError?dispatchJson({error:"Invalid transfer"},400):dispatchFailure(e);}
}
