import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import {createMongoExpressionCollection} from "./helpers/mongo-expression-collection";
import {__protractorPhysicalTransportTestHooks as hooks,confirmProtractorPhysicalTransportLease as confirm} from "../lib/data/repositories/api-usage";
import {HISTORY_START,HISTORY_END,historyEndpoint,validateHistoryGrant,matchesHistoryRequest,type ShopHistoryGrant} from "../lib/protractor-shop-history-policy";
import {runWithShopHistory,historyBindingDigest,historyContextError,getShopHistoryContext} from "../lib/integrations/protractor/shop-history-context";
const now=new Date("2026-10-09T01:00:00Z");
const grant:ShopHistoryGrant={version:1,runId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",shopId:538,
  canaryGeneration:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",bindingDigest:historyBindingDigest(538,"test"),
  from:"2025-08-08",until:"2026-10-09",notBefore:new Date(HISTORY_START),expiresAt:new Date(HISTORY_END),
  maxRequests:1,consumedRequests:0,stopped:false};
const request={runId:grant.runId,shopId:538,day:"2025-08-08"};
function fixture(){return createMongoExpressionCollection({
  _id:"protractor-physical-transport-v1",ownerToken:"lease",leaseExpiresAt:new Date(now.getTime()+90000),
  operatorStop:{active:false},ownerCanaryGeneration:grant.canaryGeneration,shopHistory:{...grant},
  jwtOvernight:{stopped:false,consumedRequests:419},
  canary:{generation:grant.canaryGeneration,mode:"live",scope:"callbacks_and_interactive",requiresCallback:false,
    requiresRelay:true,workersSuspendedConfirmed:true,startedAt:new Date("2026-10-05T15:00:00Z"),
    maxAdmissions:null,remainingAdmissions:null,consumedAdmissions:0,audit:[],auditTruncatedAdmissions:0},
},{now:()=>now});}
async function main(){
 validateHistoryGrant(grant);
 for(const day of ["2025-08-07","2026-10-09","2025-02-30"])assert.throws(()=>historyEndpoint({...request,day},0));
 assert.throws(()=>historyEndpoint({...request,shopId:539},0));
 const endpoint=historyEndpoint(request,0);
 assert.ok(matchesHistoryRequest(request,endpoint,"GET",538));
 assert.ok(!matchesHistoryRequest(request,endpoint+"&foo=x","GET",538));
 assert.ok(!matchesHistoryRequest(request,endpoint,"POST",538));
 const old=hooks.getDb,oldNow=Date.now;
 let col=fixture();hooks.getDb=async()=>({collection:()=>col}) as any;
 const context={historyRequest:request,historyBindingDigest:grant.bindingDigest,requireTimedTrial:true,
   transport:"relay" as const,environment:"production" as const};
 try{
  assert.deepEqual(await Promise.all([confirm("lease",context),confirm("lease",context)]),[true,false]);
  assert.equal(col.row.shopHistory.consumedRequests,1);
  assert.equal(col.row.jwtOvernight.consumedRequests,419,"JWT budget untouched");
  col.row.ownerToken="next";
  assert.equal(await confirm("next",context),false);
  assert.equal(await confirm("next",{transport:"relay",environment:"production",callbackReceivedAt:now}),true);
  for(const patch of [{environment:"development"},{transport:"direct"},{interactiveShopId:538},
    {callbackReceivedAt:now},{historyBindingDigest:"x"},{historyRequest:{...request,shopId:539}},
    {historyRequest:{...request,day:"2025-08-07"}}]){
    col=fixture();assert.equal(await confirm("lease",{...context,...patch} as any),false);
    assert.equal(col.row.shopHistory.consumedRequests,0);
  }
  for(const patch of [{stopped:true},{canaryGeneration:"old"},{consumedRequests:1},{maxRequests:1001},
    {notBefore:new Date("2026-10-09T03:00:00Z")}]){col=fixture();Object.assign(col.row.shopHistory,patch);assert.equal(await confirm("lease",context),false);}
  col=fixture();col.row.operatorStop.active=true;assert.equal(await confirm("lease",context),false);
  Date.now=()=>now.getTime();let captured:any;
  await runWithShopHistory(grant,request,async()=>{
    captured=getShopHistoryContext();assert.equal(historyContextError(538,"test"),null);
    assert.ok(historyContextError(539,"test"));assert.ok(historyContextError(538,"different"));
  });
  assert.equal(captured.active,false);
  await assert.rejects(runWithShopHistory({...grant,stopped:true},request,async()=>{}));
  console.log("Shop 538 history: exact scope, atomic budgets, concurrent JWT isolation, callback availability, binding and expiry passed");
 }finally{hooks.getDb=old;Date.now=oldNow;}
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
