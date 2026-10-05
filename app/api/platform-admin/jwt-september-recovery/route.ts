import { NextRequest,NextResponse } from "next/server";
import { deps } from "../jwt-invoice-preview/deps";
import { recoveryDeps } from "./deps";
import { resolveProtractorConfig,protractorFetch } from "@/lib/integrations/protractor/client";

export const dynamic="force-dynamic";
export const maxDuration=300;
const respond=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
async function authorize() {
  await deps.requirePlatformAdmin();
  const enterprise=await deps.enterprise();
  if(enterprise?.name!=="JWT" || !enterprise.shopIds.some(id=>Number(id)===227))
    throw new Error("Membership unavailable");
}
export async function GET() {
  try {await authorize();} catch {return respond({ok:false,error:"Authorized JWT platform administrator required."},403);}
  try {return respond(await recoveryDeps.status());}
  catch {return respond({ok:false,error:"Recovery status unavailable."},503);}
}
export async function POST(req:NextRequest) {
  try {await authorize();} catch {return respond({ok:false,error:"Authorized JWT platform administrator required."},403);}
  let action:"start"|"step"|"pause";
  try {
    const origin=req.headers.get("origin");
    if(!origin || new URL(origin).host!==req.headers.get("host") ||
      !req.headers.get("content-type")?.startsWith("application/json")) throw new Error();
    const body=await req.json();
    if(!body || Object.keys(body).length!==1 || !["start","step","pause"].includes(body.action)) throw new Error();
    action=body.action;
  } catch {return respond({ok:false,error:"Same-origin JSON action required; scope overrides are forbidden."},400);}
  try {
    if(action!=="step") return respond(await recoveryDeps.control(action));
    const result=await recoveryDeps.step(async offset=>{
      if(deps.relayMode()!=="relay") throw new Error("Relay required");
      return deps.interactive(async()=>{
        const policy=await deps.policy();
        if(!policy.allowed || ((policy.callbackOnly||policy.requireTimedTrial)&&!policy.allowInteractive))
          throw new Error("Current production policy blocks recovery reads");
        const config=await resolveProtractorConfig(227);
        if(!config.configured || config.shopId!==227) throw new Error("Shop configuration unavailable");
        const result=await protractorFetch<{ItemCollection:unknown[]}>(
          `/Invoice/?startDate=2026-09-02&endDate=2026-10-01&take=25&skip=${offset}`,
          config,{method:"GET"},0,227,{priority:true,maxRetries:0,timeoutMs:20000});
        if(!result.ok || !Array.isArray(result.data?.ItemCollection)) throw new Error("Source unavailable");
        return result.data.ItemCollection;
      });
    },recoveryDeps.recover);
    return respond(result,"busy" in result && result.busy?409:200);
  } catch {return respond({ok:false,error:"Recovery unavailable. Saved progress is retained."},503);}
}
