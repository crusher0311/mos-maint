import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import type {Db} from "mongodb";
import {isolatedStaffDatabase} from "./helpers/staff-inspection-fixture";
import {STAFF_SHEET_TEMPLATES} from "../lib/auto-dvi/staff/model";
const Module=require("module"),original=Module._load;
let db:Db,isolated:Awaited<ReturnType<typeof isolatedStaffDatabase>>;
let email="sender@example.invalid",cookie:string|undefined="dashboard",shopId=66,enabled=true;
const users=[{email:"sender@example.invalid",shopId:66,role:"advisor",status:"active"},
  {email:"recipient@example.invalid",shopIds:[66],role:"advisor",status:"active"},
  {email:"stranger@example.invalid",shopId:66,role:"advisor",status:"active"},
  {email:"outsider@example.invalid",shopId:67,role:"advisor",status:"active"}];
let denied:string|undefined;
const actor=(e:string)=>createHash("sha256").update(`staff|66|${e}`).digest("hex");
Module._load=function(id:string,...args:any[]){
  if(id==="next/headers")return {cookies:async()=>({get:()=>cookie?{value:cookie}:undefined})};
  if(id==="@/lib/auth")return {getSession:async()=>cookie?{email,shopId,token:cookie}:null};
  if(id==="@/lib/data/db"||id==="@/lib/mongo")return {getDb:async()=>db};
  if(id==="@/lib/data/repositories/users")return {listUsers:async(q:any)=>users.filter(u=>u.email===q.email)};
  if(id==="@/lib/enterprise")return {getEnterpriseByShopId:async()=>null};
  if(id==="@/lib/featureResolver")return {getFeatureEntitlements:async()=>({isFeatureEnabled:()=>enabled})};
  if(id==="@/lib/data/repositories/workflow-inspections"){
    const actual=original.call(this,id,...args);
    return {...actual,readStaffConfiguration:async()=>({version:1,enabledShopIds:[66],sheets:[STAFF_SHEET_TEMPLATES[0]],
      defaultSheet:`${STAFF_SHEET_TEMPLATES[0].id}@${STAFF_SHEET_TEMPLATES[0].version}`,rules:{},
      individual:denied?{[actor(denied)]:{edit:"deny"}}:{}})};
  }
  return original.call(this,id,...args);
};
const route=require("../app/api/dashboard/protractor/check-in-drafts/transfer/route");
const draftRoute=require("../app/api/dashboard/protractor/check-in-drafts/route");
const {CheckInDrafts}=require("../lib/data/repositories/check-in-drafts");
Module._load=original;
before(async()=>{isolated=await isolatedStaffDatabase(27843);db=isolated.client.db("transfer_route");});
after(async()=>isolated.close());
function request(query="",body?:unknown,origin="https://fixture.invalid"){
  return new Request(`https://fixture.invalid/api/dashboard/protractor/check-in-drafts/transfer${query}`,
    body?{method:"POST",headers:{origin,host:"fixture.invalid","content-type":"application/json"},body:JSON.stringify(body)}:{});
}
test("real transfer routes require cookie authentication, selected current-shop advisor, entitlements and fresh permission",async()=>{
  const repo=new CheckInDrafts(async()=>db),id=randomUUID(),deviceId=randomUUID();
  const scope={shopId:66,actor:actor(email)};
  let row=await repo.write(scope,{action:"create",id,revision:0,deviceId,photos:[],
    session:{shopId:66,actorKey:scope.actor,handoffRequestId:id,draft:{version:1,fields:"{}"}}});
  const body=()=>({action:"offer",id,revision:row.revision,deviceId,email:"recipient@example.invalid"});
  cookie=undefined;assert.equal((await route.GET(request())).status,401);
  assert.equal((await draftRoute.GET(request(`?id=${id}`))).status,401);
  cookie="exts_verified";assert.equal((await route.POST(request("",body()))).status,401);cookie="dashboard";
  assert.equal((await route.POST(request("",body(),"https://foreign.invalid"))).status,403);
  assert.equal((await route.GET(request("?email=outsider@example.invalid"))).status,403);
  assert.equal((await route.POST(request("",{...body(),email:"outsider@example.invalid"}))).status,403);
  enabled=false;assert.equal((await route.POST(request("",body()))).status,403);enabled=true;
  assert.equal((await route.GET(request("?email=recipient@example.invalid"))).status,200);
  assert.equal((await route.POST(request("",body()))).status,200);
  row=await repo.read(scope,id);
  email="stranger@example.invalid";
  assert.deepEqual((await (await route.GET(request())).json()).offers,[]);
  assert.equal((await draftRoute.GET(request(`?id=${id}`))).status,404);
  const accept={action:"accept",id,revision:row.revision,deviceId:randomUUID()};
  assert.equal((await route.POST(request("",accept))).status,409);
  email="recipient@example.invalid";
  assert.equal((await draftRoute.GET(request(`?id=${id}`))).status,404);
  assert.equal((await (await route.GET(request())).json()).offers.length,1);
  denied=email;assert.equal((await route.POST(request("",accept))).status,403);denied=undefined;
  users[0].status="inactive";assert.equal((await route.POST(request("",accept))).status,403);users[0].status="active";
  users[1].shopIds=[];assert.equal((await route.POST(request("",accept))).status,403);users[1].shopIds=[66];
  enabled=false;assert.equal((await route.POST(request("",accept))).status,403);enabled=true;
  shopId=67;assert.equal((await route.POST(request("",accept))).status,403);shopId=66;
  const accepted=await route.POST(request("",accept));
  assert.equal(accepted.status,200);
  const receipt=(await accepted.json()).draft;
  // An exact retry after a lost acknowledgement is read-only. A different
  // device cannot use the old acceptance request to take the draft again.
  const retry=await route.POST(request("",accept));
  assert.equal(retry.status,200);
  assert.equal((await retry.json()).draft.revision,receipt.revision);
  assert.equal((await route.POST(request("",{...accept,deviceId:randomUUID()}))).status,409);
  const persisted=await db.collection("guided_check_in_drafts").findOne({id});
  assert.equal(persisted!.ownershipHistory.length,1);
  assert.equal(persisted!.session.handoffRequestId,id);
  assert.equal((await draftRoute.GET(request(`?id=${id}`))).status,200);
  denied=email;assert.equal((await draftRoute.GET(request(`?id=${id}`))).status,403);denied=undefined;
  email="sender@example.invalid";assert.equal((await draftRoute.GET(request(`?id=${id}`))).status,404);
  assert.equal((await draftRoute.POST(request("",{action:"claim",id,revision:row.revision,deviceId}))).status,404);
});
