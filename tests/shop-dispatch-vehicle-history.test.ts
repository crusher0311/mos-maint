import test from "node:test";
import assert from "node:assert/strict";
import {readWorkflowHistory,workflowHistoryVin,type WorkflowHistoryDependencies} from "../lib/shop-dispatch/vehicle-history";
import type {Board} from "../lib/shop-dispatch/model";
import type {HistoryEvent,VehicleHistoryView} from "../lib/vehicle-history/model";

const vin="1HGCM82633A004352";
function fixture(){
  const calls:string[]=[];
  const board={visits:[{id:"visit",provider:"protractor",sourceId:"order"}]} as Board;
  const event=(shopId:number,id:string):HistoryEvent=>({id,shopId,location:`Store ${shopId}`,provider:"protractor",
    workOrderId:"order",jobId:id,title:"Oil service",date:"2026-10-01",mileage:10000,mileageUnit:"miles",status:"completed",
    origin:"normalized",components:[],componentsComplete:false,readOnly:true});
  const coverage=(shopId:number)=>({shopId,name:`Store ${shopId}`,state:"available" as const,hasMore:false,fetchedAt:"2026-10-11"});
  const local={events:[event(538,"local")],coverage:coverage(538)};
  const shared:VehicleHistoryView={enabled:false,vin,currentShopId:538,checkedAt:"2026-10-11",policyRevision:"scope",
    events:[],locations:[],reason:"Sharing is disabled for this location."};
  const deps:WorkflowHistoryDependencies={
    authorize:async()=>{calls.push("authorize");return {shopId:538,email:"manager@example.test"};},
    board:async shop=>{assert.equal(shop,538);return board;},
    cachedOrder:async(shop,id)=>{assert.equal(shop,538);assert.equal(id,"order");calls.push("cache");return {vin};},
    local:async(shop,value)=>{assert.equal(shop,538);assert.equal(value,vin);calls.push("local");return local;},
    shared:async(shop,email,value)=>{assert.equal(shop,538);assert.equal(email,"manager@example.test");assert.equal(value,vin);calls.push("shared");return shared;},
  };
  return {calls,board,event,coverage,local,shared,deps};
}
test("workflow VIN identity accepts complete VINs, not lookup IDs, and refuses conflicting stores",()=>{
  assert.equal(workflowHistoryVin({vin:"lookup-123"}),null);
  assert.equal(workflowHistoryVin({vin, data:{ServiceItem:{VIN:vin.toLowerCase()}}}),vin);
  assert.equal(workflowHistoryVin({vin,__mongoTerminalMatch:{vin:"1HGCM82633A004353"}}),null);
  assert.equal(workflowHistoryVin({vin:"UNKNOWN",data:{ServiceItem:{VIN:vin}}}),vin);
});
test("one onboarded location works with enterprise sharing disabled; no writes or provider calls",async()=>{
  const f=fixture(),result=await readWorkflowHistory("visit",f.deps);
  assert.equal(result.events.length,1);assert.equal(result.locations.length,1);
  assert.equal(result.sharing.enabled,false);assert.match(result.sharing.reason!,/disabled/);
  assert.equal(result.vin,vin);assert.deepEqual(f.calls,["authorize","cache","local","shared","authorize","cache"]);
});
test("newly authorized siblings merge with local records without duplicates or leaked scopes",async()=>{
  const f=fixture();Object.assign(f.shared,{enabled:true,reason:undefined,locations:[f.coverage(538),f.coverage(539)],
    events:[f.event(538,"local"),f.event(539,"sibling"),f.event(999,"unrelated")]});
  const result=await readWorkflowHistory("visit",f.deps);
  assert.deepEqual(result.events.map(e=>e.id).sort(),["local","sibling"]);
  assert.deepEqual(result.locations.map(l=>l.shopId),[538,539]);
  assert.equal(result.sharing.enabled,true);
});
test("history failures disclose coverage and preserve independently available local evidence",async()=>{
  const f=fixture();f.deps.shared=async()=>{throw Error("timeout");};
  let result=await readWorkflowHistory("visit",f.deps);
  assert.equal(result.events.length,1);assert.match(result.sharing.reason!,/unavailable/);
  f.deps.local=async()=>{throw Error("timeout");};
  result=await readWorkflowHistory("visit",f.deps);
  assert.equal(result.locations[0].state,"unavailable");assert.equal(result.events.length,0);
});
test("missing/manual/ambiguous vehicle identities never query history or guess by display name",async()=>{
  const f=fixture();
  await assert.rejects(readWorkflowHistory("foreign",f.deps),/not found/);
  f.board.visits[0].provider="manual";
  const manual=await readWorkflowHistory("visit",f.deps);assert.equal(manual.vin,null);
  f.board.visits[0].provider="protractor";f.deps.cachedOrder=async()=>({vin:"VIN"});
  const missing=await readWorkflowHistory("visit",f.deps);assert.equal(missing.vin,null);
  assert.ok(!f.calls.includes("local")&&!f.calls.includes("shared"));
});
test("auth revocation and changed vehicle identities discard already-read history",async()=>{
  let f=fixture(),count=0;
  f.deps.authorize=async()=>{if(count++)throw Error("Access revoked");return {shopId:538,email:"manager@example.test"};};
  await assert.rejects(readWorkflowHistory("visit",f.deps),/Access revoked/);
  f=fixture();count=0;
  f.deps.cachedOrder=async()=>({vin:count++?"1HGCM82633A004353":vin});
  await assert.rejects(readWorkflowHistory("visit",f.deps),/vehicle link changed/);
  f=fixture();
  f.deps.shared=async()=>{f.board.visits=[];return f.shared;};
  await assert.rejects(readWorkflowHistory("visit",f.deps),/vehicle link changed/);
});
test("mismatched enterprise responses cannot contribute sibling records",async()=>{
  const f=fixture();Object.assign(f.shared,{enabled:true,vin:"1HGCM82633A004353",locations:[f.coverage(539)],events:[f.event(539,"wrong")]});
  const result=await readWorkflowHistory("visit",f.deps);
  assert.deepEqual(result.events.map(e=>e.id),["local"]);assert.equal(result.sharing.enabled,false);
});
