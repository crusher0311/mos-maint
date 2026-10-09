import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { applyVisitAction,BUILTIN_SHEETS,EMPTY_RESULT,completionErrors,normalizeVisitVin } from "../lib/auto-dvi/visit-model";
const now="2026-10-09T00:00:00Z",vin="1HGCM82633A004352";
test("sheets reuse exact-position work, preserve unrelated checks, and enforce immutable reports",()=>{
  let r=applyVisitAction({revision:0,visits:[]},{action:"start",roNumber:"RO1",mileage:1000},now,"v1");
  assert.throws(()=>applyVisitAction(r,{action:"start",roNumber:"RO2"},now,"v2"),/Finish/);
  r=applyVisitAction(r,{action:"save",visitId:"v1",itemId:"tire.lf",result:{...EMPTY_RESULT,rating:"green",values:{size:"225/45R18",unit:"32nds",inner:7,center:7,outer:6,beforePsi:33}}},now,"");
  r=applyVisitAction(r,{action:"selectSheet",visitId:"v1",sheet:BUILTIN_SHEETS[0]},now,"");
  assert.equal(r.visits[0].results["tire.lf"].values.inner,7);
  assert.equal(r.visits[0].results["tire.rf"],undefined);
  assert.ok(completionErrors(r.visits[0]).length);
  for(const itemId of r.visits[0].sheet.itemIds)r=applyVisitAction(r,{action:"save",visitId:"v1",itemId,result:{...EMPTY_RESULT,rating:"green"}},now,"");
  r=applyVisitAction(r,{action:"complete",visitId:"v1"},now,"");
  assert.throws(()=>applyVisitAction(r,{action:"save",visitId:"v1"},now,""),/immutable/);
  const previous=structuredClone(r.visits[0]);
  r=applyVisitAction(r,{action:"start",roNumber:"RO2",mileage:2000},now,"v2");
  assert.deepEqual(r.visits[0].results,{});
  assert.deepEqual(r.visits[1],previous);
  assert.throws(()=>normalizeVisitVin("bad"),/VIN/);
  assert.equal(normalizeVisitVin(vin.toLowerCase()),vin);
});
test("tire completion requires measurements and explicit green documentation, not after-pressure",()=>{
  let r=applyVisitAction({revision:0,visits:[]},{action:"start",roNumber:"RO"},now,"v");
  assert.ok(completionErrors(r.visits[0]).some(e=>e.includes("Actual tire size")));
  assert.ok(!completionErrors(r.visits[0]).some(e=>e.includes("After pressure")));
  assert.throws(()=>applyVisitAction(r,{action:"save",visitId:"v",itemId:"tire.lf",result:{...EMPTY_RESULT,values:{inner:-1}}},now,""),/Invalid/);
  assert.throws(()=>applyVisitAction(r,{action:"save",visitId:"v",itemId:"tire.lf",result:{...EMPTY_RESULT,values:{unit:"unknown"}}},now,""),/Invalid/);
});

const loader=Module as unknown as {_load:(id:string,...args:any[])=>any},original=loader._load;
const stores=new Map<string,Map<string,any>>();
const db={collection:(name:string)=>{
  if(!stores.has(name))stores.set(name,new Map());
  const store=stores.get(name)!;
  return {
    findOne:async(q:any)=>structuredClone(store.get(q._id)??null),
    insertOne:async(row:any)=>{if(store.has(row._id))throw Object.assign(new Error("Duplicate"),{code:11000});store.set(row._id,structuredClone(row));},
    updateOne:async(q:any,u:any)=>{const row=store.get(q._id);if(!row||row.revision!==q.revision)return{matchedCount:0};store.set(q._id,{...row,...structuredClone(u.$set)});return{matchedCount:1};},
  };
}};
loader._load=function(id,...args){
  if(id==="@/lib/mongo")return {getDb:async()=>db};
  if(id==="@/lib/plan-build/open-ro-mileage")return {};
  return original.call(this,id,...args);
};
const repo=require("../lib/data/repositories/auto-dvi");
loader._load=original;
test("repository CAS protects simultaneous saves, isolates tenants and rejects client-weakened templates",async()=>{
  const first=await repo.mutateDviVisits(1,vin,0,{action:"start",roNumber:"RO1"},"tech");
  const id=first.visits[0].id;
  const attempts=await Promise.allSettled(["tire.lf","tire.rf"].map(itemId=>repo.mutateDviVisits(1,vin,1,{action:"save",visitId:id,itemId,result:{...EMPTY_RESULT,rating:"green"}},"tech")));
  assert.equal(attempts.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((await repo.readDviVisits(2,vin)).visits.length,0);
  const r=await repo.readDviVisits(1,vin);
  const selected=await repo.mutateDviVisits(1,vin,r.revision,{action:"selectSheet",visitId:id,sheet:{...BUILTIN_SHEETS[1],itemIds:[],requiredFields:{}}},"tech");
  assert.deepEqual(selected.visits[0].sheet,BUILTIN_SHEETS[1]);
  assert.equal(stores.has("auto_dvi_inspections"),false,"legacy inspections untouched");
  const custom={id:"custom",name:"Quick tires",itemIds:["tire.lf"],requiredFields:{}};
  await repo.mutateDviSheets(1,0,{action:"templateSave",sheet:custom});
  await assert.rejects(repo.mutateDviSheets(1,0,{action:"templateDelete",sheetId:"custom"}),/refresh/);
  await repo.mutateDviSheets(1,1,{action:"templateDelete",sheetId:"custom"});
  assert.equal((await repo.readDviSheets(1)).templates.some((s:any)=>s.id==="custom"),false);
  await assert.rejects(repo.mutateDviSheets(1,2,{action:"templateDelete",sheetId:"basic"}),/Built-in/);
});
