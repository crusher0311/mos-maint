import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {emptyBoard, type Board, type Command} from "../lib/shop-dispatch/model";
import {executeDispatchMutation} from "../lib/shop-dispatch/service";
import {visibleLaneTechnicians} from "../lib/shop-dispatch/lane-views";
import {availability} from "../lib/shop-dispatch/schedule-engine";
import {buildTimelinePlan} from "../lib/shop-dispatch/timeline";

const now=Date.parse("2026-10-12T12:00:00Z");
function fixture():Board {
  const b=emptyBoard();
  b.technicians=[
    {id:"tire",name:"Tire technician",email:"",active:true,skills:[{key:"tires",title:"Tire service",status:"confirmed",notes:"",reviewedAt:new Date(now).toISOString(),reviewedBy:"manager"}]},
    {id:"oil",name:"Oil technician",email:"",active:true},
    {id:"past",name:"Past technician",email:"",active:false},
  ];
  const weekly=[{day:1,start:"07:30",end:"17:30"}];
  b.schedule={holds:[],settings:{enabled:true,timeZone:"America/Chicago",weekly,technicians:b.technicians.map(t=>({id:t.id,weekly,timeOff:[]})),resources:[],bufferMinutes:0,leadMinutes:0},
    appointments:{startDate:"2026-10-12",endDate:"2026-10-13",complete:true,fetchedAt:new Date(now).toISOString(),appointments:[]}};
  return b;
}
function store(){
  // Serialization on both sides mimics a fresh repository read, not shared references.
  const rows=new Map<number,string>([[10,JSON.stringify(fixture())],[20,JSON.stringify(fixture())]]);
  const read=async(id:number)=>JSON.parse(rows.get(id)??JSON.stringify(emptyBoard())) as Board;
  const deps={read,save:async(id:number,revision:number,b:Board)=>{
    if((await read(id)).revision!==revision)return false;
    rows.set(id,JSON.stringify(b));return true;
  },now:()=>new Date(now).toISOString(),intake:async()=>{throw Error("Provider access forbidden");}};
  const send=async(command:Command,shopId=10,role="manager",revision?:number,requestId=randomUUID())=>
    executeDispatchMutation({shopId,email:"manager@example.test",role},{command,revision:revision??(await read(shopId)).revision,requestId},deps);
  return {read,send};
}
const view={id:"team",name:"Tire service",technicianIds:[],skillKeys:["tires"]};

test("saved views create, edit, select, reload and delete independently per shop",async()=>{
  const s=store(),initial=await s.read(10),other=await s.read(20);
  await s.send({type:"saveScheduleView",view});
  await s.send({type:"selectScheduleView",id:view.id});
  let b=await s.read(10);
  assert.deepEqual(visibleLaneTechnicians(b).map(t=>t.id),["tire"]);
  await s.send({type:"saveScheduleView",view:{...view,name:"Oil and repair team",technicianIds:["oil"],skillKeys:[]}});
  b=await s.read(10);
  assert.equal(b.scheduleViews?.views[0].name,"Oil and repair team");
  assert.deepEqual(visibleLaneTechnicians(b).map(t=>t.id),["oil"]);
  assert.deepEqual(b.technicians,initial.technicians);
  assert.deepEqual(b.schedule,initial.schedule);
  assert.deepEqual(b.jobs,initial.jobs);
  assert.deepEqual(await s.read(20),other);
  await assert.rejects(s.send({type:"selectScheduleView",id:view.id},20),/not found/);
  await s.send({type:"deleteScheduleView",id:view.id});
  b=await s.read(10);
  assert.deepEqual(b.scheduleViews,{views:[],selectedId:null});
  assert.equal(visibleLaneTechnicians(b).length,3);
});

test("manager, validation, tenant membership, CAS and retry boundaries",async()=>{
  const s=store();
  await assert.rejects(s.send({type:"saveScheduleView",view},10,"user"),/Manager/);
  await assert.rejects(s.send({type:"saveScheduleView",view:{...view,technicianIds:["foreign"]}}),/roster/);
  await assert.rejects(s.send({type:"saveScheduleView",view:{...view,skillKeys:["history-only"]}}),/manager-confirmed/);
  await assert.rejects(s.send({type:"saveScheduleView",view:{...view,skillKeys:[]}}),/Invalid command/);
  const requestId=randomUUID();
  await s.send({type:"saveScheduleView",view},10,"manager",0,requestId);
  const b=await s.send({type:"saveScheduleView",view},10,"manager",0,requestId);
  assert.equal(b.revision,1);
  await assert.rejects(s.send({type:"deleteScheduleView",id:view.id},10,"manager",0),/Another user/);
  await assert.rejects(s.send({type:"saveScheduleView",view:{...view,id:"duplicate"}}),/name already exists/);
  await assert.rejects(s.send({type:"selectScheduleView",id:"foreign"}),/not found/);
});

test("current employment and confirmed skills stay authoritative, empty views never widen scope",()=>{
  const b=fixture();
  b.scheduleViews={views:[{...view,technicianIds:["past"]}],selectedId:view.id};
  assert.deepEqual(visibleLaneTechnicians(b).map(t=>t.id),["tire"]);
  b.technicians[0].skills![0].status="not-qualified";
  assert.deepEqual(visibleLaneTechnicians(b),[]);
  b.technicians[0].skills![0].status="confirmed";b.technicians[0].active=false;
  assert.deepEqual(visibleLaneTechnicians(b),[]);
  b.scheduleViews.selectedId=null;
  assert.equal(visibleLaneTechnicians(b).length,3);
});

test("hidden technicians' jobs and bays still block conflicts; availability is identical",()=>{
  const b=fixture();
  b.visits=[{id:"v",ro:"OFFLINE-RO",vehicle:"Synthetic",customer:"",arrivalAt:null,promiseAt:null,closed:false,provider:"manual",sourceId:null,sourceStatus:null,sourceFetchedAt:null,transport:{customerPlan:"unknown",ride:"none",loaner:"none",loanerId:"",pickupAt:null,notes:""}}];
  const job={id:"hidden",visitId:"v",title:"Hidden bay work",technicianId:"oil",plannedStart:"2026-10-12T14:00:00.000Z",estimatedMinutes:60,bookMinutes:60,prerequisites:[],resource:"rack",status:"idle" as const,activeMs:0,waitingMs:0,since:null,pauseReason:null,sourceId:null,sourceRemoved:false,authorized:true};
  b.jobs=[job,{...job,id:"moving",technicianId:null,plannedStart:null}];
  const query={startDate:"2026-10-12",endDate:"2026-10-13",durationMinutes:60};
  const before=availability(b,query,now);
  b.scheduleViews={views:[view],selectedId:view.id};
  assert.deepEqual(availability(b,query,now),before);
  assert.deepEqual(visibleLaneTechnicians(b).map(t=>t.id),["tire"]);
  assert.throws(()=>buildTimelinePlan(b,"moving","tire",job.plannedStart,60,now),/conflicts/);
  assert.throws(()=>buildTimelinePlan(b,"moving","oil",job.plannedStart,60,now),/conflicts/);
  assert.equal(b.jobs.length,2);
});
