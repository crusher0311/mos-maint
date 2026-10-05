import assert from "node:assert/strict";
import {advanceRecovery,initialRecoveryState,recoveryCandidates,recoverySourcePath,type RecoveryDeps} from "../lib/jwt-september-recovery";
async function main() {
  assert.equal(recoveryCandidates.length,235);
  assert.ok(recoveryCandidates.every(n=>n.date>="2026-09-02"&&n.date<"2026-10-01"));
  assert.equal(new Set(recoveryCandidates.map(n=>n.wo)).size,235);
  const n=recoveryCandidates.find(n=>n.classification==="absent_by_both_numbers")!;
  const row={ID:"id",WorkOrderNumber:n.wo,InvoiceNumber:n.invoice};
  let writes=0;const saved=new Map<string,any>();
  const deps:RecoveryDeps={
    readPage:async()=>[row],saveSource:async(wo,raw)=>{saved.set(wo,raw);return true;},
    loadSource:async wo=>saved.get(wo),recover:async text=>{
      writes++;const b=JSON.parse(text);assert.equal(b.shopId,227);assert.equal(b.date,n.date);
      return {outcomes:[{wo:n.wo,state:"applied"}]};
    },
  };
  const initial=initialRecoveryState();
  assert.equal(initial.outcomes.length,1);
  let collected=await advanceRecovery(initial,deps);
  assert.equal(collected.phase,"collect");
  while(collected.phase==="collect") collected=await advanceRecovery(collected,deps);
  assert.equal(collected.phase,"repair");assert.equal(writes,0);
  assert.equal(initial.phase,"collect","never mutate uncommitted checkpoint");
  let state=collected;
  while(state.phase!=="complete") state=await advanceRecovery(state,deps);
  assert.equal(writes,1);assert.equal(state.outcomes.length,235);
  assert.equal(state.outcomes.filter(x=>x.state==="applied").length,1);
  assert.deepEqual(await advanceRecovery(state,deps),state);
  const sourceDay={...initial,day:Number(n.date.slice(8))};
  const duplicate=await advanceRecovery(sourceDay,{...deps,readPage:async()=>[row,row]});
  assert.ok(duplicate.outcomes.some(x=>x.wo===n.wo&&x.state==="held"));
  const changed=await advanceRecovery(sourceDay,{...deps,saveSource:async()=>false});
  assert.ok(changed.outcomes.some(x=>x.wo===n.wo&&x.state==="held"));
  const failed={...collected,cursor:recoveryCandidates.indexOf(n)};
  await assert.rejects(advanceRecovery(failed,{...deps,recover:async()=>{throw new Error("database failure");}}));
  assert.equal(failed.cursor,recoveryCandidates.indexOf(n),"failed step does not advance");
  const invalid=await advanceRecovery(failed,{...deps,recover:async()=>{assert.fail("source mismatch");}});
  assert.equal(invalid.outcomes.at(-1)?.state,"held");
  const conflict=await advanceRecovery(failed,{...deps,recover:async()=>{throw Object.assign(new Error(),{code:"23505"});}});
  assert.equal(conflict.outcomes.at(-1)?.state,"held");
  await assert.rejects(advanceRecovery({...initial,offset:1000},deps));
  await assert.rejects(advanceRecovery(initial,{...deps,readPage:async()=>Array(501).fill(row)}));
  const next=await advanceRecovery(initial,{...deps,readPage:async()=>Array.from({length:25},(_,i)=>({WorkOrderNumber:`other${i}`}))});
  assert.equal(next.offset,25);assert.equal(next.phase,"collect");
  assert.equal(next.day,3);
  assert.equal(recoverySourcePath(2),"/Invoice/?startDate=2026-09-02&endDate=2026-09-03");
  assert.equal(recoverySourcePath(30),"/Invoice/?startDate=2026-09-30&endDate=2026-10-01");
  assert.throws(()=>recoverySourcePath(1));assert.throws(()=>recoverySourcePath(31));
  const empty=await advanceRecovery(initial,{...deps,readPage:async()=>[]});
  assert.equal(empty.day,3,"empty day does not end collection");
  const resumed=await advanceRecovery(empty,{...deps,readPage:async(_,day)=>{assert.equal(day,3);return [];}});
  assert.equal(resumed.day,4);
  await assert.rejects(advanceRecovery({...initial,offset:25},deps),"do not reinterpret legacy paginated checkpoints");
  console.log("JWT September batch checkpoints, bounds and exception isolation: PASS");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
