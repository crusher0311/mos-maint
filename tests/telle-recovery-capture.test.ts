import "./helpers/deny-network-egress";
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {collectInvoiceEvidence,type LookupReference,type CaptureIO} from "../scripts/lib/telle-recovery-capture";
const at=Date.parse("2026-11-10T12:00:00Z");
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const reference=(n=1):LookupReference=>({invoiceNumber:String(101000000+n),workOrderNumber:String(100000+n),
  reportDate:"2026-07-01",expectedTotalCents:100,reportType:"Invoice",copies:[{provider_id:id(n)}]});
const raw=(r=reference(),n=1)=>({ID:id(n),InvoiceNumber:r.invoiceNumber,WorkOrderNumber:r.workOrderNumber,
  Type:"WorkOrder",WorkflowStage:"Invoice",InvoiceTime:"2026-07-01T12:00:00Z",
  Header:{LastModifiedTime:"2026-11-09T12:00:00Z"},Summary:{GrandTotal:"1.00"}});
test("known identity capture reserves before get and retains full snapshot only for matches",async()=>{
  const events:string[]=[];
  const result=await collectInvoiceEvidence([reference()],{now:()=>at,
    reserve:async()=>{events.push("reserve");},get:async()=>{events.push("get");return raw();}});
  assert.deepEqual(events,["reserve","get"]);assert.equal(result.complete,true);
  assert.equal(result.captures[0].payload.Type,"WorkOrder");assert.equal(result.sourceWrites,0);
});
test("bounded date lookup discards unrelated rows and preserves native credits",async()=>{
  const r={...reference(),copies:[],reportType:"Credit Invoice" as const,expectedTotalCents:-100};
  const credit={...raw(r),Type:"CreditSlip",Summary:{GrandTotal:"-1.00"},InvoiceID:id(88)};
  const result=await collectInvoiceEvidence([r],{now:()=>at,reserve:async()=>{},
    get:async()=>({ItemCollection:[raw(reference(99),99),credit]})});
  assert.equal(result.captures.length,1);assert.deepEqual(result.captures[0].payload,credit);
});
test("duplicate list pages stop, rather than marking the window complete",async()=>{
  const items=Array.from({length:100},(_,i)=>raw(reference(i+1),i+1));
  let requests=0;
  await assert.rejects(collectInvoiceEvidence([{...reference(),copies:[]}],{now:()=>at,reserve:async()=>{},
    get:async()=>{requests++;return {ItemCollection:items};}}),/duplicate/);
  assert.equal(requests,2);
});
test("full three-page response is unresolved and missing shape fails",async()=>{
  let page=0;
  const r={...reference(),copies:[]};
  const result=await collectInvoiceEvidence([r],{now:()=>at,reserve:async()=>{},
    get:async()=>({ItemCollection:Array.from({length:100},(_,i)=>raw(reference(++page),page))})});
  assert.equal(result.complete,false);assert.equal(result.captures.length,0);
  assert.equal(result.outcomes[0].status,"incomplete_list");
  await assert.rejects(collectInvoiceEvidence([r],{now:()=>at,reserve:async()=>{},get:async()=>({})}),/shape/);
});
test("expired budget, failed reservation and wrong identity never silently retry",async()=>{
  let clock=at,gets=0;
  const io:CaptureIO={now:()=>clock,reserve:async()=>{clock+=1800001;},get:async()=>{gets++;return raw();}};
  await assert.rejects(collectInvoiceEvidence([reference()],io),/deadline/);assert.equal(gets,0);
  await assert.rejects(collectInvoiceEvidence([reference()],{now:()=>at,
    reserve:async()=>{throw Error("revoked");},get:async()=>{gets++;return raw();}}),/revoked/);
  assert.equal(gets,0);
  await assert.rejects(collectInvoiceEvidence([reference()],{now:()=>at,reserve:async()=>{},
    get:async()=>raw(reference(),2)}),/identity/);
});
test("changed financial evidence remains unresolved",async()=>{
  const result=await collectInvoiceEvidence([reference()],{now:()=>at,reserve:async()=>{},
    get:async()=>({...raw(),Summary:{GrandTotal:2}})});
  assert.equal(result.complete,false);assert.equal(result.outcomes[0].status,"amount_mismatch");
});
test("live entrypoints are disabled before loading any connections",()=>{
  for(const script of ["scripts/capture-telle-recovery.ts","scripts/inventory-telle-recovery.ts"]){
    const run=spawnSync(process.execPath,["--import","tsx",script],{encoding:"utf8",
      env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:"test",
        NODE_OPTIONS:"--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs"}});
    assert.equal(run.status,1);
    assert.match(run.stdout+run.stderr,/_disabled/);
  }
});
test("request budget is consumed on failures and stops before request 501",async()=>{
  const rows=Array.from({length:233},(_,i)=>({...reference(i+1),
    copies:[1,2,3].map(n=>({provider_id:id(i*3+n)}))}));
  let gets=0,reserved=0;
  await assert.rejects(collectInvoiceEvidence(rows,{now:()=>at,reserve:async()=>{reserved++;},
    get:async endpoint=>{
      gets++;const n=Number(endpoint.slice(-12)),row=rows[Math.floor((n-1)/3)];
      return raw(row,n);
    }}),/limit/);
  assert.equal(gets,500);assert.equal(reserved,500);
});
