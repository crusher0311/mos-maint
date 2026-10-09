import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { resolveHistoryScope, type HistoryPrincipal } from "@/lib/vehicle-history/service";
import { readDviVisits } from "@/lib/data/repositories/auto-dvi";
import { VisitError, type HistoryEntry } from "./visit-model";
import { VISIT_DVI_RELEASE_ENABLED } from "./visit-release";

export const visitHeaders={"Cache-Control":"private, no-store"};
export async function visitGate(req:NextRequest,write=false){
  const session=await getSession();
  if(!session)throw new VisitError("Unauthorized",401);
  if(!VISIT_DVI_RELEASE_ENABLED)throw new VisitError("Visit-based DVI is not released",403);
  if(write){
    const origin=req.headers.get("origin");
    let originHost="";try{originHost=origin?new URL(origin).host:"";}catch{}
    const host=req.headers.get("host")??req.nextUrl.host;
    if(!originHost||originHost!==host||req.headers.get("sec-fetch-site")==="cross-site")throw new VisitError("Same-origin request required",403);
  }
  const shopId=Number(session.shopId);
  if(!Number.isSafeInteger(shopId)||shopId<=0)throw new VisitError("Invalid location",403);
  const denied=await checkShopFeatureGate(shopId,["maintenance","auto_dvi"],{
    isPlatformAdmin:session.role==="platform_admin"&&!session.isImpersonation,featureLabel:"Auto DVI",
  });
  if(denied)throw new VisitError("Auto DVI is not available for this location",403);
  return {session,shopId,principal:{currentShopId:shopId,email:session.email??"",channel:"dashboard",verified:true} as HistoryPrincipal};
}
export function visitFailure(error:unknown){
  if(error instanceof VisitError)return NextResponse.json({error:error.message},{status:error.status,headers:visitHeaders});
  console.error("[AutoDviVisit] request failed",error instanceof Error?error.name:"UnknownError");
  return NextResponse.json({error:"Inspection unavailable. Try again."},{status:503,headers:visitHeaders});
}
export async function dviSharedHistory(principal:HistoryPrincipal,vin:string){
  const scope=await resolveHistoryScope(principal);
  const history:HistoryEntry[]=[];
  if(!scope.policy.enabled)return {history,sharingReason:scope.reason};
  for(const location of scope.locations){
    if(location.shopId===principal.currentShopId)continue;
    const denied=await checkShopFeatureGate(location.shopId,["maintenance","auto_dvi"],{featureLabel:"Auto DVI"});
    if(denied)continue;
    const record=await readDviVisits(location.shopId,vin);
    for(const visit of record.visits.filter(v=>v.status==="complete").slice(0,5)){
      history.push({shopId:location.shopId,shopName:location.name,visit});
    }
  }
  const latest=await resolveHistoryScope(principal);
  if(latest.fingerprint!==scope.fingerprint)return {history:[],sharingReason:"Sharing access changed; refresh."};
  // Feature entitlement is independently rechecked after reading the evidence.
  for(const shopId of new Set(history.map(h=>h.shopId))){
    if(await checkShopFeatureGate(shopId,["maintenance","auto_dvi"],{featureLabel:"Auto DVI"}))return {history:[],sharingReason:"Inspection access changed; refresh."};
  }
  return {history};
}
