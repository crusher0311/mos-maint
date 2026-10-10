import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";
import { emptyBoard, type Board } from "../lib/shop-dispatch/model";
import { getProtractorInteractiveTransportContext } from "../lib/integrations/protractor/interactive-context";
const loader=Module as unknown as {_load:(id:string,...args:unknown[])=>unknown};
const original=loader._load;
let session:unknown=null,reads=0,enterprise:unknown=null;
let rosterReads=0;
let skillReads=0;
let enterpriseBrand={_id:"enterprise",revision:0,brand:null as unknown,receipts:[] as any[],audit:[] as any[]};
const boards=new Map<number,Board>();
const fakeRepo={
 readDispatchBoard:async(id:number)=>{reads++;return structuredClone(boards.get(id)??emptyBoard());},
 saveDispatchBoard:async(id:number,rev:number,board:Board)=>{if((boards.get(id)?.revision??0)!==rev)return false;boards.set(id,structuredClone(board));return true;},
 readDispatchEnterpriseBrand:async()=>structuredClone(enterpriseBrand),
 saveDispatchEnterpriseBrand:async(value:typeof enterpriseBrand,revision:number)=>{if(enterpriseBrand.revision!==revision)return false;enterpriseBrand=structuredClone(value);return true;},
};
loader._load=function(id,...args){
 if(id==="@/lib/shop-dispatch/skills")return {loadSkillProfiles:async(shopId:number)=>{assert.equal(shopId,10);skillReads++;return {profiles:[],truncated:false};}};
 if(id==="next/server")return {NextResponse:{json:(value:unknown,init?:ResponseInit)=>Response.json(value,init)}};
 if(id==="@/lib/auth")return {getSession:async()=>session};
 if(id==="@/lib/shop-dispatch/roster")return {
   loadDispatchRoster:async(shopId:number)=>{assert.equal(shopId,10);assert.equal(getProtractorInteractiveTransportContext()?.shopId,shopId);rosterReads++;return {employees:[],truncated:false};},
   fetchDispatchEmployee:async(shopId:number,id:string)=>{assert.equal(shopId,10);assert.equal(getProtractorInteractiveTransportContext()?.shopId,shopId);rosterReads++;return {id,name:"Provider Tech",active:true};}
 };
 if(id==="@/lib/featureResolver")return {getFeatureEntitlements:async(id:number)=>({isFeatureEnabled:(key:string)=>key==="shop_workflow"&&id===10})};
 if(id==="@/lib/enterprise")return {getEnterpriseByShopId:async()=>enterprise};
 if(id==="@/lib/data/repositories/shop-dispatch")return fakeRepo;
 if(id==="@/lib/data/repositories/protractor-work-orders")return {listWorkflowWorkOrders:async()=>[]};
 if(id==="@/lib/data/repositories/shops")return {readShopBranding:async(id:number)=>{
   assert.equal(id,10);
   return {displayName:"Saved shop",logo:null};
 }};
 if(id==="@/lib/shop-dispatch/protractor"){
  const intake=async(shopId:number,id:string)=>{
   assert.equal(shopId,10);assert.equal(getProtractorInteractiveTransportContext()?.shopId,shopId);
   return {sourceId:id,ro:"123",vehicle:"Test vehicle",customer:"",sourceStatus:"Unassigned",jobs:[]};
  };
  return {fetchDispatchWorkOrder:intake,fetchDispatchWorkOrderByNumber:(shopId:number)=>intake(shopId,"11111111-1111-4111-8111-111111111111")};
 }
 return original.call(this,id,...args);
};
const route=require("../app/api/shop-dispatch/route");
const brandRoute=require("../app/api/shop-dispatch/enterprise-brand/route");
const http=require("../lib/shop-dispatch/http");
const rosterRoute=require("../app/api/shop-dispatch/roster/route");
const skillsRoute=require("../app/api/shop-dispatch/skills/route");
test("RO intake by ID and number has shop-bound interactive scope",async()=>{
 boards.clear();
 session={shopId:10,email:"manager@example.test",role:"manager",token:"real-session"};
 const commands=[{type:"sync",workOrderId:"11111111-1111-4111-8111-111111111111"},{type:"syncNumber",roNumber:"123"}];
 for(let revision=0;revision<commands.length;revision++){
  const response=await route.POST(req({requestId:randomUUID(),revision,command:commands[revision]}));
  assert.equal(response.status,200,JSON.stringify(await response.json()));
  assert.equal(getProtractorInteractiveTransportContext(),undefined);
 }
 boards.clear();session=null;reads=0;
});
test("skill history requires manager authorization and is session-shop scoped",async()=>{
 session=null;assert.equal((await skillsRoute.GET()).status,401);
 session={shopId:10,email:"user@example.test",role:"user",token:"real-session"};
 assert.equal((await skillsRoute.GET()).status,403);assert.equal(skillReads,0);
 session={shopId:10,email:"manager@example.test",role:"manager",token:"real-session"};
 assert.equal((await skillsRoute.GET()).status,200);assert.equal(skillReads,1);
 session=null;reads=0;
});
function req(body:unknown,origin="https://pilot.test"){
 return new Request("https://pilot.test/api/shop-dispatch",{method:"POST",headers:{"content-type":"application/json",origin},body:JSON.stringify(body)});
}
test("provider roster review is shop-scoped and manager-only before provider access",async()=>{
 session=null;
 assert.equal((await rosterRoute.GET()).status,401);
 session={shopId:10,email:"tech@example.test",role:"user",token:"real-session"};
 assert.equal((await rosterRoute.GET()).status,403);
 assert.equal(rosterReads,0);
 session={shopId:10,email:"manager@example.test",role:"manager",token:"real-session"};
 assert.equal((await rosterRoute.GET()).status,200);
 assert.equal(rosterReads,1);
 assert.equal(getProtractorInteractiveTransportContext(),undefined);
 session=null;reads=0;
});
test("roster import revalidation is manager-only and uses shop-bound interactive transport",async()=>{
 const before=rosterReads;
 const body={requestId:randomUUID(),revision:0,command:{type:"importTechnician",id:"provider-tech",sourceId:"provider-employee"}};
 session={shopId:10,email:"viewer@example.test",role:"user",token:"real-session"};
 assert.equal((await route.POST(req(body))).status,403);
 assert.equal(rosterReads,before);
 session={shopId:10,email:"manager@example.test",role:"manager",token:"real-session"};
 assert.equal((await route.POST(req(body))).status,200);
 assert.equal(rosterReads,before+1);
 assert.equal(getProtractorInteractiveTransportContext(),undefined);
 boards.clear();session=null;reads=0;
});
test("HTTP auth, operator gate, CSRF, strict tenant scope and role enforcement",async()=>{
 assert.equal((await route.GET()).status,401);assert.equal(reads,0);
 session={shopId:11,email:"manager@example.test",role:"manager",token:"real-session"};
 assert.equal((await route.GET()).status,403);assert.equal(reads,0);
 assert.equal((await route.POST(req({}))).status,403);assert.equal(reads,0);
 assert.equal((await brandRoute.POST(req({}))).status,403);assert.equal(reads,0);
 session={shopId:10,email:"manager@example.test",role:"manager",token:"dev-auto-login"};
 assert.equal((await route.GET()).status,403);assert.equal(reads,0);
 session={shopId:10,email:"manager@example.test",role:"manager",token:"real-session"};
 const body={requestId:randomUUID(),revision:0,command:{type:"visit",id:"one",ro:"TEST-1",vehicle:"Test",customer:""}};
 assert.equal((await route.POST(req(body,"https://evil.test"))).status,403);
 assert.equal((await route.POST(req({...body,shopId:999}))).status,400);
 let result=await route.POST(req(body));assert.equal(result.status,200);
 const response=await result.json();assert.equal(response.shopId,10);assert.equal(response.board.revision,1);
 assert.equal(boards.has(999),false);
 result=await route.POST(req(body));assert.equal((await result.json()).board.revision,1);
 assert.match(result.headers.get("cache-control"),/no-store/);
 session={shopId:10,email:"unknown@example.test",role:"user",token:"real-session"};
 assert.equal((await route.GET()).status,403);
 assert.equal((await route.POST(req({...body,requestId:randomUUID(),revision:1}))).status,403);
});
test("enterprise branding is membership-derived, owner/admin-only and revision-safe",async()=>{
 enterprise={_id:"enterprise",name:"Test Enterprise",shopIds:[10,20]};
 session={shopId:10,email:"manager@example.test",role:"manager",token:"real-session"};
 const body={requestId:randomUUID(),revision:0,brand:{name:"Test Brand",primary:"#ffffff",accent:"#123456",logo:null}};
 assert.equal((await brandRoute.POST(req(body))).status,403);
 session={shopId:10,email:"owner@example.test",role:"owner",token:"real-session"};
 assert.equal((await brandRoute.POST(req({...body,enterpriseId:"other"}))).status,400);
 assert.equal((await brandRoute.POST(req(body))).status,200);
 assert.equal(enterpriseBrand.revision,1);assert.equal(enterpriseBrand.audit.length,1);
 assert.equal((await brandRoute.POST(req(body))).status,200);assert.equal(enterpriseBrand.revision,1);
 assert.equal((await brandRoute.POST(req({...body,requestId:randomUUID()}))).status,409);
 enterprise={_id:"enterprise",name:"Other",shopIds:[20]};
 assert.equal((await brandRoute.POST(req({...body,revision:1,requestId:randomUUID()}))).status,403);
});
