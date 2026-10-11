import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {applyCommand, emptyBoard, type Board, type Command} from "../lib/shop-dispatch/model";
import {buildResourceTimelinePlan, buildTimelinePlan, timelineInstant} from "../lib/shop-dispatch/timeline";
import {executeDispatchMutation} from "../lib/shop-dispatch/service";

const now = Date.parse("2026-10-12T12:00:00Z");
const actor = {email:"manager@example.test",manager:true,technicianId:null};
function fixture():Board {
  let b=emptyBoard();
  for(const command of [
    {type:"technician",id:"t1",name:"First technician",email:"",active:true},
    {type:"technician",id:"t2",name:"Second technician",email:"",active:true},
    {type:"visit",id:"v",ro:"TEST-100",vehicle:"Synthetic vehicle",customer:""},
    {type:"job",id:"j",visitId:"v",title:"Suspension repair",bookMinutes:90},
  ] as Command[]) b=applyCommand(b,command,actor,new Date(now).toISOString());
  const weekly=[{day:1,start:"07:30",end:"17:30"}];
  b.schedule={holds:[],settings:{enabled:true,timeZone:"America/Chicago",weekly,
    technicians:b.technicians.map(t=>({id:t.id,weekly,timeOff:[]})),resources:[],bufferMinutes:0,leadMinutes:0},
    appointments:{startDate:"2026-10-12",endDate:"2026-10-13",complete:true,fetchedAt:new Date(now).toISOString(),appointments:[]}};
  return b;
}
const start="2026-10-12T14:00:00.000Z";
test("timeline wall-clock conversion handles shop zones, invalid dates and DST without browser timezone assumptions",()=>{
  assert.equal(timelineInstant("2026-10-12",450,"America/Chicago"),"2026-10-12T12:30:00.000Z");
  assert.equal(timelineInstant("2026-12-12",450,"America/Chicago"),"2026-12-12T13:30:00.000Z");
  assert.equal(timelineInstant("2026-10-12",450,"Asia/Kathmandu"),"2026-10-12T01:45:00.000Z");
  assert.throws(()=>timelineInstant("2026-03-08",150,"America/Chicago"),/does not exist/);
  assert.throws(()=>timelineInstant("2026-11-01",90,"America/Chicago"),/twice/);
  assert.throws(()=>timelineInstant("2026-02-30",450,"UTC"),/valid date/);
  assert.throws(()=>timelineInstant("2026-10-12",1440,"UTC"),/valid date/);
  assert.throws(()=>timelineInstant("2026-10-12",450,"bad"),/valid shop timezone/);
});
test("placement is a pure preview and resizing never alters book labor or approval",()=>{
  const b=fixture();b.jobs[0].authorized=false;b.jobs[0].resource="rack";
  const before=structuredClone(b);
  const plan=buildTimelinePlan(b,"j","t1",start,120,now);
  assert.equal(plan.estimatedMinutes,120);assert.equal(plan.authorized,false);assert.equal(plan.resource,"rack");
  assert.deepEqual(plan.prerequisites,[]);assert.deepEqual(b,before);
  const saved=applyCommand(b,plan,actor,new Date(now).toISOString());
  assert.equal(saved.jobs[0].bookMinutes,90);assert.equal(saved.jobs[0].estimatedMinutes,120);
});
test("timeline denies immutable jobs, bad durations, missing shifts, closed hours and stale arrival coverage",()=>{
  for(const change of [
    (b:Board)=>{b.jobs[0].status="active";},
    (b:Board)=>{b.jobs[0].status="completed";},
    (b:Board)=>{b.visits[0].closed=true;},
    (b:Board)=>{b.jobs[0].sourceRemoved=true;},
    (b:Board)=>{b.schedule!.settings!.enabled=false;},
    (b:Board)=>{b.schedule!.settings!.technicians=[];},
    (b:Board)=>{b.schedule!.appointments!.fetchedAt=new Date(now-301_000).toISOString();},
  ]){const b=fixture();change(b);assert.throws(()=>buildTimelinePlan(b,"j","t1",start,60,now));}
  assert.throws(()=>buildTimelinePlan(fixture(),"j","t1",start,0,now),/duration/);
  assert.throws(()=>buildTimelinePlan(fixture(),"j","t1","2026-10-12T22:00:00.000Z",60,now),/conflicts/);
});
test("moving and resizing respect other jobs, time off, bay conflicts and live holds",()=>{
  const b=fixture();
  b.jobs.push({...structuredClone(b.jobs[0]),id:"other",technicianId:"t1",plannedStart:"2026-10-12T15:00:00.000Z",estimatedMinutes:60});
  assert.doesNotThrow(()=>buildTimelinePlan(b,"j","t1",start,60,now));
  assert.throws(()=>buildTimelinePlan(b,"j","t1",start,90,now),/conflicts/);
  b.jobs[0].resource="rack";b.jobs[1].resource="rack";
  assert.throws(()=>buildTimelinePlan(b,"j","t2",start,90,now),/conflicts/);
  b.jobs.pop();
  b.schedule!.settings!.technicians[0].timeOff=[{start,end:"2026-10-12T15:00:00Z"}];
  assert.throws(()=>buildTimelinePlan(b,"j","t1",start,60,now),/conflicts/);
  b.schedule!.holds.push({id:randomUUID(),owner:"scheduler",requestId:randomUUID(),digest:"fixture",createdAt:new Date(now).toISOString(),expiresAt:new Date(now+300_000).toISOString(),releasedAt:null,start,end:"2026-10-12T15:00:00Z",technicianId:"t2",resourceId:null,skillKey:null});
  assert.throws(()=>buildTimelinePlan(b,"j","t2",start,60,now),/hold/);
});
test("prerequisites and handoff consent survive drag reassignment",()=>{
  const b=fixture();
  b.jobs.push({...structuredClone(b.jobs[0]),id:"alignment",title:"Alignment",prerequisites:["j"]});
  assert.throws(()=>buildTimelinePlan(b,"alignment","t2",start,60,now),/known duration/);
  b.jobs[0].technicianId="t1";b.jobs[0].plannedStart=start;b.jobs[0].estimatedMinutes=60;
  assert.throws(()=>buildTimelinePlan(b,"alignment","t2",start,60,now),/cannot be planned/);
  assert.deepEqual(buildTimelinePlan(b,"alignment","t2","2026-10-12T15:00:00.000Z",60,now).prerequisites,["j"]);
  b.operationsEnabled=true;
  assert.throws(()=>buildTimelinePlan(b,"j","t2",start,60,now),/handoff/);
});
test("unconfirmed required skills are blocked by preview AND authoritative mutation",async()=>{
  const b=fixture();b.operationsEnabled=true;
  b.jobs[0].operations={parts:"received",diagnostics:"ready",requiredSkills:["alignment"],blockers:[],checks:[],reviewedAt:new Date(now).toISOString(),reviewedBy:"manager"};
  assert.throws(()=>buildTimelinePlan(b,"j","t1",start,60,now),/manager-confirmed skills/);
  let writes=0;
  const deps={read:async()=>structuredClone(b),save:async()=>{writes++;return true;},now:()=>new Date(now).toISOString(),intake:async()=>{throw Error("No provider calls permitted");}};
  await assert.rejects(()=>executeDispatchMutation({shopId:1,email:actor.email,role:"manager"},{requestId:randomUUID(),revision:b.revision,command:{type:"plan",jobId:"j",technicianId:"t1",plannedStart:start,estimatedMinutes:60,resource:null,prerequisites:[],authorized:true}},deps),/manager-confirmed skills/);
  assert.equal(writes,0);
  b.technicians[0].skills=[{key:"ALIGNMENT",title:"Alignment",status:"confirmed",notes:"",reviewedAt:new Date(now).toISOString(),reviewedBy:"manager"}];
  assert.doesNotThrow(()=>buildTimelinePlan(b,"j","t1",start,60,now));
});

function resourceFixture() {
  const b=fixture();
  b.resources=[{id:"rack",name:"Alignment rack",active:true},{id:"bay",name:"Shared bay",active:true}];
  b.jobs[0].technicianId="t1";
  b.jobs[0].authorized=false;
  b.schedule!.settings!.resources=b.resources.map(r=>({id:r.id,weekly:[{day:1,start:"08:00",end:"16:00"}],timeOff:[]}));
  return b;
}
function memoryStore(initial:Board) {
  let board=structuredClone(initial),writes=0;
  const deps={read:async()=>structuredClone(board),save:async(_shop:number,revision:number,next:Board)=>{
    if(board.revision!==revision)return false;
    board=structuredClone(next);writes++;return true;
  },now:()=>new Date(now).toISOString(),intake:async()=>{throw Error("Provider calls prohibited");}};
  return {deps,get board(){return board;},get writes(){return writes;}};
}
const principal={shopId:999,email:actor.email,role:"manager"};
test("resource-only plans preserve technician, authorization, dependencies, labor and provider arrivals",async()=>{
  const b=resourceFixture();
  b.jobs.push({...structuredClone(b.jobs[0]),id:"prerequisite",status:"completed"});
  b.jobs[0].prerequisites=["prerequisite"];
  b.schedule!.appointments!.appointments=[{id:"arrival",title:"Synthetic arrival",ro:"TEST",start:"2026-10-12T20:00:00Z",end:"2026-10-12T20:30:00Z",technicianSourceIds:[]}];
  const before=structuredClone(b),store=memoryStore(b);
  const command=buildResourceTimelinePlan(b,"j","bay",start,75,now);
  const result=await executeDispatchMutation(principal,{requestId:randomUUID(),revision:b.revision,command},store.deps);
  assert.equal(result.jobs[0].resource,"bay");
  assert.equal(result.jobs[0].technicianId,"t1");
  assert.equal(result.jobs[0].authorized,false);
  assert.equal(result.jobs[0].bookMinutes,90);
  assert.deepEqual(result.jobs[0].prerequisites,["prerequisite"]);
  assert.deepEqual(result.schedule!.appointments,before.schedule!.appointments);
  assert.deepEqual(b,before);
  assert.equal(buildResourceTimelinePlan(result,"j",null,start,75,now).resource,null);
});
test("server rejects overlapping equipment across technicians, resource time off and closed hours",async()=>{
  for(const change of [
    (b:Board)=>b.jobs.push({...structuredClone(b.jobs[0]),id:"other",technicianId:"t2",resource:"rack",plannedStart:start,estimatedMinutes:60}),
    (b:Board)=>{b.schedule!.settings!.resources[0].timeOff=[{start,end:"2026-10-12T15:00:00Z"}];},
    (b:Board)=>{b.schedule!.settings!.resources[0].weekly=[{day:1,start:"12:00",end:"16:00"}];},
    (b:Board)=>{b.resources![0].active=false;},
    (b:Board)=>{b.jobs[0].technicianId=null;},
    (b:Board)=>{b.schedule!.holds.push({id:randomUUID(),owner:"test",requestId:randomUUID(),digest:"fixture",createdAt:new Date(now).toISOString(),expiresAt:new Date(now+300000).toISOString(),releasedAt:null,start,end:"2026-10-12T15:00:00Z",technicianId:"t2",resourceId:"rack",skillKey:null});},
  ]) {
    const b=resourceFixture();change(b);const store=memoryStore(b);
    assert.throws(()=>buildResourceTimelinePlan(b,"j","rack",start,60,now));
    const command={type:"plan",jobId:"j",technicianId:b.jobs[0].technicianId,resource:"rack",plannedStart:start,estimatedMinutes:60,prerequisites:[],authorized:false};
    await assert.rejects(()=>executeDispatchMutation(principal,{requestId:randomUUID(),revision:b.revision,command},store.deps));
    assert.equal(store.writes,0);
  }
});
test("concurrent resource placements have one winner and stale revisions cannot overwrite it",async()=>{
  const b=resourceFixture();
  b.jobs.push({...structuredClone(b.jobs[0]),id:"second",technicianId:"t2"});
  const store=memoryStore(b);
  const requests=["j","second"].map(jobId=>({requestId:randomUUID(),revision:b.revision,command:buildResourceTimelinePlan(b,jobId,"rack",start,60,now)}));
  const results=await Promise.allSettled(requests.map(r=>executeDispatchMutation(principal,r,store.deps)));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(store.writes,1);
  await assert.rejects(()=>executeDispatchMutation(principal,{...requests[1],requestId:randomUUID()},store.deps),/changed|saved first/);
});
test("uncertain resource save retries the original receipt without a second write",async()=>{
  const b=resourceFixture(),store=memoryStore(b);
  const request={requestId:randomUUID(),revision:b.revision,command:buildResourceTimelinePlan(b,"j","rack",start,60,now)};
  const uncertain={...store.deps,save:async(shop:number,revision:number,next:Board)=>{
    await store.deps.save(shop,revision,next);throw Error("Synthetic response lost after commit");
  }};
  await assert.rejects(()=>executeDispatchMutation(principal,request,uncertain),/response lost/);
  const retried=await executeDispatchMutation(principal,request,store.deps);
  assert.equal(retried.jobs[0].resource,"rack");assert.equal(store.writes,1);
  await assert.rejects(()=>executeDispatchMutation(principal,{...request,command:{...request.command,resource:"bay"}},store.deps),/different work/);
});
