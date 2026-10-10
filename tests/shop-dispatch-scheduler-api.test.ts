import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import {randomUUID} from "node:crypto";
import {NextRequest} from "next/server";
import {emptyBoard,type Board} from "../lib/shop-dispatch/model";
const loader=Module as unknown as {_load:(id:string,...args:any[])=>any},original=loader._load;
const now=Date.parse("2026-10-12T12:00:00Z");
let board:Board=emptyBoard(),enabled=true;
const opening=[{day:1,start:"08:00",end:"17:00"}];
board.revision=1;board.technicians=[{id:"tech",name:"Tech",email:"",active:true}];
board.schedule={holds:[],settings:{enabled:true,timeZone:"America/Chicago",weekly:opening,technicians:[{id:"tech",weekly:opening,timeOff:[]}],resources:[],bufferMinutes:0,leadMinutes:0},appointments:{startDate:"2026-10-12",endDate:"2026-10-13",fetchedAt:new Date(now).toISOString(),complete:true,appointments:[]}};
loader._load=function(id,...args){
 if(id==="./api-keys"&&String(args[0]?.filename).endsWith("external-api/middleware.ts"))return {
  validateApiKey:async(key:string)=>({valid:key!=="bad",apiKey:{keyHash:key,shopId:key==="partner"?0:10,isPartner:key==="partner",rateLimit:100,permissions:key==="read"?["workflow:availability"]:["workflow:availability","workflow:holds"]}}),
  checkPermission:async(key:any,p:string)=>key.permissions.includes(p),
  checkRateLimit:async()=>({allowed:true,remaining:99,resetAt:new Date(now+60_000)}),logApiUsage:async()=>{},updateApiKeyUsage:async()=>{},
 };
 if(id==="@/lib/featureResolver")return {getFeatureEntitlements:async(shopId:number)=>({isFeatureEnabled:()=>shopId===10&&enabled})};
 if(id==="@/lib/shop-dispatch/http"||id==="./http")return {
  dispatchJson:(v:any,status=200)=>Response.json(v,{status,headers:{"Cache-Control":"private, no-store"}}),
  dispatchFailure:(e:any)=>Response.json({error:e.message},{status:e.status??503}),
 };
 if(id==="@/lib/shop-dispatch/schedule-runtime"||id==="./schedule-runtime")return {scheduleDependencies:{
  now:()=>now,read:async(shopId:number)=>{assert.equal(shopId,10);return structuredClone(board);},
  save:async(shopId:number,revision:number,value:Board)=>{assert.equal(shopId,10);if(revision!==board.revision)return false;board=structuredClone(value);return true;},
  fetchPage:async()=>({ok:true,rawCount:0,appointments:[]}),
 }};
 return original.call(this,id,...args);
};
const availability=require("../app/api/external/workflow/availability/route");
const holds=require("../app/api/external/workflow/holds/route");
function request(path:string,key?:string,method="GET",body?:any){
 return new NextRequest(`https://offline.test${path}`,{method,headers:{...(key?{"X-API-Key":key}:{}),...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
}
test("scheduler routes enforce API authentication, explicit permission, tenant scope and feature gate",async()=>{
 const path="/api/external/workflow/availability?startDate=2026-10-12&endDate=2026-10-13&durationMinutes=60";
 assert.equal((await availability.GET(request(path))).status,401);
 assert.equal((await availability.GET(request(path,"bad"))).status,401);
 assert.equal((await availability.GET(request(path,"partner"))).status,403);
 assert.equal((await availability.GET(request(path+"&shopId=999","read"))).status,400);
 enabled=false;assert.equal((await availability.GET(request(path,"read"))).status,403);enabled=true;
 const response=await availability.GET(request(path,"read"));assert.equal(response.status,200);assert.match(response.headers.get("Cache-Control")!,/no-store/);
 assert.ok((await response.json()).slots.length);
 const input={requestId:randomUUID(),start:"2026-10-12T14:00:00Z",end:"2026-10-12T15:00:00Z",technicianId:"tech"};
 assert.equal((await holds.POST(request("/api/external/workflow/holds","read","POST",input))).status,403);
 const created=await holds.POST(request("/api/external/workflow/holds","write","POST",input));
 assert.equal(created.status,201);const data=await created.json();assert.equal(data.providerAppointmentCreated,false);
 assert.equal("owner" in data.hold,false);
 assert.equal((await holds.GET(request(`/api/external/workflow/holds?holdId=${data.hold.id}`,"other"))).status,404);
 assert.equal((await holds.DELETE(request("/api/external/workflow/holds","other","DELETE",{holdId:data.hold.id}))).status,404);
 assert.equal((await holds.DELETE(request("/api/external/workflow/holds","write","DELETE",{holdId:data.hold.id}))).status,200);
});
