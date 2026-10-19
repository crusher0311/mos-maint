import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {WEEKEND} from "../lib/protractor-weekend-policy";
import * as scheduling from "../lib/protractor-weekend-scheduling";
import {historyFailureCode} from "../lib/protractor-history-existing-invoice";
const compiled=ts.transpileModule(readFileSync("scripts/protractor-weekend/run.ts","utf8"),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
async function scenario(allFail=false,missingIndex=false,resumeIndex=0){
  let time=Date.parse(WEEKEND.start)+3600000,writes=0,grantClosed=true;
  const attempts:number[]=[],sleeps:number[]=[];
  const shops=[1,2,3,4,5].map(shopId=>({shopId,bindingDigest:"same",pendingDays:["2026-10-16"],callbackEvidence:[]}));
  const job:any={_id:WEEKEND.id,status:"prepared",stopped:false,runId:"run",canaryGeneration:"g",shops,nextShopIndex:resumeIndex};
  const cursors=new Map<string,any>(),pages=new Map<string,any>();
  const update=(doc:any,u:any)=>{
    Object.assign(doc,u.$set);
    for(const [k,v] of Object.entries(u.$inc??{}))doc[k]=(doc[k]??0)+Number(v);
    for(const [k,v] of Object.entries(u.$max??{}))if(!doc[k]||doc[k]<(v as any))doc[k]=v;
    for(const [k,v] of Object.entries(u.$push??{}))(doc[k]??=[]).push(v);
  };
  const jobs={
    findOne:async(q:any)=>q._id===WEEKEND.id?job:cursors.get(q._id),
    updateOne:async(q:any,u:any)=>{
      writes++;
      if(q._id===WEEKEND.id&&q.status&&q.status!==job.status)return {matchedCount:0};
      if(q._id===WEEKEND.id)update(job,u);
      else{
        if(!cursors.has(q._id))cursors.set(q._id,{...u.$setOnInsert});
        update(cursors.get(q._id),u);
      }
      return {matchedCount:1};
    },
    find:()=>({toArray:async()=>[...cursors.values()]}),
  };
  const state={canary:{generation:"g"},weekendHistory:undefined};
  const rates={findOne:async()=>state,updateOne:async(_:any,u:any)=>{
    writes++;
    if(u.$set?.weekendHistory)grantClosed=u.$set.weekendHistory.stopped;
    if(u.$set?.["weekendHistory.stopped"]!==undefined)grantClosed=u.$set["weekendHistory.stopped"];
    return {matchedCount:1};
  }};
  class Clock extends Date {constructor(v?:any){super(v===undefined?time:v)}static now(){return time}}
  const shared={
    runtime:()=>{},workersSuspended:async()=>{},fleet:()=>{},hash:()=> "digest",RATE:"rate",
    log:()=>{},assertOwner:async()=>({job,state:{weekendHistory:{consumedRequests:0}}}),
    recentActivity:async()=>({active:new Set(),delayed:0,checkedAt:new Clock()}),
    sleep:async(ms:number)=>{
      assert.ok(sleeps.length<100,"Runner failed to finish fixture");
      if(ms>=15*60000)assert.equal(grantClosed,true,"Grant must close before cooldown");
      sleeps.push(ms);time+=ms;
    },
    binding:async(shopId:number)=>{
      attempts.push(shopId);
      if(allFail||shopId<=3)throw Object.assign(new Error("fixture database deadline"),{code:"57014"});
      return {digest:"same",config:{}};
    },
    collections:async()=>({jobs,rates,pages:{
      findOne:async(q:any)=>pages.get(q._id),
      insertOne:async(d:any)=>{pages.set(d._id,d);writes++},
    },days:{updateOne:async()=>{writes++;return {matchedCount:1}}}}),
  };
  const fakeRequire=(name:string):any=>{
    if(name==="node:assert/strict")return assert;
    if(name==="node:crypto")return {randomUUID:()=> "owner"};
    if(name==="node:child_process")return {spawn:()=>{throw Error("No child expected for empty pages")}};
    if(name.endsWith("/protractor-weekend-policy"))return {WEEKEND,weekendFrom:()=> "2024-10-17",callbackQuietEvidence:()=>true};
    if(name.endsWith("/protractor-weekend-scheduling"))return scheduling;
    if(name.endsWith("/protractor-history-existing-invoice"))return {historyFailureCode,requireHistoryIdentityIndex:async()=>{if(missingIndex)throw Error("missing index")}};
    if(name.endsWith("/db/drizzle"))return {getClient:()=>({})};
    if(name.endsWith("/protractor-shop-history-policy"))return {historyEndpoint:()=> "/Invoice/"};
    if(name.endsWith("/shop-history-context"))return {runWithShopHistory:async(_:any,__:any,fn:any)=>fn()};
    if(name.endsWith("/client"))return {protractorFetch:async()=>({ok:true,data:[]})};
    if(name.endsWith("/protractor-afton-pilot-report"))return {pilotInvoiceIds:()=>{}};
    if(name==="./shared")return shared;
    throw Error(`Unexpected dependency: ${name}`);
  };
  const exports:any={};
  vm.runInNewContext(compiled,{exports,require:fakeRequire,Date:Clock,process:{on:()=>{},off:()=>{}},
    setInterval:()=>1,clearInterval:()=>{},setTimeout,clearTimeout,console});
  if(missingIndex){await assert.rejects(()=>exports.run(),/missing index/);assert.equal(writes,0);}
  else await exports.run();
  return {attempts,sleeps,job,cursors};
}
async function main(){
  const mixed=await scenario();
  assert.deepEqual(mixed.attempts.slice(0,8),[1,2,3,4,5,1,2,3]);
  assert.equal(mixed.job.status,"needs-attention");
  assert.ok(mixed.job.heldDayAdvanceAt);
  assert.ok(mixed.job.capturedPageAt);
  assert.ok(mixed.job.completedPageAt, "Empty, verified pages are genuine completion");
  for(const [key,cursor] of mixed.cursors){
    assert.equal(cursor.cursor,1);
    if(cursor.shopId<=3){assert.equal(cursor.unresolved,1);assert.deepEqual(Array.from(cursor.heldDays),["2026-10-16"]);}
    else assert.equal(cursor.unresolved,0,key);
  }
  const failed=await scenario(true);
  assert.ok(failed.job.heldDayAdvanceAt);
  assert.equal(failed.job.completedPageAt,undefined,"Held-day advancement must not report completed pages");
  assert.deepEqual(failed.attempts.slice(0,6),[1,2,3,4,5,1],"Failure streak resets after cooldown and rotates");
  assert.ok(failed.sleeps.filter(ms=>ms===15*60000).length>=2);
  const resumed=await scenario(false,false,3);
  assert.deepEqual(resumed.attempts.slice(0,2),[4,5],"Saved next-shop checkpoint survives restart");
  await scenario(false,true);
  console.log("PASS actual runner: fairness, cooldown reset, closed grants, held-day preservation, resume and index startup gate");
}
main().catch(e=>{console.error(e);process.exitCode=1});
