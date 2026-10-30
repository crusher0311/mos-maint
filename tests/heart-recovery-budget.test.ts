import test from "node:test";
import assert from "node:assert/strict";
import { existingBudgetDatabase, waitForRecoverySlot } from "../scripts/lib/heart-recovery-budget";
test("recovery waits for shared capacity and never accepts disabled/failing coordination",async()=>{
 let clock=0,calls=0;
 await waitForRecoverySlot(async()=>({acquired:++calls===3}),async ms=>{clock+=ms;},()=>clock);
 assert.equal(calls,3);
 await assert.rejects(waitForRecoverySlot(async()=>({acquired:true,fallback:true})),/fail-open/);
 await assert.rejects(waitForRecoverySlot(async()=>({acquired:true,timedOut:true})),/fail-open/);
 clock=0;
 await assert.rejects(waitForRecoverySlot(async()=>({acquired:false}),async ms=>{clock+=ms;},()=>clock),/two minutes/);
});
test("budget facade validates existing TTL, allows only counters, and never creates an index",async()=>{
 let creates=0,writes=0;
 const col={listIndexes:()=>({toArray:async()=>[{name:"existing",key:{expiresAt:1},expireAfterSeconds:0}]}),
  createIndex:()=>{creates++;},findOneAndUpdate:()=>{writes++;},updateOne:()=>{writes++;}};
 const db=await existingBudgetDatabase({collection:()=>col});
 assert.equal(await db.collection("tekmetric_rate_buckets").createIndex(),"existing");
 db.collection("tekmetric_rate_buckets").updateOne();
 assert.equal(writes,1);assert.equal(creates,0);
 assert.throws(()=>db.collection("tekmetric_work_orders"),/mismatch/);
 await assert.rejects(existingBudgetDatabase({collection:()=>({...col,listIndexes:()=>({toArray:async()=>[]})})}),/not authorized/);
});
