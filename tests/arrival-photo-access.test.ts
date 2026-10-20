import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
const Module=require("module"),original=Module._load;
const id=randomUUID();let writes=0,reads=0,confirmed=true,readAllowed=true;
let signedIn=true;
let access={shopId:66,actor:"advisor",enabled:true,canEdit:true,authority:{}};
Module._load=function(path:string,...args:any[]){
  if(path==="@/lib/auth")return {getSession:async()=>signedIn?{email:"advisor@example.invalid"}:null};
  if(path==="@/lib/auto-dvi/staff/access")return {staffAccess:async()=>access};
  if(path==="@/lib/auto-dvi/workflow-policy")return {effectiveInspectionPermission:()=>({allowed:readAllowed})};
  if(path==="@/lib/data/repositories/shop-dispatch")return {readDispatchBoard:async()=>({visits:[{id:"visit",provider:"protractor",sourceId:id}]})};
  if(path==="@/lib/data/repositories/ro-arrival-photos")return {ROArrivalPhotos:class{
    async requireConfirmed(){if(!confirmed)throw Error("Missing receipt");}
    async put(shop:number,source:string){assert.equal(shop,66);assert.equal(source,id);writes++;return {id:"photo"};}
    async list(shop:number,source:string){assert.equal(shop,66);assert.equal(source,id);reads++;return [];}
    async read(){throw Error("Not used");}
  }};
  return original.call(this,path,...args);
};
const route=require("../app/api/dashboard/protractor/arrival-photos/route");
Module._load=original;
function request(origin="https://fixture.invalid",extra={}){
  return new Request("https://fixture.invalid/api/dashboard/protractor/arrival-photos",{method:"POST",
    headers:{origin,host:"fixture.invalid","content-type":"application/json"},
    body:JSON.stringify({requestId:randomUUID(),workOrderId:id,mime:"image/png",base64:"iVBORw0KGgo=", ...extra})});
}
test("arrival writes require DVI edit authority, same origin and a confirmed native receipt",async()=>{
  signedIn=false;assert.equal((await route.POST(request())).status,401);
  assert.equal((await route.GET(new Request("https://fixture.invalid/api/dashboard/protractor/arrival-photos?visitId=visit"))).status,401);
  signedIn=true;assert.equal(writes,0);assert.equal(reads,0);
  access.canEdit=false;assert.equal((await route.POST(request())).status,403);assert.equal(writes,0);
  access.canEdit=true;assert.equal((await route.POST(request("https://other.invalid"))).status,403);assert.equal(writes,0);
  confirmed=false;assert.equal((await route.POST(request())).status,503);assert.equal(writes,0);
  confirmed=true;assert.equal((await route.POST(request(undefined,{shopId:67}))).status,400);
  assert.equal((await route.POST(request())).status,200);assert.equal(writes,1);
});
test("arrival reads honor explicit read denials and resolve visit in current shop",async()=>{
  const req=new Request("https://fixture.invalid/api/dashboard/protractor/arrival-photos?visitId=visit");
  readAllowed=false;assert.equal((await route.GET(req)).status,403);assert.equal(reads,0);
  readAllowed=true;access.enabled=false;assert.equal((await route.GET(req)).status,403);assert.equal(reads,0);
  access.enabled=true;assert.equal((await route.GET(req)).status,200);assert.equal(reads,1);
  assert.equal((await route.GET(new Request("https://fixture.invalid/api/dashboard/protractor/arrival-photos?visitId=another"))).status,404);
});
