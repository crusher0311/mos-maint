import "./helpers/deny-network-egress";
import {test} from "node:test";
import assert from "node:assert/strict";
import {recoveryProofs,TELLE_RECOVERY_ROOT,validateTelleRecoveryGrant,telleRecoveryAdmission} from "../lib/protractor-telle-recovery-policy";
import {historyEndpoint,matchesHistoryRequest} from "../lib/protractor-shop-history-policy";
import {createMongoExpressionCollection} from "./helpers/mongo-expression-collection";
import {__protractorPhysicalTransportTestHooks as hooks,confirmProtractorPhysicalTransportLease as confirm} from "../lib/data/repositories/api-usage";
test("approved proof uses independent atomic budget and live revocation",async()=>{
 const old=process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED,db=hooks.getDb;
 process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED="true";
 const id="11111111-1111-1111-1111-111111111111",now=new Date();
 const request={shopId:282,runId:id,day:"2026-01-14",pilot:"telleRecovery" as const,
 endpoint:"/Invoice/?startDate=2026-01-14&endDate=2026-01-15&take=100&skip=0",
 proof:["44f9c9aad6e8f44133c8ea4eb617ab7b7c8010e00c488129e444b7a064bc3d7d","e6a6cd88883499c9791094e9cd5e8bd77dbbd38fcb0e558019c9fe96d75de895","6abfe6ed2b294f73b1a2a160844079d688d4369ed655ae5168b8198bfb9e8a2a","4fd8c9c84aa7b7f844aae1cf00105ea0f974cc23fba8a2cfd7b626f230cd0193","9cf1268bdf12defdc168eede9c13f2caa71ab00d189289abcdda176024c33f94","1ff537c593b94e1b25f862680656836ecfbb34adf0bdca7892aa2f018ee70a56","0896ef8fba7d81f81f73037cd6e409fede6e4503692447b49a5af36b56f8bc5a","a6cd65c1cc21c68726a26fa1cc855b6179a22548319b5be4f1fa8c4b3bf819bd","20c1d7fda7411f75d99ee64f569c4b316560f7ec526737b2da124ac91dcae9e2"]};
 const grant={version:6,shopId:282,runId:id,canaryGeneration:id,bindingDigest:"a".repeat(64),
 from:"2026-01-01",until:"2026-11-09",manifestRoot:TELLE_RECOVERY_ROOT,notBefore:now,
 expiresAt:new Date(+now+60000),maxRequests:500,consumedRequests:499,stopped:false};
 const fixture=(patch:object={})=>createMongoExpressionCollection({
 _id:"protractor-physical-transport-v1",ownerToken:"lease",leaseExpiresAt:new Date(+now+90000),
 operatorStop:{active:false},ownerCanaryGeneration:id,telleRecovery:{...grant,...patch},
 invoiceRecovery:{consumedRequests:42},canary:{generation:id,mode:"live",scope:"callbacks_and_interactive",
 requiresCallback:false,requiresRelay:true,workersSuspendedConfirmed:true,startedAt:now,maxAdmissions:null,remainingAdmissions:null,
 consumedAdmissions:0,audit:[],auditTruncatedAdmissions:0}},{now:()=>now});
 const context={requireTimedTrial:true,historyRequest:request,historyBindingDigest:grant.bindingDigest,
 environment:"production" as const,transport:"relay" as const};
 try{
 assert.equal(historyEndpoint(request,0),request.endpoint);
 assert.throws(()=>historyEndpoint({...request,endpoint:request.endpoint+"&extra=true"},0));
 const col=fixture();hooks.getDb=async()=>({collection:()=>col} as any);
 assert.equal(await confirm("lease",context),true);
 assert.equal(col.row.telleRecovery.consumedRequests,500);
 assert.equal(col.row.invoiceRecovery.consumedRequests,42);
 for(const patch of [{stopped:true},{shopId:283},{consumedRequests:500},{manifestRoot:"bad"},
 {bindingDigest:"b".repeat(64)},{canaryGeneration:"different"},{expiresAt:new Date(+now-1)},
 {maxRequests:1.5}]){
 hooks.getDb=async()=>({collection:()=>fixture(patch)} as any);
 assert.equal(await confirm("lease",context),false);
 }
 for(const patch of [{transport:"direct" as const},{environment:"development" as const},{interactiveShopId:282}]){
 hooks.getDb=async()=>({collection:()=>fixture()} as any);
 assert.equal(await confirm("lease",{...context,...patch}),false);
 }
 }finally{hooks.getDb=db;if(old===undefined)delete process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED;else process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED=old;}
});
test("recovery defaults off and arbitrary endpoints never acquire authority",()=>{
 const previous=process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED;
 const r={runId:"11111111-1111-1111-1111-111111111111",shopId:282,day:"2026-01-01",
  pilot:"telleRecovery" as const,endpoint:"/Invoice/unapproved",proof:[]};
 try{
  delete process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED;
  assert.throws(()=>historyEndpoint(r,0));
  process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED="true";
  assert.throws(()=>historyEndpoint(r,0));
  assert.equal(matchesHistoryRequest(r,r.endpoint,"POST",282),false);
  assert.deepEqual(telleRecoveryAdmission(r,"a".repeat(64)),{$literal:false});
  const now=new Date(),g={version:6 as const,shopId:282,from:"2026-01-01",until:"2026-11-09",
   manifestRoot:TELLE_RECOVERY_ROOT,runId:r.runId,canaryGeneration:r.runId,bindingDigest:"a".repeat(64),
   notBefore:now,expiresAt:new Date(+now+60000),maxRequests:500,consumedRequests:0,stopped:false};
  validateTelleRecoveryGrant(g);
  for(const patch of [{shopId:283},{manifestRoot:"b".repeat(64)},{maxRequests:501},
    {consumedRequests:-1},{expiresAt:new Date(+now+1800001)}])assert.throws(()=>validateTelleRecoveryGrant({...g,...patch}));
  assert.equal(recoveryProofs(["b","a","a"]).root,recoveryProofs(["a","b"]).root);
 }finally{if(previous===undefined)delete process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED;else process.env.PROTRACTOR_TELLE_RECOVERY_ENABLED=previous;}
});
