import { NextRequest,NextResponse } from "next/server";
import { visitGate as requireSession,visitFailure,visitHeaders } from "@/lib/auto-dvi/visit-access";
import { normalizeVisitVin,VisitError } from "@/lib/auto-dvi/visit-model";
import { attachDviVisitMedia,readDviVisitMedia,readDviVisits } from "@/lib/data/repositories/auto-dvi";
import { resolveHistoryScope } from "@/lib/vehicle-history/service";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const PHOTOS=["image/jpeg","image/png","image/webp","image/gif"];
const VIDEOS=["video/mp4","video/webm","video/quicktime"];
export async function POST(req:NextRequest){
  try{
    const {session,shopId}=await requireSession(req,true);
    if(Number(req.headers.get("content-length"))>41*1024*1024)throw new VisitError("Upload too large",413);
    const form=await req.formData(),file=form.get("file");
    if(!(file instanceof File)||!file.size)throw new VisitError("Choose a photo or video");
    const kind=PHOTOS.includes(file.type)?"photo":VIDEOS.includes(file.type)?"video":null;
    if(!kind)throw new VisitError("Unsupported media type");
    if(file.size>(kind==="photo"?8:40)*1024*1024)throw new VisitError("Upload too large",413);
    const vin=normalizeVisitVin(form.get("vin")),revision=Number(form.get("revision"));
    if(!form.has("revision")||!Number.isSafeInteger(revision)||revision<0)throw new VisitError("Inspection revision required");
    const record=await attachDviVisitMedia({shopId,vin,revision,visitId:String(form.get("visitId")??""),itemId:String(form.get("itemId")??""),
      filename:file.name.slice(0,150),contentType:file.type,kind,buffer:Buffer.from(await file.arrayBuffer()),actor:session.email??""});
    return NextResponse.json({ok:true,record},{headers:visitHeaders});
  }catch(e){return visitFailure(e);}
}
export async function GET(req:NextRequest){
  try{
    const {shopId:currentShopId,principal}=await requireSession(req);
    const p=req.nextUrl.searchParams,vin=normalizeVisitVin(p.get("vin"));
    const shopId=p.has("shopId")?Number(p.get("shopId")):currentShopId;
    const visitId=p.get("visitId")??"",mediaId=p.get("mediaId")??"";
    let fingerprint:string|null=null;
    if(shopId!==currentShopId){
      const scope=await resolveHistoryScope(principal);
      if(!scope.policy.enabled||!scope.locations.some(l=>l.shopId===shopId))throw new VisitError("Media not found",404);
      if(await checkShopFeatureGate(shopId,["maintenance","auto_dvi"],{featureLabel:"Auto DVI"}))throw new VisitError("Media not found",404);
      const record=await readDviVisits(shopId,vin);
      if(!record.visits.some(v=>v.id===visitId&&v.status==="complete"))throw new VisitError("Media not found",404);
      fingerprint=scope.fingerprint;
    }
    const file=await readDviVisitMedia(shopId,vin,visitId,mediaId);
    if(fingerprint){
      if((await resolveHistoryScope(principal)).fingerprint!==fingerprint||
        await checkShopFeatureGate(shopId,["maintenance","auto_dvi"],{featureLabel:"Auto DVI"}))throw new VisitError("Media access changed",403);
    }
    if(![...PHOTOS,...VIDEOS].includes(file.contentType))throw new VisitError("Unsupported media type");
    return new NextResponse(new Uint8Array(file.buffer),{headers:{...visitHeaders,"Content-Type":file.contentType,"X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox"}});
  }catch(e){return visitFailure(e);}
}
