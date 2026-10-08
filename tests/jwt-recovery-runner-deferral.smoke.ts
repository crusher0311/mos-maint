// Execute the real invoice-loop source with synthetic stores and no network.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {overnightTransaction,JwtRolledBackTimeout} from "../lib/jwt-overnight-transaction";
import {JwtRecoveryHold,recoveryHoldReason} from "../lib/jwt-overnight-holds";
import {deferRecoveryWindow} from "../lib/jwt-recovery-deferrals";
import {scheduleCheckpoint} from "../lib/jwt-overnight-scheduler";
async function main(){
 const source=fs.readFileSync("scripts/run-jwt-overnight.ts","utf8");
 const start=source.indexOf("     for(const source of invoices){");
 const end=source.indexOf("     if(pageTimeout){",start);
 assert.ok(start>=0&&end>start,"real runner invoice-loop boundaries exist");
 const loop=ts.transpileModule(`(async()=>{
  let pageTimeout:JwtRolledBackTimeout|undefined;let pendingInvoices=0;
  ${source.slice(start,end)}
  return {pendingInvoices,deferred:!!pageTimeout};
 })()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const failure of ["timeout","ambiguous"]){
  const recorded=new Set<string>(),updates:any[]=[];
  let attempts=0;
  const context=vm.createContext({
   invoices:[{ID:"bad",WorkOrderNumber:"bad"},{ID:"good",WorkOrderNumber:"good"}],
   native:{orders:["bad","good"].map(wo=>({shopId:233,date:"2026-08-25",wo,invoice:wo}))},
   shopId:233,day:"2026-08-25",page:0,cursor:0,
   windows:["233:2026-08-25"],schedule:{pages:{},completed:new Set()},
   deferredWindows:{},consecutiveTimeouts:0,recorded,owner:"owner",JOB:"synthetic",RATE:"rate",
   END:new Date(Date.now()+3600_000),profiles:new Map(),grant:{runId:"run",canaryGeneration:"generation"},
   decideQuietWindowGate:()=>({eligible:true}),verifyWorkers:async()=>{},
   loadActivityProfileMap:async()=>new Map(),
   rates:{findOne:async()=>({jwtOvernight:{runId:"run"},canary:{mode:"live",generation:"generation"}})},
   jobs:{
    findOne:async()=>({owner:"owner",status:"running",leaseUntil:new Date(Date.now()+3600_000)}),
    updateOne:async(_filter:any,update:any)=>{updates.push(update);return {matchedCount:1};}
   },
   pg:{begin:async(body:any)=>body({unsafe:async(query:string,args:any[])=>{
    if(query.includes("SELECT"))return [{id:args[1][0],labor_total:0}];
    if(args[1]==="bad"){
     attempts++;
     throw Object.assign(Error(failure==="timeout"?"canceling statement due to statement timeout":"connection lost"),
      {code:failure==="timeout"?"57014":"CONNECTION_CLOSED"});
    }
    return [{id:args[1]}];
   }})},
   overnightTransaction:(options:any)=>overnightTransaction({...options,sleep:async()=>{}}),
   JwtRolledBackTimeout,JwtRecoveryHold,recoveryHoldReason,deferRecoveryWindow,scheduleCheckpoint,
   verifyOvernightHeader:()=>100,AssertionError:assert.AssertionError,console:{error(){}}
  });
  if(failure==="ambiguous"){
   await assert.rejects(vm.runInContext(loop,context));
   assert.equal(recorded.size,0,"ambiguous transaction must stop without acknowledging anything");
  }else{
   const result=await vm.runInContext(loop,context);
   assert.equal(attempts,3);
   assert.equal(result.pendingInvoices,1);
   assert.equal(result.deferred,true);
   assert.ok(!recorded.has("233:2026-08-25:bad"));
   assert.ok(recorded.has("233:2026-08-25:good"),"later invoice still processes");
   assert.ok(updates.some(u=>u.$set?.["deferredWindows.233:2026-08-25"]));
   assert.equal(updates.filter(u=>u.$inc?.["outcomes.corrected"]).length,1);
   assert.ok(!updates.some(u=>u.$inc?.["outcomes.held"]),"timeout must never become a permanent hold");
  }
 }
 console.log("PASS real invoice loop: timeout persists pending work, next invoice continues, ambiguous failure stops");
}
main().catch(e=>{console.error(e);process.exitCode=1});
