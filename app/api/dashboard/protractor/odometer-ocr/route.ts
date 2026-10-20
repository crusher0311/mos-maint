import { getSession } from "@/lib/auth";
import { checkInAccess } from "@/lib/auto-dvi/staff/check-in-access";
import { CheckInDrafts,draftFenceSchema } from "@/lib/data/repositories/check-in-drafts";
import { getOpenAI,trackOpenAiCall } from "@/lib/ai";
import { enforceAiBudget } from "@/lib/ai-budget";
import { dispatchJson,dispatchFailure,requestBody } from "@/lib/shop-dispatch/http";
import { requireThat } from "@/lib/shop-dispatch/model";
import { odometerPrompt,parseOdometerResponse } from "@/lib/auto-dvi/staff/odometer-interpretation";
import { photoMime } from "@/lib/data/repositories/workflow-inspections";
import { z,ZodError } from "zod";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const schema=z.object({_guidedDraft:draftFenceSchema,photoRequestId:z.string().uuid(),interpretationRequestId:z.string().uuid()}).strict();
const drafts=new CheckInDrafts();
export async function POST(req:Request){
  try{
    requireThat(await getSession(),"Sign in required",401);
    const s=await checkInAccess(),input=schema.parse(await requestBody(req,5000));
    await drafts.fence(s,input._guidedDraft);
    const photo=await drafts.photo(s,input._guidedDraft.id,input.photoRequestId);
    requireThat(photo.bytes.length<=4*1024*1024&&photoMime(photo.bytes)===photo.mime,"Invalid saved image",400);
    const blocked=await enforceAiBudget({shopId:s.shopId,route:"/api/dashboard/protractor/odometer-ocr",isPlatformAdmin:false});
    if(blocked)return blocked;
    const admission=await drafts.reserveScan(s,input._guidedDraft,input.photoRequestId,input.interpretationRequestId);
    if(!admission.send)return admission.result?dispatchJson({result:admission.result}):dispatchJson({error:"This photo scan is unconfirmed. Your photo is saved; enter mileage manually or use a new photo."},409);
    const start=Date.now();
    try{
      const completion=await getOpenAI().chat.completions.create({
        model:"gpt-4o",temperature:0,max_tokens:180,response_format:{type:"json_object"},
        messages:[{role:"system",content:odometerPrompt},{role:"user",content:[{type:"image_url",image_url:{url:`data:${photo.mime};base64,${photo.bytes.toString("base64")}`,detail:"high"}}]}],
      },{timeout:20000,maxRetries:0});
      trackOpenAiCall(s.shopId,"/api/dashboard/protractor/odometer-ocr",completion,Date.now()-start);
      const result=parseOdometerResponse(completion.choices[0]?.message?.content??"");
      await drafts.confirmScan(s,input._guidedDraft.id,input.photoRequestId,result);
      return dispatchJson({result});
    }catch{
      return dispatchJson({error:"Odometer interpretation could not be confirmed. The photo is saved and mileage is unchanged. Enter it manually or capture another photo."},503);
    }
  }catch(e){return e instanceof ZodError||e instanceof SyntaxError?dispatchJson({error:"Invalid odometer scan request"},400):dispatchFailure(e);}
}
