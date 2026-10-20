import { z,ZodError } from "zod";
import { staffAccess } from "@/lib/auto-dvi/staff/access";
import { getSession } from "@/lib/auth";
import { ROArrivalPhotos } from "@/lib/data/repositories/ro-arrival-photos";
import { effectiveInspectionPermission } from "@/lib/auto-dvi/workflow-policy";
import { readDispatchBoard } from "@/lib/data/repositories/shop-dispatch";
import { requireThat } from "@/lib/shop-dispatch/model";
import { dispatchJson,dispatchFailure,requestBody } from "@/lib/shop-dispatch/http";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const photos=new ROArrivalPhotos();
async function requirePhotoSession(){
  const session=await getSession();
  requireThat(session?.email&&!session.isTestAuth&&!session.mustChangePassword,"Dashboard sign-in required",401);
  // Also verifies the actual cookie, current membership, entitlement and policy.
  return staffAccess();
}
const upload=z.object({requestId:z.string().uuid(),workOrderId:z.string().uuid().transform(s=>s.toLowerCase()),
  mime:z.enum(["image/jpeg","image/png","image/webp"]),base64:z.string().max(5592408).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict();
export async function POST(req:Request){
  try{
    const a=await requirePhotoSession();requireThat(a.canEdit,"DVI arrival photos are not enabled",403);
    const input=upload.parse(await requestBody(req,5700000));
    await photos.requireConfirmed(a.shopId,input.workOrderId);
    const fresh=await staffAccess();requireThat(fresh.canEdit&&fresh.shopId===a.shopId&&fresh.actor===a.actor,"Access changed",403);
    return dispatchJson({photo:await photos.put(a.shopId,input.workOrderId,input.requestId,input.mime,Buffer.from(input.base64,"base64"))});
  }catch(e){return e instanceof ZodError||e instanceof SyntaxError?dispatchJson({error:"Invalid arrival photo"},400):dispatchFailure(e);}
}
export async function GET(req:Request){
  try{
    const a=await requirePhotoSession();requireThat(a.enabled&&effectiveInspectionPermission(a.authority,a.shopId,"read").allowed,"DVI arrival photos are not enabled",403);
    const p=new URL(req.url).searchParams;let workOrderId=p.get("workOrderId");
    if(p.has("visitId")){
      const board=await readDispatchBoard(a.shopId),visit=board.visits.find(v=>v.id===p.get("visitId"));
      requireThat(visit?.provider==="protractor"&&visit.sourceId,"Linked visit required",404);workOrderId=visit.sourceId;
    }
    const id=z.string().uuid().parse(workOrderId).toLowerCase();
    if(!p.has("mediaId"))return dispatchJson({photos:await photos.list(a.shopId,id)});
    const mediaId=z.string().regex(/^[a-f0-9]{24}$/).parse(p.get("mediaId")),file=await photos.read(a.shopId,id,mediaId);
    return new Response(new Uint8Array(file.bytes),{headers:{"Content-Type":file.mime,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'"}});
  }catch(e){return e instanceof ZodError?dispatchJson({error:"Invalid photo identity"},400):dispatchFailure(e);}
}
