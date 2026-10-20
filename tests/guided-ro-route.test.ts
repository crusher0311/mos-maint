import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {ObjectId,type Db} from "mongodb";
import {isolatedStaffDatabase} from "./helpers/staff-inspection-fixture";
import {getProtractorInteractiveTransportContext} from "../lib/integrations/protractor/interactive-context";
const Module=require("module"),original=Module._load;
let db:Db,isolated:Awaited<ReturnType<typeof isolatedStaffDatabase>>,calls=0,late=false;
let resolveWrite:((value:unknown)=>void)|undefined;
let capturedId="";
let finalizeScope:{shopId:number;active:boolean}|undefined;
Module._load=function(id:string,...args:any[]){
  if(id==="next/headers")return {cookies:async()=>({get:()=>({value:"fixture-session"})})};
  if(id==="@/lib/mongo")return {getDb:async()=>db};
  if(id==="@/lib/integrations/protractor")return {createProtractorWorkOrder:async(_shop:number,_body:any,options:any)=>{
    calls++;capturedId=options.workOrderId;
    return late ? new Promise(resolve=>{resolveWrite=resolve;}) : {ok:true,workOrderId:capturedId,workOrderNumber:4321};
  }};
  if(id==="@/lib/integrations/protractor/work-order-service")return {finalizeProtractorWorkOrderCreation:async(shop:number)=>{
    const scope=getProtractorInteractiveTransportContext();
    finalizeScope=scope?{shopId:scope.shopId,active:scope.active}:undefined;
    assert.equal(scope?.shopId,shop);assert.equal(scope?.active,true);
  }};
  if(id==="@/lib/with-upstream-timeout")return {withUpstreamTimeout:async(promise:Promise<any>,_ms:number,_tag:string,fallback:any)=>{
    if(!late)return promise;
    return Promise.race([promise,new Promise(resolve=>setTimeout(()=>resolve(fallback),10))]);
  }};
  return original.call(this,id,...args);
};
const route=require("../app/api/dashboard/protractor/create-work-order/route");
Module._load=original;
before(async()=>{
  isolated=await isolatedStaffDatabase(27837);db=isolated.client.db("guided_route");
  const userId=new ObjectId();await db.collection("users").insertOne({_id:userId,email:"advisor@example.invalid"});
  await db.collection("sessions").insertOne({token:"fixture-session",expiresAt:new Date(Date.now()+60000),userId,shopId:66});
});
after(async()=>isolated.close());
function request(body:any,origin="https://fixture.invalid"){
  return new Request("https://fixture.invalid/api/dashboard/protractor/create-work-order",{method:"POST",
    headers:{origin,host:"fixture.invalid","content-type":"application/json"},body:JSON.stringify(body)});
}
const payload=()=>({contactId:randomUUID(),vehicleId:randomUUID(),clientRequestId:randomUUID(),concerns:["Engine noise"],expectedShopId:66});
test("real route confirms once and retries only read the durable receipt",async()=>{
  const body=payload();const first=await route.POST(request(body));
  assert.equal(first.status,200);assert.equal((await first.json()).workOrderNumber,4321);
  assert.deepEqual(finalizeScope,{shopId:66,active:true});
  const count=calls;
  assert.equal((await route.POST(request({...body,recoveryOnly:true}))).status,200);
  assert.equal((await route.POST(request(body))).status,200);
  assert.equal(calls,count);
  assert.equal((await route.POST(request({...body,concerns:["changed"]}))).status,409);
  assert.equal(calls,count);
});
test("timed out original records late completion; verification never repeats native creation",async()=>{
  late=true;const body=payload(),response=await route.POST(request(body));
  assert.equal(response.status,504);const count=calls;
  assert.equal((await route.POST(request({...body,recoveryOnly:true}))).status,202);
  assert.equal(calls,count);
  resolveWrite!({ok:true,workOrderId:capturedId,workOrderNumber:9876});
  let row:any;
  for(let i=0;i<30;i++){row=await db.collection("guided_ro_operations").findOne({_id:capturedId} as any);
    if(row?.state==="confirmed")break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(row.state,"confirmed");late=false;
  const recovery=await route.POST(request({...body,recoveryOnly:true}));
  assert.equal(recovery.status,200);assert.equal((await recovery.json()).workOrderNumber,9876);
  assert.equal(calls,count);
});
test("cross-origin, changed shop and invalid request identity never reach provider",async()=>{
  const count=calls;
  assert.equal((await route.POST(request(payload(),"https://other.invalid"))).status,403);
  assert.equal((await route.POST(request({...payload(),expectedShopId:67}))).status,409);
  assert.equal((await route.POST(request({...payload(),clientRequestId:""}))).status,400);
  assert.equal(calls,count);
});
