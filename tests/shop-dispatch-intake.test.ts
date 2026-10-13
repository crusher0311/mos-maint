import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {emptyBoard,applyCommand,type Board,type Intake} from "../lib/shop-dispatch/model";
import {executeIntake,bindTicket,type IntakeDependencies} from "../lib/shop-dispatch/intake-service";
import type {IntakeDetails,TicketIntent} from "../lib/shop-dispatch/intake-types";
import {appointmentHasCompletePlan,assertLocalPlanAvailable,slotIsFree} from "../lib/shop-dispatch/schedule-engine";
import {recommendJobOptions} from "../lib/shop-dispatch/job-offers";
import {reconcileSourceSnapshots} from "../lib/shop-dispatch/source-sync";
const now="2026-10-12T12:00:00.000Z",p={shopId:10,email:"manager@example.test",role:"manager"};
const customer="11111111-1111-4111-8111-111111111111",vehicle="22222222-2222-4222-8222-222222222222",wo="33333333-3333-4333-8333-333333333333";
const details:IntakeDetails={customer:"Synthetic Customer",vehicle:"Test Vehicle",contactId:customer,vehicleId:vehicle,newCustomer:null,newVehicle:null,identityConfirmed:true,concerns:["Inspect noise"],mileage:10000,customerPlan:"drop-off",neededBy:null,promiseAt:null,nextUpdateAt:null,commitmentsConfirmed:false};
function seed(){
  const b=emptyBoard();b.revision=1;
  const weekly=[{day:1,start:"08:00",end:"17:00"}];
  b.technicians=[{id:"tech",name:"Tech",active:true,email:"",sourceId:"employee"}];
  b.schedule={holds:[],settings:{enabled:true,timeZone:"America/Chicago",weekly,technicians:[{id:"tech",weekly,timeOff:[]}],resources:[],bufferMinutes:0,leadMinutes:0},
    appointments:{startDate:"2026-10-12",endDate:"2026-10-13",fetchedAt:now,complete:true,appointments:[{id:"appointment-A",ro:"77",title:"Test Vehicle",start:"2026-10-12T14:00:00.000Z",end:"2026-10-12T15:00:00.000Z",technicianSourceIds:["employee"]}]}};
  return b;
}
function memory(initial=seed()){
  let board=structuredClone(initial),writes:string[]=[],upstream=false,partial=false,throwWrite=false,failFinal=false,identityCalls=0;
  const confirmed=(op:TicketIntent)=>({intake:{sourceId:op.workOrderId,ro:"77",vehicle:details.vehicle,customer:details.customer,sourceStatus:"Open",jobs:op.payload.concerns.map((title,i)=>({sourceId:`package-${i}`,title,bookMinutes:null}))} satisfies Intake,
    packages:op.payload.concerns.map((_,i)=>({jobId:`${op.visitId}:intake:${i}`,sourceId:`package-${i}`}))});
  const entities=new Set<string>();
  const deps:IntakeDependencies={
    read:async shop=>{assert.equal(shop,10);return structuredClone(board);},
    save:async(shop,rev,next)=>{assert.equal(shop,10);if(failFinal&&next.ticketIntents?.some(i=>i.status==="confirmed"))throw new Error("offline local save failure");if(rev!==board.revision)return false;board=structuredClone(next);return true;},now:()=>now,
    verifyIdentity:async(shop)=>{assert.equal(shop,10);identityCalls++;},
    byNumber:async(shop,number)=>{assert.equal(shop,10);assert.equal(number,"77");return {sourceId:wo,ro:"77",vehicle:details.vehicle,customer:details.customer,sourceStatus:"Open",jobs:[]};},
    confirm:async(_shop,op)=>upstream&&!partial?confirmed(op):null,
    confirmEntity:async(_shop,_op,stage)=>entities.has(stage),
    write:async(_shop,op,stage)=>{assert.ok(board.ticketIntents?.find(i=>i.id===op.id)?.attempted.includes(stage),"intent must commit before write");
      writes.push(stage);if(stage==="workOrder")upstream=true;else entities.add(stage);if(throwWrite)throw new Error("accepted but response lost");},
  };
  return {deps,get:()=>board,writes,edit:(fn:(b:Board)=>void)=>fn(board),state:(v:{upstream?:boolean;partial?:boolean;throwWrite?:boolean;failFinal?:boolean})=>{
    if(v.upstream!==undefined)upstream=v.upstream;if(v.partial!==undefined)partial=v.partial;if(v.throwWrite!==undefined)throwWrite=v.throwWrite;if(v.failFinal!==undefined)failFinal=v.failFinal;
  },identityCalls:()=>identityCalls};
}
async function check(m:ReturnType<typeof memory>,appointmentId:string|null=null,d=details){
  return executeIntake(p,{action:"checkIn",requestId:randomUUID(),revision:m.get().revision,appointmentId,details:d},m.deps);
}
async function create(m:ReturnType<typeof memory>){
  return executeIntake(p,{action:"create",requestId:randomUUID(),revision:m.get().revision,visitId:m.get().visits[0].id,confirmed:true},m.deps);
}
test("appointment check-in survives duplicate staff and retries without authorizing or releasing capacity",async()=>{
  const m=memory(),request={action:"checkIn",requestId:randomUUID(),revision:1,appointmentId:"appointment-A",details};
  const result=await Promise.allSettled([executeIntake(p,request,m.deps),executeIntake({...p,email:"second@example.test"}, {...request,requestId:randomUUID()},m.deps)]);
  assert.equal(result.filter(r=>r.status==="fulfilled").length,2);
  await executeIntake(p,request,m.deps);
  await executeIntake(p,{...request,requestId:randomUUID(),revision:m.get().revision},m.deps);
  assert.equal(m.get().visits.length,1);assert.equal(m.get().jobs.length,1);assert.equal(m.get().jobs[0].authorized,false);
  assert.equal(appointmentHasCompletePlan(m.get(),"appointment-A"),false);
  assert.equal(slotIsFree(m.get(),{start:"2026-10-12T14:00:00.000Z",end:"2026-10-12T15:00:00.000Z",technicianId:"tech",resourceId:null},Date.parse(now)),false);
  await assert.rejects(()=>executeIntake(p,{...request,details:{...details,mileage:1}},m.deps),/different intake/);
});
test("stale/foreign appointments, nonmanagers, tenant injection and unconfirmed commitments fail closed",async()=>{
  const m=memory(),request={action:"checkIn",requestId:randomUUID(),revision:1,appointmentId:"appointment-A",details};
  await assert.rejects(()=>executeIntake({...p,role:"user"},request,m.deps),/Manager/);
  await assert.rejects(()=>executeIntake(p,{...request,shopId:99},m.deps),/Invalid/);
  await assert.rejects(()=>executeIntake(p,{...request,appointmentId:"foreign"},m.deps),/snapshot/);
  await assert.rejects(()=>executeIntake(p,{...request,details:{...details,promiseAt:now}},m.deps),/Invalid/);
  m.edit(b=>b.schedule!.appointments!.fetchedAt="2026-10-12T11:00:00.000Z");
  await assert.rejects(()=>executeIntake(p,request,m.deps),/stale/);
  assert.equal(m.identityCalls(),0);assert.equal(m.get().visits.length,0);
});
test("walk-in supports explicit missing identity and prevents duplicate verified vehicle intake",async()=>{
  const m=memory();await check(m,null,{...details,contactId:null,vehicleId:null,identityConfirmed:false});
  await assert.rejects(()=>create(m),/Confirm customer/);
  assert.equal(m.writes.length,0);
  const n=memory();await check(n);await assert.rejects(()=>check(n),/already has an open intake/);
});
test("verified link uses distinct appointment/WO IDs and retains job plans",async()=>{
  const m=memory();await check(m,"appointment-A");
  const id=m.get().visits[0].id;
  m.edit(b=>{b.jobs[0].technicianId="tech";b.jobs[0].plannedStart="2026-10-12T15:00:00.000Z";b.jobs[0].estimatedMinutes=60;});
  await executeIntake(p,{action:"link",requestId:randomUUID(),revision:m.get().revision,visitId:id,roNumber:"77",expectedSourceId:wo,confirmed:true},m.deps);
  assert.equal(m.get().visits[0].sourceId,wo);assert.equal(m.get().visits[0].intake?.appointmentId,"appointment-A");
  assert.equal(m.get().jobs[0].plannedStart,"2026-10-12T15:00:00.000Z");
  assert.equal(appointmentHasCompletePlan(m.get(),"appointment-A"),true);
  m.edit(b=>b.jobs[0].estimatedMinutes=null);assert.equal(appointmentHasCompletePlan(m.get(),"appointment-A"),false);
});
test("incidental appointment/WO ID equality never removes an unmatched arrival",()=>{
  const b=seed();b.visits.push({id:"import",ro:"77",vehicle:"test",customer:"",provider:"protractor",sourceId:"appointment-A",sourceStatus:"Open",sourceFetchedAt:now,arrivalAt:null,promiseAt:null,closed:false,transport:{customerPlan:"unknown",ride:"none",loaner:"none",loanerId:"",pickupAt:null,notes:""}});
  assert.equal(appointmentHasCompletePlan(b,"appointment-A"),false);
});
test("two-job appointment permits the first self-plan but protects its window from unrelated visits",async()=>{
  const m=memory();await check(m,"appointment-A",{...details,concerns:["Inspect noise","Inspect tires"]});
  const before=structuredClone(m.get()),after=structuredClone(before),first=after.jobs[0];
  Object.assign(first,{technicianId:"tech",plannedStart:"2026-10-12T14:00:00.000Z",estimatedMinutes:15});
  assert.doesNotThrow(()=>assertLocalPlanAvailable(before,after,first.id,Date.parse(now)));
  assert.equal(appointmentHasCompletePlan(after,"appointment-A"),false);
  const unrelated=structuredClone(after);
  unrelated.visits.push({...structuredClone(after.visits[0]),id:"unrelated",intake:undefined});
  unrelated.jobs.push({...structuredClone(first),id:"competing",visitId:"unrelated",plannedStart:"2026-10-12T14:30:00.000Z"});
  assert.throws(()=>assertLocalPlanAvailable(after,unrelated,"competing",Date.parse(now)),/conflicts/);
  const second=structuredClone(after);
  Object.assign(second.jobs[1],{technicianId:"tech",plannedStart:"2026-10-12T14:15:00.000Z",estimatedMinutes:15});
  assert.doesNotThrow(()=>assertLocalPlanAvailable(after,second,second.jobs[1].id,Date.parse(now)));
  // Planning local work does not falsely confirm an official ticket.
  assert.equal(appointmentHasCompletePlan(second,"appointment-A"),false);
});
test("binding imported work preserves clocks, readiness, dependencies, and rejects conflicting commitments",async()=>{
  const m=memory();await check(m);
  let board=m.get();
  const intake:Intake={sourceId:wo,ro:"77",vehicle:"Test",customer:"",sourceStatus:"Open",jobs:[{sourceId:"pkg",title:"Repair",bookMinutes:60}]};
  board=applyCommand(board,{type:"sync",workOrderId:wo},{email:p.email,manager:true,technicianId:null},now,intake);
  const imported=board.visits.find(v=>v.sourceId===wo)!;
  const job=board.jobs.find(j=>j.visitId===imported.id)!;job.activeMs=120000;job.status="paused";job.pauseReason="Parts";job.technicianId="tech";
  const merged=bindTicket(structuredClone(board),board.visits[0].id,intake,now);
  assert.equal(merged.visits.length,1);assert.equal(merged.jobs.find(j=>j.id===job.id)?.activeMs,120000);assert.equal(merged.jobs.find(j=>j.id===job.id)?.status,"paused");
  imported.promiseAt=now;
  assert.throws(()=>bindTicket(board,board.visits[0].id,intake,now),/commitments/);
});
test("concurrent create requests admit at most one immutable provider write",async()=>{
  const m=memory();await check(m);
  await Promise.allSettled([create(m),create(m)]);
  await executeIntake({...p,email:"second@example.test"},{action:"reconcile",visitId:m.get().visits[0].id},m.deps);
  assert.deepEqual(m.writes,["workOrder"]);assert.equal(m.get().ticketIntents?.[0].status,"confirmed");
  assert.equal(m.get().visits.length,1);assert.equal(m.get().jobs.length,1);assert.equal(m.get().jobs[0].sourceId,"package-0");assert.equal(m.get().jobs[0].authorized,false);
});
test("accepted timeout recovers across manager sessions, changed payload stays locked",async()=>{
  const m=memory();await check(m);m.state({throwWrite:true});await create(m);
  assert.equal(m.get().ticketIntents?.[0].status,"uncertain");
  const visit=m.get().visits[0];
  await assert.rejects(()=>executeIntake(p,{action:"update",requestId:randomUUID(),revision:m.get().revision,visitId:visit.id,details:{...details,vehicleId:randomUUID()}},m.deps),/locked/);
  await executeIntake({...p,email:"other@example.test"},{action:"reconcile",visitId:visit.id},m.deps);
  assert.equal(m.get().ticketIntents?.[0].status,"confirmed");assert.deepEqual(m.writes,["workOrder"]);
});
test("unaccepted or partial responses remain visible without repeated upstream writes",async()=>{
  const m=memory();await check(m);m.state({partial:true});await create(m);
  const visit=m.get().visits[0];assert.equal(visit.sourceId,null);
  for(let i=0;i<3;i++)await executeIntake(p,{action:"reconcile",visitId:visit.id},m.deps);
  assert.deepEqual(m.writes,["workOrder"]);assert.equal(m.get().ticketIntents?.[0].status,"uncertain");
  m.state({partial:false});
  await executeIntake(p,{action:"reconcile",visitId:visit.id},m.deps);
  assert.equal(m.get().ticketIntents?.[0].status,"confirmed");
});
test("provider success followed by failed local finalization recovers without losing plans",async()=>{
  const m=memory();await check(m);m.edit(b=>{b.jobs[0].technicianId="tech";b.jobs[0].estimatedMinutes=60;});
  m.state({failFinal:true});await create(m);
  assert.equal(m.get().ticketIntents?.[0].status,"uncertain");assert.equal(m.get().visits[0].sourceId,null);
  m.state({failFinal:false});await executeIntake(p,{action:"reconcile",visitId:m.get().visits[0].id},m.deps);
  assert.equal(m.get().jobs[0].technicianId,"tech");assert.equal(m.get().jobs[0].estimatedMinutes,60);assert.deepEqual(m.writes,["workOrder"]);
});
test("partial contact success resumes remaining stages with server-derived stable identities",async()=>{
  const m=memory();await check(m,null,{...details,contactId:null,vehicleId:null,newCustomer:{firstName:"Test",lastName:"Customer",phone1:"",email:""},newVehicle:{vin:"1HGCM82633A004352",year:2003,make:"Honda",model:"Accord"}});
  m.state({throwWrite:true});await create(m);
  const original=structuredClone(m.get().ticketIntents![0]);assert.deepEqual(m.writes,["contact"]);
  m.state({throwWrite:false});await executeIntake({...p,email:"second@example.test"},{action:"reconcile",visitId:original.visitId},m.deps);
  assert.deepEqual(m.writes,["contact","vehicle","workOrder"]);assert.equal(m.get().ticketIntents![0].workOrderId,original.workOrderId);assert.equal(m.get().ticketIntents![0].status,"confirmed");
});
test("pending upstream callback cannot manufacture a second workflow visit",async()=>{
  const m=memory();await check(m);m.state({partial:true});await create(m);
  const id=m.get().ticketIntents![0].workOrderId;
  const result=reconcileSourceSnapshots(m.get(),10,[{shopId:10,workOrderId:id,fetchedAt:now,data:{ID:id}}],now);
  assert.equal(result.board.visits.length,1);
});
test("advisory options require known duration, readiness and confirmed skills; holds protect every lane",async()=>{
  const m=memory();await check(m);m.edit(b=>b.schedule!.appointments!.appointments=[]);
  const b=m.get(),job=b.jobs[0];
  assert.equal(recommendJobOptions(b,job.id,Date.parse(now)).options.length,0);
  job.estimatedMinutes=60;job.operations={reviewedAt:now,reviewedBy:p.email,parts:"not-needed",diagnostics:"not-needed",requiredSkills:["brakes"],blockers:[],checks:[]};
  assert.equal(recommendJobOptions(b,job.id,Date.parse(now)).options.length,0);
  b.technicians[0].skills=[{key:"brakes",title:"Brakes",status:"confirmed",notes:"",reviewedAt:now,reviewedBy:p.email}];
  const result=recommendJobOptions(b,job.id,Date.parse(now));assert.equal(result.options.length,1);assert.match(result.options[0].promiseImpact,/not a whole-visit/);assert.equal(job.technicianId,null);
  b.schedule!.holds=[{id:"hold",owner:"test",requestId:"key",digest:"x",createdAt:now,expiresAt:"2026-10-12T12:05:00Z",start:"2026-10-12T13:00:00Z",end:"2026-10-12T22:00:00Z",technicianId:"tech",resourceId:null,skillKey:null,releasedAt:null}];
  assert.equal(recommendJobOptions(b,job.id,Date.parse(now)).options.length,0);
});
