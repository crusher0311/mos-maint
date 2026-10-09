import { NextResponse } from "next/server";
import type { SessionInfo } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import { readDispatchBoard, saveDispatchBoard, readDispatchEnterpriseBrand } from "@/lib/data/repositories/shop-dispatch";
import { listWorkflowWorkOrders } from "@/lib/data/repositories/protractor-work-orders";
import { syncCachedSources } from "./source-sync";
import { actorFor, DispatchError, requireThat, type Board } from "./model";
import { readShopBranding } from "@/lib/data/repositories/shops";
import { readLogoPalette } from "./logo-palette";
import { resolveWorkflowBranding } from "./branding";

export async function dispatchSession(session:SessionInfo|null):Promise<SessionInfo>{
  requireThat(session&&session.email,"Sign in to use shop workflow",401);
  requireThat(!session.isTestAuth&&session.token!=="dev-auto-login"&&!session.mustChangePassword,"A verified dashboard session is required",403);
  const entitlements=await getFeatureEntitlements(session.shopId);
  requireThat(entitlements.isFeatureEnabled("shop_workflow"),"Shop workflow pilot is not enabled for this location. Ask your platform administrator to enable it.",403);
  return session;
}
export async function requestBody(req:Request):Promise<unknown>{
  // Cookie-authenticated mutations only. Same-origin form/API callers must send
  // JSON; no CORS or extension write path is exposed by the pilot.
  const origin=req.headers.get("origin");
  const host=req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  let originHost="";
  try{originHost=origin?new URL(origin).host:"";}catch{/* invalid origin is forbidden */}
  requireThat(originHost && originHost===host && req.headers.get("sec-fetch-site")!=="cross-site","Cross-origin mutations are not allowed",403);
  requireThat((req.headers.get("content-type")??"").split(";")[0].trim()==="application/json","JSON body required",415);
  const reader=req.body?.getReader();requireThat(reader,"Request body required",400);
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;
    if(size>220000){await reader.cancel();throw new DispatchError(413,"Request too large");}chunks.push(next.value);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}
  catch{throw new DispatchError(400,"Invalid JSON");}
}
export async function enterpriseContext(session:SessionInfo){
  const enterprise=await getEnterpriseByShopId(session.shopId);
  if(!enterprise?._id||!enterprise.shopIds.map(Number).includes(session.shopId))return null;
  const id=String(enterprise._id),stored=await readDispatchEnterpriseBrand(id);
  return {id,name:enterprise.name,revision:stored.revision,brand:stored.brand,
    canEdit:session.role==="owner"||session.role==="admin",stored};
}
export async function dispatchSnapshot(session:SessionInfo,board?:Board){
  let value=board ?? await readDispatchBoard(session.shopId);
  const actor=actorFor(value,session.email,session.role),enterprise=await enterpriseContext(session);
  requireThat(actor.manager||actor.technicianId,"Your login has not been mapped to an active technician. Ask a manager to update the roster.",403);
  // Access is established before cache intake. Mutation responses must acknowledge
  // their committed revision without a second, unrelated write.
  let sourceSyncWarning:string|undefined;
  if(!board){
    const result=await syncCachedSources(session.shopId,value,{list:listWorkflowWorkOrders,read:readDispatchBoard,save:saveDispatchBoard});
    value=result.board;sourceSyncWarning=result.sourceSyncWarning;
  }
  const saved = await readShopBranding(session.shopId);
  const name = saved.displayName?.trim().slice(0, 60) || null;
  const logo = await readLogoPalette(saved.logo);
  const branding = resolveWorkflowBranding(value.locationBrand, { name, ...logo }, enterprise?.brand ?? null);
  const {stored,...publicEnterprise}=enterprise ?? {stored:null};
  return {board:{...value,receipts:[],audit:actor.manager?value.audit:[],
    technicians:value.technicians.map(t=>({...t,email:actor.manager||t.id===actor.technicianId?t.email:"",skills:actor.manager?t.skills:undefined}))},
    actor,branding,sourceSyncWarning,shopId:session.shopId,serverNow:new Date().toISOString(),enterprise:enterprise?publicEnterprise:null};
}
export function dispatchJson(value:unknown,status=200){return NextResponse.json(value,{status,headers:{"Cache-Control":"private, no-store"}});}
export function dispatchFailure(error:unknown){
  if(error instanceof DispatchError)return dispatchJson({error:error.message},error.status);
  // Never emit customer/provider payloads or credentials into browser/logs.
  console.error("[ShopDispatch] request failed",error instanceof Error?error.name:"UnknownError");
  return dispatchJson({error:"Workflow request could not be confirmed. Refresh or retry the same request; do not assume the change failed."},503);
}
