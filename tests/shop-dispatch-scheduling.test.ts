import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {emptyBoard,type Board} from "../lib/shop-dispatch/model";
import {availability,assertHeldCapacityPreserved,assertLocalPlanAvailable,slotIsFree,localParts} from "../lib/shop-dispatch/schedule-engine";
import {createScheduleHold,releaseScheduleHold,executeScheduleCommand} from "../lib/shop-dispatch/schedule-service";
import {mapAppointments,providerInstant,refreshAppointments} from "../lib/shop-dispatch/appointments";
import {scheduleBoardView} from "../lib/shop-dispatch/schedule-view";
const now=Date.parse("2026-10-12T12:00:00Z"); // Monday, 07:00 Chicago
const opening=[{day:1,start:"08:00",end:"17:00"}];
function board():Board{
 const b=emptyBoard();b.revision=1;
 b.technicians=[{id:"tech",name:"Technician",email:"",active:true,sourceId:"upstream"}];
 b.resources=[{id:"bay",name:"Bay",active:true}];
 b.schedule={holds:[],settings:{enabled:true,timeZone:"America/Chicago",weekly:opening,technicians:[{id:"tech",weekly:opening,timeOff:[]}],resources:[],bufferMinutes:0,leadMinutes:0},
 appointments:{startDate:"2026-10-12",endDate:"2026-10-19",fetchedAt:new Date(now).toISOString(),complete:true,appointments:[]}};
 return b;
}
const query={startDate:"2026-10-12",endDate:"2026-10-13",durationMinutes:60};
const slot={start:"2026-10-12T14:00:00.000Z",end:"2026-10-12T15:00:00.000Z",technicianId:"tech",resourceId:"bay"};
function memory(initial=board()){
 let value=structuredClone(initial),clock=now;
 const deps={now:()=>clock,read:async(id:number)=>{assert.equal(id,10);return structuredClone(value);},save:async(id:number,rev:number,next:Board)=>{assert.equal(id,10);if(value.revision!==rev)return false;value=structuredClone(next);return true;}};
 return {deps,get:()=>value,tick:(ms:number)=>{clock+=ms;}};
}
test("availability honors hours, holidays/timeoff, skills, duration and bay restrictions",()=>{
 const b=board();
 let result=availability(b,query,now);assert.ok(result.slots.length);assert.equal(result.slots[0].start,"2026-10-12T13:00:00.000Z");
 assert.equal(availability(b,{...query,skillKey:"brakes"},now).slots.length,0);
 b.technicians[0].skills=[{key:"brakes",title:"Brakes",status:"confirmed",notes:"",reviewedAt:new Date(now).toISOString(),reviewedBy:"manager"}];
 assert.ok(availability(b,{...query,skillKey:"brakes"},now).slots.length);
 b.schedule!.settings!.technicians[0].timeOff=[{start:slot.start,end:slot.end}];assert.equal(slotIsFree(b,slot,now),false);
 b.schedule!.settings!.technicians[0].timeOff=[];
 b.schedule!.settings!.resources=[{id:"bay",weekly:opening,timeOff:[{start:slot.start,end:slot.end}]}];assert.equal(slotIsFree(b,slot,now),false);
 assert.equal(availability(b,{...query,resourceId:"unknown"},now).slots.length,0);
 assert.equal(availability(b,{...query,startDate:"2026-10-13",endDate:"2026-10-14"},now).slots.length,0);
});
test("disabled, incomplete, stale and missing coverage fail closed",()=>{
 for(const edit of [
  (b:Board)=>{b.schedule!.settings!.enabled=false;},
  (b:Board)=>{b.schedule!.appointments!.complete=false;},
  (b:Board)=>{b.schedule!.appointments!.fetchedAt=new Date(now-301000).toISOString();},
  (b:Board)=>{b.schedule!.appointments!.fetchedAt="bad";},
  (b:Board)=>{b.schedule!.appointments!.startDate="2026-10-13";},
 ]){const b=board();edit(b);const result=availability(b,query,now);assert.equal(result.slots.length,0);assert.ok(result.reasons.length);}
 assert.throws(()=>availability(board(),{...query,endDate:"2026-10-25"},now),/seven days/);
});
test("appointments with missing assignments block everyone; missing time closes availability",()=>{
 const b=board();
 b.schedule!.appointments!.appointments=[{id:"appt",ro:"1",title:"Arrival",start:slot.start,end:slot.end,technicianSourceIds:[]}];
 assert.equal(slotIsFree(b,slot,now),false);
 assert.ok(availability(b,query,now).slots.length);
 b.schedule!.appointments!.appointments[0].start=null;
 assert.equal(availability(b,query,now).slots.length,0);
});
test("concurrent schedulers cannot reserve the same technician or bay; retries are idempotent",async()=>{
 const m=memory(),a={...slot,requestId:randomUUID()},b={...slot,requestId:randomUUID()};
 const results=await Promise.allSettled([createScheduleHold(10,"one",a,m.deps),createScheduleHold(10,"two",b,m.deps)]);
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
 const winner=results[0].status==="fulfilled"?"one":"two",input=winner==="one"?a:b;
 const first=await createScheduleHold(10,winner,input,m.deps);
 const again=await createScheduleHold(10,winner,input,m.deps);
 assert.equal(first.id,again.id);assert.equal(m.get().schedule!.holds.length,1);
 await assert.rejects(()=>createScheduleHold(10,winner,{...input,end:"2026-10-12T16:00:00Z"},m.deps),/different hold/);
 await assert.rejects(()=>releaseScheduleHold(10,"other",first.id,m.deps),/not found/);
 await releaseScheduleHold(10,winner,first.id,m.deps);await releaseScheduleHold(10,winner,first.id,m.deps);
 await assert.rejects(()=>createScheduleHold(10,winner,input,m.deps),/expired or was released/);
});
test("same request concurrent retries return one reservation; expiration frees capacity",async()=>{
 const m=memory(),input={...slot,requestId:randomUUID()};
 const values=await Promise.all([createScheduleHold(10,"one",input,m.deps),createScheduleHold(10,"one",input,m.deps)]);
 assert.equal(values[0].id,values[1].id);
 m.tick(300001);
 assert.equal(slotIsFree(m.get(),slot,m.deps.now()),true);
 await assert.rejects(()=>createScheduleHold(10,"one",input,m.deps),/expired/);
});
test("different technicians cannot simultaneously hold the same bay",async()=>{
 const b=board();b.technicians.push({...b.technicians[0],id:"two"});
 b.schedule!.settings!.technicians.push({id:"two",weekly:opening,timeOff:[]});
 const m=memory(b);
 await createScheduleHold(10,"one",{...slot,requestId:randomUUID()},m.deps);
 await assert.rejects(()=>createScheduleHold(10,"two",{...slot,technicianId:"two",requestId:randomUUID()},m.deps),/no longer available/);
});
test("local plan and roster mutations cannot consume held capacity; settings require release",async()=>{
 const m=memory();await createScheduleHold(10,"one",{...slot,requestId:randomUUID()},m.deps);
 const before=m.get(),after=structuredClone(before);
 after.jobs.push({id:"job",visitId:"visit",technicianId:"tech",resource:"bay",status:"idle",plannedStart:slot.start,estimatedMinutes:60,bookMinutes:60} as any);
 assert.throws(()=>assertHeldCapacityPreserved(before,after,now),/temporary scheduler hold/);
 const disabled=structuredClone(before);disabled.technicians[0].active=false;
 assert.throws(()=>assertHeldCapacityPreserved(before,disabled,now),/Release the scheduler hold/);
 await assert.rejects(()=>executeScheduleCommand(10,"manager",{type:"settings",requestId:randomUUID(),revision:before.revision,settings:before.schedule!.settings},m.deps),/Release active holds/);
 const serialized=scheduleBoardView(before);assert.equal(serialized.schedule!.holds[0].owner,"");assert.equal(serialized.schedule!.holds[0].digest,"");
});
test("local scheduling uses the same timeoff and conflict rules",()=>{
 const before=board(),after=structuredClone(before);
 after.jobs=[{id:"job",visitId:"visit",technicianId:"tech",resource:"bay",status:"idle",plannedStart:slot.start,estimatedMinutes:60,bookMinutes:60} as any];
 assert.doesNotThrow(()=>assertLocalPlanAvailable(before,after,"job",now));
 after.schedule!.settings!.technicians[0].timeOff=[{start:slot.start,end:slot.end}];
 assert.throws(()=>assertLocalPlanAvailable(before,after,"job",now),/conflicts/);
});
test("appointment mapping retains arrivals without customer identities, resolves shop time, rejects ambiguous DST",()=>{
 assert.equal(providerInstant("2026-10-12T09:00:00","America/Chicago"),slot.start);
 assert.equal(providerInstant("2026-11-01T01:30:00","America/Chicago"),null);
 assert.equal(providerInstant("2026-03-08T02:30:00","America/Chicago"),null);
 assert.equal(localParts(Date.parse("2026-11-01T07:30:00Z"),"America/Chicago").minute,90);
 const appts=mapAppointments([{ID:"appt",ScheduledTime:"2026-10-12T09:00:00",Duration:60,TechnicianID:"UPSTREAM",Contact:{Name:"Private"}},{ID:"gone",Status:"Cancelled"}],"America/Chicago");
 assert.equal(appts.length,1);assert.equal(appts[0].end,slot.end);assert.deepEqual(appts[0].technicianSourceIds,["upstream"]);assert.ok(!JSON.stringify(appts).includes("Private"));
});
test("failed and truncated provider pages never become an empty green calendar",async()=>{
 const m=memory();m.get().schedule!.appointments!.complete=false;
 let calls=0;
 const result=await refreshAppointments(10,query.startDate,query.endDate,{...m.deps,fetchPage:async()=>{calls++;return {ok:false};}});
 assert.equal(calls,1);assert.equal(result.schedule!.appointments!.complete,false);
 assert.equal(availability(result,query,now).slots.length,0);
 const truncated=await refreshAppointments(10,query.startDate,query.endDate,{...m.deps,fetchPage:async()=>({ok:true,appointments:[],rawCount:100})});
 assert.equal(truncated.schedule!.appointments!.complete,false);
});
test("settings are revision-pinned, strictly tenant-bound, and replay-safe",async()=>{
 const m=memory(),input={type:"settings",requestId:randomUUID(),revision:1,settings:board().schedule!.settings};
 const saved=await executeScheduleCommand(10,"manager",input,m.deps);assert.equal(saved.revision,2);
 assert.equal((await executeScheduleCommand(10,"manager",input,m.deps)).revision,2);
 await assert.rejects(()=>executeScheduleCommand(10,"manager",{...input,requestId:randomUUID()},m.deps),/board changed/);
 await assert.rejects(()=>executeScheduleCommand(10,"manager",{...input,shopId:999},m.deps),/Invalid/);
});
