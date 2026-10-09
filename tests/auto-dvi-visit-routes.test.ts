import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
const loader=Module as unknown as {_load:(id:string,...args:any[])=>any},original=loader._load;
let session:any={shopId:1,email:"test@example.invalid",role:"technician"},denied=false,revoked=false,reads:number[]=[],writes:number[]=[];
let scopeCalls=0;
const record={revision:0,visits:[]};
const release={VISIT_DVI_RELEASE_ENABLED:true};
loader._load=function(id,...args){
  if(id==="./visit-release")return release;
  if(id==="next/server")return {NextResponse:class extends Response{static json(v:any,i?:ResponseInit){return Response.json(v,i);}}};
  if(id==="@/lib/auth")return {getSession:async()=>session};
  if(id==="@/lib/extension-route-guard")return {checkShopFeatureGate:async()=>denied?Response.json({error:"denied"}):null};
  if(id==="@/lib/vehicle-history/service")return {resolveHistoryScope:async()=>({policy:{enabled:true},locations:[{shopId:1,name:"Current"},{shopId:2,name:"Sibling"}],fingerprint:revoked&&++scopeCalls>1?"revoked":"allowed"})};
  if(id==="@/lib/data/repositories/auto-dvi")return {
    readDviVisits:async(shop:number)=>{reads.push(shop);return shop===1?record:{revision:1,visits:[{id:"old",status:"complete"}]};},
    readDviSheets:async()=>({templates:[],templateRevision:0}),
    mutateDviVisits:async(shop:number)=>{writes.push(shop);return record;},
    mutateDviSheets:async(shop:number)=>{writes.push(shop);return {templates:[],templateRevision:1};},
  };
  return original.call(this,id,...args);
};
const route=require("../app/api/auto-dvi/visits/route");
loader._load=original;
const vin="1HGCM82633A004352";
function req(body?:any,origin="https://app.invalid"){
  const url=`https://app.invalid/api/auto-dvi/visits?vin=${vin}`;
  const r=new Request(url,body?{method:"POST",headers:{origin,host:"app.invalid"},body:JSON.stringify({vin,revision:0,...body})}:{});
  return Object.assign(r,{nextUrl:new URL(url)});
}
test("visits require session, entitlement, same-origin mutation and server-derived shop",async()=>{
  release.VISIT_DVI_RELEASE_ENABLED=false;
  assert.equal((await route.GET(req())).status,403);
  assert.equal((await route.POST(req({action:"start"}))).status,403);
  assert.deepEqual(reads,[]);
  assert.deepEqual(writes,[]);
  release.VISIT_DVI_RELEASE_ENABLED=true;
  session=null;assert.equal((await route.GET(req())).status,401);
  session={shopId:1,email:"test@example.invalid",role:"technician"};
  denied=true;assert.equal((await route.GET(req())).status,403);denied=false;
  assert.equal((await route.POST(req({action:"start"},"https://evil.invalid"))).status,403);
  assert.equal((await route.POST(req({action:"start",shopId:999}))).status,200);
  assert.deepEqual(writes,[1]);
  assert.equal((await route.POST(req({action:"templateSave",templateRevision:0}))).status,403);
  session.role="owner";
  assert.equal((await route.POST(req({action:"templateSave",templateRevision:0}))).status,200);
});
test("historical scope is rechecked and responses remain uncached",async()=>{
  reads=[];revoked=false;
  const ok=await route.GET(req()),data=await ok.json();
  assert.match(ok.headers.get("cache-control"),/no-store/);
  assert.deepEqual(reads,[1,2]);
  assert.equal(data.history[0].shopId,2);
  revoked=true;scopeCalls=0;
  const changed=await (await route.GET(req())).json();
  assert.deepEqual(changed.history,[]);
  assert.match(changed.sharingReason,/changed/);
});
