import assert from "node:assert/strict";
import {overnightTransaction} from "../lib/jwt-overnight-transaction";

async function main() {
 for(const phase of ["lookup","update"] as const){
  const events:any[]=[],order:string[]=[];let attempts=0;
  const result=await overnightTransaction({
   beforeAttempt:async()=>{order.push("guard");},
   transaction:async body=>{try{return await body({});}catch(e){order.push("rollback");throw e;}},
   operation:async(_tx,statement)=>statement(phase,async()=>{
    if(++attempts<3)throw Object.assign(new Error("canceling statement due to statement timeout"),{code:"57014"});
    return "corrected";
   }),
   sleep:async()=>{order.push("sleep");},log:e=>events.push(e)
  });
  assert.equal(result,"corrected");assert.equal(attempts,3);
  assert.deepEqual(order,["guard","rollback","sleep","guard","rollback","sleep","guard"]);
  assert.ok(events.every(e=>e.phase===phase&&e.retry));
 }
 for(const mode of ["exhausted","connection","commit","rollback","hold","stop","lock","manual-cancel"]){
  let calls=0,guards=0;const events:any[]=[];
  await assert.rejects(overnightTransaction({
   beforeAttempt:async()=>{if(++guards===2&&mode==="stop")throw Error("stopped");},
   transaction:async body=>{
    try{const result=await body({});if(mode==="commit")throw Object.assign(Error("commit"),{code:"57014"});return result;}
    catch(e){if(mode==="rollback")throw Object.assign(Error("rollback"),{code:"57014"});throw e;}
   },
   operation:async(_tx,statement)=>{
    calls++;
    if(mode==="commit")return "corrected";
    if(mode==="hold")throw Error("validation hold");
    return statement("lookup",async()=>{throw Object.assign(
     Error(mode==="manual-cancel"?"canceling statement due to user request":mode==="lock"?
      "canceling statement due to lock timeout":"canceling statement due to statement timeout"),
     {code:mode==="connection"?"CONNECTION_CLOSED":mode==="lock"?"55P03":"57014"});});
   },
   log:e=>events.push(e),sleep:async()=>{}
  }));
  assert.equal(calls,["exhausted","lock"].includes(mode)?3:1,mode);
  assert.equal(events.at(-1)?.retry,mode==="stop",mode);
  if(mode==="commit")assert.equal(events[0].phase,"commit");
 }
 console.log("JWT overnight transaction retry checks passed");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
