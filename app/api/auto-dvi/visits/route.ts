import { NextRequest, NextResponse } from "next/server";
import { visitGate as requireSession,visitFailure,visitHeaders,dviSharedHistory } from "@/lib/auto-dvi/visit-access";
import { normalizeVisitVin,VisitError } from "@/lib/auto-dvi/visit-model";
import { readDviVisits,readDviSheets,mutateDviVisits,mutateDviSheets } from "@/lib/data/repositories/auto-dvi";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(req:NextRequest){
  try{
    const {shopId,principal,session}=await requireSession(req);
    const vin=normalizeVisitVin(req.nextUrl.searchParams.get("vin"));
    const record=await readDviVisits(shopId,vin),templates=await readDviSheets(shopId);
    const shared=await dviSharedHistory(principal,vin).catch(()=>({history:[],sharingReason:"Shared history temporarily unavailable."}));
    return NextResponse.json({ok:true,record,...templates,...shared,canManageSheets:["owner","admin","platform_admin"].includes(session.role??"")},{headers:visitHeaders});
  }catch(e){return visitFailure(e);}
}
export async function POST(req:NextRequest){
  try{
    const {session,shopId}=await requireSession(req,true);
    const text=await req.text();if(text.length>40000)throw new VisitError("Request too large",413);
    let body:any;try{body=JSON.parse(text);}catch{throw new VisitError("Invalid JSON");}
    const vin=normalizeVisitVin(body.vin);
    if(["templateSave","templateDelete"].includes(body.action)){
      if(!["owner","admin","platform_admin"].includes(session.role??""))throw new VisitError("Only owners and administrators can edit sheets",403);
      if(!Number.isSafeInteger(body.templateRevision)||body.templateRevision<0)throw new VisitError("Template revision required");
      const templates=await mutateDviSheets(shopId,body.templateRevision,body);
      return NextResponse.json({ok:true,record:await readDviVisits(shopId,vin),...templates},{headers:visitHeaders});
    }
    if(!Number.isSafeInteger(body.revision)||body.revision<0)throw new VisitError("Inspection revision required");
    const record=await mutateDviVisits(shopId,vin,body.revision,body,session.email??"");
    return NextResponse.json({ok:true,record,...await readDviSheets(shopId)},{headers:visitHeaders});
  }catch(e){return visitFailure(e);}
}
