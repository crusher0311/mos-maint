import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { dotPreservingUpdate, preserveDotFields } from "../lib/integrations/tekmetric/dot-preserving-update";
import { tireSaleCandidate, extractTireInvoice, emptyTireResult, validateTireDefinition } from "../lib/tire-dot-report";
import { captureMissingTireDots } from "../lib/integrations/tekmetric/tire-dot-capture";
const ro=(dots?:unknown)=>({id:91,shopId:471,repairOrderNumber:123,postedDate:"2026-08-31T22:12:47Z",repairOrderStatus:{name:"Posted"},
  jobs:[{id:10,authorized:true,parts:[{id:20,quantity:2,width:235,ratio:55,diameter:19,...(dots===undefined?{}:{dotNumbers:dots})}]}]});

test("detail hydration is opt-in, budgeted, identity-bound and never turns explicit empty into another request",async()=>{
 let calls=0;
 const deps={enabled:true,currentShop:async()=>({shopId:37,tekmetric:{shopId:471},integrationProvider:"tekmetric"}),takeBudget:()=>true,
   detail:async()=>{calls++;return ro(["001","001"]);}};
 const scope={mosShopId:37,providerShopId:471};
 const raw=ro();
 assert.equal(await captureMissingTireDots(raw,scope,{...deps,enabled:false}),raw);
 assert.equal(await captureMissingTireDots(raw,scope,{...deps,takeBudget:()=>false}),raw);
 await captureMissingTireDots(ro([]),scope,deps);assert.equal(calls,0);
 await assert.rejects(captureMissingTireDots(raw,scope,{...deps,currentShop:async()=>({shopId:99})}),/identity/);
 assert.equal(calls,0);
 const enriched=await captureMissingTireDots(raw,scope,deps);
 assert.deepEqual(enriched.jobs[0].parts[0].dotNumbers,["001","001"]);
 assert.equal(calls,1);
 await assert.rejects(captureMissingTireDots(raw,scope,{...deps,detail:async()=>({...ro([]),shopId:999})}),/identity/);
 let reads=0;
 await assert.rejects(captureMissingTireDots(raw,scope,{...deps,currentShop:async()=>++reads===1?{shopId:37,tekmetric:{shopId:471}}:{shopId:37,smsProvider:"protractor",tekmetric:{shopId:471}}}),/identity changed/);
});

test("tire metadata and explicit unknown DOT coverage without brand-only false positives",()=>{
 assert.equal(tireSaleCandidate({width:235,ratio:55,diameter:19}),true);
 assert.equal(tireSaleCandidate({brand:"BF Goodrich"}),false);
 assert.equal(tireSaleCandidate({name:"Tire road hazard warranty",width:235,ratio:55,diameter:19}),false);
 assert.equal(tireSaleCandidate({name:"DOT 4 brake fluid",dotNumbers:["bad"]}),false);
 assert.equal(tireSaleCandidate({width:2,ratio:3,diameter:4}),false);
 const result=emptyTireResult(validateTireDefinition({dateRange:{start:"2026-08-01",end:"2026-08-31"},locationIds:[37]}),[{shopId:37,name:"Test"}]);
 extractTireInvoice(result,37,{data:ro()});
 assert.equal(result.counts.invoices,1);
 assert.equal(result.coverage.status,"incomplete");
 assert.ok(result.details[0].exceptions.includes("DOT field absent from captured payload"));
});

test("provider-confirmed posted receivables qualify, but an AR label alone does not",()=>{
 for(const confirmed of [true,false]){
  const result=emptyTireResult(validateTireDefinition({dateRange:{start:"2026-08-01",end:"2026-08-31"},locationIds:[37]}),[{shopId:37,name:"Test"}]);
  const raw={...ro(["001","001"]),repairOrderStatus:{name:"Accounts Receivable",code:"ACCRECV",postedOrAccrecv:confirmed}};
  extractTireInvoice(result,37,{data:raw});assert.equal(result.counts.invoices,confirmed?1:0);
 }
});

test("retained invoice header supplies vehicle context, never current vehicle mileage",()=>{
 const result=emptyTireResult(validateTireDefinition({dateRange:{start:"2026-08-01",end:"2026-08-31"},locationIds:[37]}),[{shopId:37,name:"Test"}]);
 extractTireInvoice(result,37,{data:ro(["001","001"]),vin:"FIXTURE-VIN",vehicleYear:2020,vehicleMake:"Test",vehicleModel:"Car",odometer:99999});
 assert.equal(result.details[0].vin,"FIXTURE-VIN");
 assert.equal(result.details[0].vehicle,"2020 Test Car");
 assert.equal(result.details[0].mileage,null);
});

test("real Mongo atomic preservation agrees with PG merge helper; explicit clears, removal, identities and quantity", {timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),"dot-preserve-"));
 const server=spawn("mongod",["--dbpath",directory,"--bind_ip","127.0.0.1","--port","27931","--quiet"],{env:{PATH:process.env.PATH,HOME:directory,NODE_ENV:"test"},stdio:"ignore"});
 const client=new MongoClient("mongodb://127.0.0.1:27931/dot_preserve",{serverSelectionTimeoutMS:400});
 try{
  for(let i=0;;i++){try{await client.connect();break;}catch(e){if(i>30||server.exitCode!==null)throw e;await new Promise(r=>setTimeout(r,100));}}
  const c=client.db().collection("raw");
  const before=ro(["00123","00123"]);
  const cases:any[]=[ro(),ro([]),ro(["corrected"]),ro(null),{...ro(),id:92},{...ro(),shopId:472},
   {...ro(),jobs:[]},ro(),ro()];
  cases[7].jobs[0].parts[0].quantity=4;
  cases[8].jobs[0].parts[0].partNumber="replacement-product";
  for(const [i,next] of cases.entries()){
   await c.insertOne({_id:i as any,data:before});
   await c.updateOne({_id:i as any},dotPreservingUpdate({$set:{data:next,label:"$literal-text"}}));
   const after=await c.findOne({_id:i as any});
   assert.deepEqual(after!.data,preserveDotFields(before,next));
   assert.equal(after!.label,"$literal-text");
  }
  const duplicate=ro(["a"]);duplicate.jobs.push(structuredClone(duplicate.jobs[0]));
  await c.insertOne({_id:99 as any,data:duplicate});
  await c.updateOne({_id:99 as any},dotPreservingUpdate({$set:{data:ro()}}));
  assert.deepEqual((await c.findOne({_id:99 as any}))!.data,preserveDotFields(duplicate,ro()));
  const ambiguous=ro();ambiguous.jobs[0].parts.push(structuredClone(ambiguous.jobs[0].parts[0]));
  await c.insertOne({_id:98 as any,data:before});
  await c.updateOne({_id:98 as any},dotPreservingUpdate({$set:{data:ambiguous}}));
  assert.deepEqual((await c.findOne({_id:98 as any}))!.data,preserveDotFields(before,ambiguous));
  assert.equal((await c.findOne({_id:98 as any}))!.data.jobs[0].parts[0].dotNumbers,undefined);
  await c.updateOne({workOrderId:"new"},dotPreservingUpdate({$set:{data:before},$setOnInsert:{createdAt:"original"}}),{upsert:true});
  const inserted=await c.findOne({workOrderId:"new"});
  assert.equal(inserted!.createdAt,"original");
  await Promise.all(Array.from({length:8},()=>c.updateOne({workOrderId:"new"},dotPreservingUpdate({$set:{data:ro()},$setOnInsert:{createdAt:"changed"}}))));
  const final=await c.findOne({workOrderId:"new"});
  assert.equal(final!.createdAt,"original");
  assert.deepEqual(final!.data.jobs[0].parts[0].dotNumbers,["00123","00123"]);
  assert.equal(final!.data.jobs[0].parts[0]._mosDotInherited,true);
  const result=emptyTireResult(validateTireDefinition({dateRange:{start:"2026-08-01",end:"2026-08-31"},locationIds:[37]}),[{shopId:37,name:"Test"}]);
  extractTireInvoice(result,37,final);
  // Use a provider-matching wrapper for report identity.
  extractTireInvoice(result,37,{workOrderId:"91",data:final!.data});
  assert.equal(result.counts.dotEntries,2);
  assert.ok(result.coverage.reasons.some(r=>r.includes("retained earlier evidence")));
 }finally{
  await client.close();server.kill("SIGTERM");
  await new Promise<void>(r=>{if(server.exitCode!==null)r();else server.once("exit",()=>r());});
  await rm(directory,{recursive:true,force:true});
 }
});
