import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyCommand, emptyBoard, actorFor, blockers, elapsed, commandSchema, type Board, type Command } from "../lib/shop-dispatch/model";
import { executeDispatchMutation, type DispatchDependencies } from "../lib/shop-dispatch/service";
import { mapProtractorWorkOrder } from "../lib/shop-dispatch/protractor";

const now="2026-10-08T15:00:00.000Z",manager={email:"manager@example.test",manager:true,technicianId:null};
function step(board:Board,command:Command,time=now){return applyCommand(board,command,manager,time);}
export function seed(){
  let board=emptyBoard();
  board=step(board,{type:"technician",id:"tech",name:"Pilot Technician",email:"tech@example.test",active:true});
  board=step(board,{type:"technician",id:"other",name:"Other Technician",email:"other@example.test",active:true});
  board=step(board,{type:"visit",id:"visit",ro:"TEST-1",vehicle:"Test vehicle",customer:"Test customer"});
  board=step(board,{type:"job",id:"diagnosis",visitId:"visit",title:"Diagnosis",bookMinutes:60});
  board=step(board,{type:"job",id:"repair",visitId:"visit",title:"Repair",bookMinutes:90});
  board=step(board,{type:"plan",jobId:"diagnosis",technicianId:"tech",plannedStart:now,estimatedMinutes:50,prerequisites:[],resource:null,authorized:true});
  board=step(board,{type:"plan",jobId:"repair",technicianId:"other",plannedStart:now,estimatedMinutes:70,prerequisites:["diagnosis"],resource:"rack",authorized:true});
  return board;
}
function store(initial=seed()){
  let board=initial,calls=0;
  const deps:DispatchDependencies={
    read:async()=>structuredClone(board),
    save:async(_shop,revision,next)=>{if(revision!==board.revision)return false;board=structuredClone(next);return true;},
    intake:async()=>{calls++;throw new Error("No live intake in tests");},now:()=>now,
  };
  return {deps,get:()=>board,calls:()=>calls};
}
test("sessions persist elapsed time, parts wait and dependency handoff",()=>{
  let b=seed();b=step(b,{type:"start",jobId:"diagnosis",pauseCurrent:false});
  b=step(b,{type:"pause",jobId:"diagnosis",reason:"Waiting for parts"},"2026-10-08T15:10:00.000Z");
  assert.equal(b.jobs[0].activeMs,600000);
  assert.equal(elapsed(b.jobs[0],Date.parse("2026-10-08T15:15:00Z")).waitingMs,300000);
  assert.deepEqual(blockers(b,b.jobs[1]),["Diagnosis"]);
  b=step(b,{type:"start",jobId:"diagnosis",pauseCurrent:false},"2026-10-08T15:20:00.000Z");
  b=step(b,{type:"complete",jobId:"diagnosis"},"2026-10-08T15:25:00.000Z");
  assert.equal(b.jobs[0].activeMs,900000);assert.equal(b.jobs[0].waitingMs,600000);
  assert.deepEqual(blockers(b,b.jobs[1]),[]);
});
test("technicians cannot edit others, self-assign, correct time or change branding",()=>{
  const b=seed(),actor=actorFor(b,"tech@example.test","user");
  for(const cmd of [
    {type:"start",jobId:"repair",pauseCurrent:false},
    {type:"brand",brand:null},
    {type:"correct",jobId:"diagnosis",activeMinutes:0,waitingMinutes:0,reason:"test"},
    {type:"visit",id:"new",ro:"2",vehicle:"Car",customer:""},
  ] as Command[])assert.throws(()=>applyCommand(b,cmd,actor,now),/access|assigned/i);
  assert.throws(()=>applyCommand(b,{type:"start",jobId:"diagnosis",pauseCurrent:false},actorFor(b,"unknown@example.test","user"),now),/assigned/);
});
test("atomic CAS accepts one writer and retry receipts prevent double action",async()=>{
  const memory=store(),principal={shopId:10,email:manager.email,role:"manager"};
  const body={requestId:randomUUID(),revision:memory.get().revision,command:{type:"start",jobId:"diagnosis",pauseCurrent:false}};
  const competing={...body,requestId:randomUUID()};
  const results=await Promise.allSettled([executeDispatchMutation(principal,body,memory.deps),executeDispatchMutation(principal,competing,memory.deps)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  const revision=memory.get().revision;
  const accepted=results[0].status==="fulfilled"?body:competing;
  await executeDispatchMutation(principal,accepted,memory.deps);
  assert.equal(memory.get().revision,revision);
  await assert.rejects(executeDispatchMutation(principal,{...accepted,command:{type:"complete",jobId:"diagnosis"}},memory.deps),/different work/);
});
test("switch confirmation, dependency cycles and rack occupancy are enforced",()=>{
  let b=seed();
  assert.throws(()=>step(b,{type:"plan",jobId:"diagnosis",technicianId:"tech",plannedStart:null,estimatedMinutes:30,prerequisites:["repair"],resource:null,authorized:true}),/cycle/);
  b=step(b,{type:"job",id:"parallel",visitId:"visit",title:"Parallel ready",bookMinutes:null});
  b=step(b,{type:"plan",jobId:"parallel",technicianId:"tech",plannedStart:null,estimatedMinutes:20,prerequisites:[],resource:null,authorized:true});
  b=step(b,{type:"start",jobId:"diagnosis",pauseCurrent:false});
  assert.throws(()=>step(b,{type:"start",jobId:"parallel",pauseCurrent:false}),/Confirm/);
  b=step(b,{type:"start",jobId:"parallel",pauseCurrent:true});
  assert.equal(b.jobs[0].status,"paused");assert.equal(b.jobs[2].status,"active");
  assert.throws(()=>step(b,{type:"technician",id:"tech",name:"Pilot Technician",email:"tech@example.test",active:false}),/Reassign/);
  b.jobs[0].status="completed";b.jobs[2].resource="rack";
  assert.throws(()=>step(b,{type:"start",jobId:"repair",pauseCurrent:false}),/rack/);
});
test("loaner uniqueness and unresolved transportation prevent closure",()=>{
  let b=seed();
  const transport={customerPlan:"drop-off" as const,ride:"needed" as const,loaner:"assigned" as const,loanerId:"CAR-1",pickupAt:null,notes:""};
  b=step(b,{type:"transport",visitId:"visit",transport,arrivalAt:now,promiseAt:null});
  b=step(b,{type:"visit",id:"second",ro:"2",vehicle:"Other",customer:""});
  assert.throws(()=>step(b,{type:"transport",visitId:"second",transport:{...transport,loanerId:"car-1"},arrivalAt:null,promiseAt:null}),/another visit/);
  b.jobs.forEach(j=>j.status="completed");
  assert.throws(()=>step(b,{type:"close",visitId:"visit"}),/transportation/);
  b=step(b,{type:"transport",visitId:"visit",transport:{...transport,ride:"completed",loaner:"returned"},arrivalAt:now,promiseAt:null});
  assert.equal(step(b,{type:"close",visitId:"visit"}).visits[0].closed,true);
});
test("provider mapping fails closed and never supplies duration, sessions or authorization",()=>{
  const id=randomUUID(),pkg=randomUUID();
  const mapped=mapProtractorWorkOrder({ID:id,Type:"WorkOrder",ServicePackages:[{ID:pkg,Title:"Brake service"}]},id);
  assert.equal(mapped.jobs[0].bookMinutes,null);
  assert.throws(()=>step(seed(),{type:"sync",workOrderId:id},now),/verified/);
  let b=applyCommand(seed(),{type:"sync",workOrderId:id},manager,now,mapped);
  const job=b.jobs.find(j=>j.sourceId===pkg)!;
  assert.equal(job.authorized,false);assert.equal(job.technicianId,null);assert.equal(job.estimatedMinutes,null);
  b=step(b,{type:"plan",jobId:job.id,technicianId:"tech",plannedStart:now,estimatedMinutes:35,prerequisites:[],resource:null,authorized:true});
  b=step(b,{type:"start",jobId:job.id,pauseCurrent:false});
  const removed={...mapped,jobs:[]};
  b=applyCommand(b,{type:"sync",workOrderId:id},manager,"2026-10-08T15:10:00.000Z",removed);
  const after=b.jobs.find(j=>j.id===job.id)!;
  assert.equal(after.sourceRemoved,true);assert.equal(after.status,"paused");assert.equal(after.activeMs,600000);
  assert.throws(()=>mapProtractorWorkOrder({ID:randomUUID(),ServicePackages:[]},id),/different/);
  assert.throws(()=>mapProtractorWorkOrder({ID:id},id),/omitted/);
  assert.throws(()=>mapProtractorWorkOrder({ID:id,Type:"Invoice",ServicePackages:[]},id),/invoiced/);
  const again=applyCommand(b,{type:"sync",workOrderId:id},manager,now,mapped);
  assert.equal(again.jobs.filter(j=>j.sourceId===pkg).length,1);
  assert.equal(again.jobs.find(j=>j.sourceId===pkg)!.estimatedMinutes,35);
});

test("strict input rejects tenant injection, unbounded notes and external logos",()=>{
  assert.equal(commandSchema.safeParse({type:"brand",brand:{name:"Test",primary:"#ffffff",accent:"#000000",logo:"https://example.test/logo.png"}}).success,false);
  assert.equal(commandSchema.safeParse({type:"start",jobId:"diagnosis",shopId:999,pauseCurrent:false}).success,false);
  assert.equal(commandSchema.safeParse({type:"pause",jobId:"diagnosis",reason:"x".repeat(1000)}).success,false);
});
