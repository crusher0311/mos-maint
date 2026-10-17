import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import {INVOICE_RECOVERY as L} from "../lib/protractor-invoice-recovery-policy";
import {historyEndpoint,validateHistoryGrant,matchesHistoryRequest} from "../lib/protractor-shop-history-policy";
import {runWithShopHistory} from "../lib/integrations/protractor/shop-history-context";
import {createMongoExpressionCollection} from "./helpers/mongo-expression-collection";
import {__protractorPhysicalTransportTestHooks as hooks,confirmProtractorPhysicalTransportLease as confirm} from "../lib/data/repositories/api-usage";
const now=new Date("2026-10-17T23:00:00Z"),id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const grant={version:5 as const,shopId:227,from:"2026-10-17",until:"2026-10-18",runId:id,owner:id,
  canaryGeneration:id,bindingDigest:"a".repeat(64),notBefore:new Date(L.start),expiresAt:new Date(L.end),
  maxRequests:1000,consumedRequests:999,stopped:false,runnerLeaseUntil:new Date(+now+60000),activityCheckedAt:now};
const request={runId:id,recoveryOwner:id,shopId:227,day:grant.from,pilot:"invoiceRecovery" as const};
function fixture(patch:object={}){
  return createMongoExpressionCollection({_id:"protractor-physical-transport-v1",ownerToken:"lease",
    leaseExpiresAt:new Date(+now+90000),operatorStop:{active:false},ownerCanaryGeneration:id,
    invoiceRecovery:{...grant,...patch},weekendHistory:{consumedRequests:953,stopped:false},
    canary:{generation:id,mode:"live",scope:"callbacks_and_interactive",requiresCallback:false,
      requiresRelay:true,workersSuspendedConfirmed:true,startedAt:new Date(L.start),
      maxAdmissions:null,remainingAdmissions:null,consumedAdmissions:0,audit:[],auditTruncatedAdmissions:0}},
    {now:()=>now});
}
async function main(){
  validateHistoryGrant(grant);
  assert.ok(matchesHistoryRequest(request,historyEndpoint(request,0),"GET",227));
  assert.ok(!matchesHistoryRequest(request,historyEndpoint(request,0),"POST",227));
  for(const patch of [{shopId:538},{day:"0001-01-01"},{day:"2026-10-18"},{day:"2026-02-30"},{recoveryOwner:"bad"}])
    assert.throws(()=>historyEndpoint({...request,...patch},0));
  assert.throws(()=>historyEndpoint(request,100));
  for(const patch of [{maxRequests:1001},{consumedRequests:-1},{consumedRequests:1.5},{shopId:237}])
    assert.throws(()=>validateHistoryGrant({...grant,...patch}));
  const context={requireTimedTrial:true,historyRequest:request,historyBindingDigest:grant.bindingDigest,
    environment:"production" as const,transport:"relay" as const};
  const original=hooks.getDb;
  try{
    const col=fixture();hooks.getDb=async()=>({collection:()=>col} as any);
    assert.equal(await confirm("lease",context),true);
    assert.equal(col.row.weekendHistory.consumedRequests,953,"Do not consume/reset the weekend runner's counter");
    assert.equal(col.row.invoiceRecovery.consumedRequests,1000);
    assert.equal(await confirm("lease",context),false,"1000th admission exhausts independent cap");
    for(const patch of [{consumedRequests:1000},{consumedRequests:1.5},{stopped:true},{owner:"other"},
      {activityCheckedAt:new Date(+now-11000)},{activityCheckedAt:new Date(+now+1)},
      {runnerLeaseUntil:new Date(+now-1)},{from:"2026-10-16"},{shopId:228},
      {expiresAt:new Date(+now-1)},{bindingDigest:"b".repeat(64)}]){
      hooks.getDb=async()=>({collection:()=>fixture(patch)} as any);
      assert.equal(await confirm("lease",context),false,JSON.stringify(patch));
    }
    hooks.getDb=async()=>({collection:()=>fixture()} as any);
    assert.equal(await confirm("lease",{...context,transport:"direct"}),false);
    assert.equal(await confirm("lease",{...context,interactiveShopId:227}),false);
  }finally{hooks.getDb=original}
  const old=Date.now;Date.now=()=>+now;
  try{
    await runWithShopHistory(grant,request,async()=>{});
    await assert.rejects(runWithShopHistory(grant,{...request,day:"2026-10-16"},async()=>{}));
    await assert.rejects(runWithShopHistory(grant,{...request,recoveryOwner:"other"},async()=>{}));
    await assert.rejects(runWithShopHistory(grant,{...request,pilot:"weekend"},async()=>{}));
  }finally{Date.now=old}
  console.log("PASS: independent 1000-request cap, read-only scope, tenant, owner, date, relay, activity and expiry guards");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
