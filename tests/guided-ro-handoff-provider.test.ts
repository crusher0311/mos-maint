import test from "node:test";
import assert from "node:assert/strict";
import { getProtractorInteractiveTransportContext } from "../lib/integrations/protractor/interactive-context";
const Module=require("module"),original=Module._load;
let blocked=false,mismatch=false,cacheFailure=false,fetches=0,snapshots=0,notifications=0;
const id="12345678-1234-4234-8234-123456789abc";
const order={ID:id,WorkOrderNumber:3587,ServicePackages:[],ServiceItem:{Year:2020,Make:"Test",Model:"Car"}};
Module._load=function(name:string,...args:any[]){
  if(name==="@/lib/integrations/protractor/client")return {fetchWorkOrderById:async(shop:number,guid:string,options:any)=>{
    const scope=getProtractorInteractiveTransportContext();
    assert.equal(scope?.shopId,shop);assert.equal(scope?.active,true);
    assert.equal(guid,id);assert.equal(options.maxRetries,0);assert.equal(options.priority,true);
    fetches++;return blocked?{ok:false,error:"provider circuit open"}:{ok:true,workOrder:{...order,ID:mismatch?"wrong":id}};
  }};
  if(name==="@/lib/integrations/protractor")return {upsertProtractorWorkOrderSnapshot:async(shop:number,wo:any)=>{
    assert.equal(getProtractorInteractiveTransportContext()?.shopId,shop);
    assert.equal(wo.ID,id);if(cacheFailure)throw Error("cache unavailable");snapshots++;
  }};
  if(name==="@/lib/data/repositories/shopware-cache")return {touchDashboardUpdate:async()=>{notifications++;}};
  return original.call(this,name,...args);
};
const {fetchGuidedROIntake}=require("../lib/auto-dvi/staff/ro-handoff-provider");
Module._load=original;
test("handoff uses a fresh bounded shop context and refreshes the same RO cache on retry",async()=>{
  const a=await fetchGuidedROIntake(66,id),b=await fetchGuidedROIntake(66,id);
  assert.equal(a.sourceId,id);assert.equal(b.sourceId,id);
  assert.equal(fetches,2);assert.equal(snapshots,2);assert.equal(notifications,2);
  assert.equal(getProtractorInteractiveTransportContext(),undefined);
});
test("blocked, mismatched and failed-cache reads cannot report a successful handoff",async()=>{
  const before=snapshots;
  blocked=true;await assert.rejects(fetchGuidedROIntake(66,id),/RO is confirmed/);blocked=false;
  mismatch=true;await assert.rejects(fetchGuidedROIntake(66,id),/different repair order/);mismatch=false;
  cacheFailure=true;await assert.rejects(fetchGuidedROIntake(66,id),/cache unavailable/);cacheFailure=false;
  assert.equal(snapshots,before);assert.equal(notifications,2);
  assert.equal(getProtractorInteractiveTransportContext(),undefined);
});
