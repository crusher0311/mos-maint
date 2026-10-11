import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
const loader=Module as unknown as {_load:(id:string,...args:unknown[])=>unknown};
const original=loader._load;
let filter:any,options:any,canonical=false,pgArgs:unknown[]=[];
loader._load=function(id,...args){
  if(id==="@/lib/data/db")return {getDb:async()=>({collection:()=>({findOne:async(f:unknown,o:unknown)=>{filter=f;options=o;return {vin:"1HGCM82633A004352"};}})})};
  if(id==="@/lib/db/integration-cache-write-mode")return {isProtractorCachePgCanonical:()=>canonical};
  if(id==="./pg/protractor-cache")return {findCachedWorkOrderByProviderIdentity:async(...values:unknown[])=>{pgArgs=values;return {vin:"1HGCM82633A004352"};}};
  return original.call(this,id,...args);
};
test("workflow identity reads are scoped, case-compatible, projected and bounded without altering other callers",async()=>{
  try{
    const {findCachedWorkOrderByProviderIdentity:read}=await import("../lib/data/repositories/protractor-work-orders");
    const id="abcd1234-abcd-abcd-abcd-abcd12345678";
    await read(538,id,true);
    assert.deepEqual(filter.shopId,{$in:[538,"538"]});
    for(const clause of filter.$or)assert.deepEqual(Object.values(clause)[0],{$in:[id,id.toUpperCase()]});
    assert.equal(options.maxTimeMS,2000);assert.deepEqual(options.projection,{vin:1,"data.ServiceItem.VIN":1});
    await read(538,id);
    assert.equal(filter.$or[0].workOrderId,id);assert.deepEqual(options,{});
    canonical=true;
    const result=await read(538,id,true) as any;
    assert.deepEqual(pgArgs,[538,id,true]);assert.ok(result.__pgTerminalMatch);assert.ok(result.__mongoTerminalMatch);
  }finally{loader._load=original;}
});
