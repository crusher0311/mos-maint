import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyBoard, applyCommand } from "../lib/shop-dispatch/model";
import { reconcileSourceSnapshots, syncCachedSources, type SourceSnapshot } from "../lib/shop-dispatch/source-sync";
import { DEFAULT_SOURCE_STATUSES, isVisitVisible } from "../lib/shop-dispatch/source-preferences";
import { executeDispatchMutation } from "../lib/shop-dispatch/service";

const id="11111111-1111-4111-8111-111111111111",pkg="22222222-2222-4222-8222-222222222222";
const now="2026-10-09T15:00:00.000Z",later="2026-10-09T15:05:00.000Z";
const manager={email:"manager@example.test",manager:true,technicianId:null};
function row(stage="Unassigned",fetchedAt=now):SourceSnapshot {
  return {shopId:10,workOrderId:id,fetchedAt,workflowStage:stage,rawPayload:{
    ID:id,WorkOrderNumber:123,WorkflowStage:stage,Status:"Open",Completed:false,
    ServiceItem:{Year:2024,Make:"Test",Model:"Vehicle"},ServicePackages:[{ID:pkg,ServicePackageHeader:{Title:"Inspect tires"}}],
  }};
}
test("selected callback stages automatically import once; no mileage requirement",()=>{
  const {board,failed}=reconcileSourceSnapshots(emptyBoard(),10,[row()],now);
  assert.equal(failed,0);assert.equal(board.visits[0].ro,"123");
  assert.equal(board.visits[0].sourceStatus,"Unassigned");
  assert.equal(board.jobs[0].title,"Inspect tires");assert.equal(board.jobs[0].authorized,false);
  assert.equal(reconcileSourceSnapshots(board,10,[row()],later).board,board);
});
test("preferences are independent, empty selection honored, manual visits always visible",()=>{
  const initial=emptyBoard();initial.sourceStatuses=[];
  assert.equal(reconcileSourceSnapshots(initial,10,[row()],now).board.visits.length,0);
  assert.equal(isVisitVisible({provider:"manual",sourceStatus:null},[]),true);
  assert.equal(isVisitVisible({provider:"protractor",sourceStatus:"Unassigned"},[]),false);
  assert(DEFAULT_SOURCE_STATUSES.includes("Unassigned"));
  assert.throws(()=>applyCommand(initial,{type:"sourceStatuses",statuses:[]},{...manager,manager:false},now),/Manager/);
});
test("status changes hide visits without deleting or unassigning work",()=>{
  let board=reconcileSourceSnapshots(emptyBoard(),10,[row()],now).board;
  board.jobs[0].technicianId="tech";board.jobs[0].activeMs=2000;board.jobs[0].authorized=true;
  board.sourceStatuses=["Unassigned"];
  const next=reconcileSourceSnapshots(board,10,[row("VehicleInBay",later)],later).board;
  assert.equal(next.visits.length,1);assert.equal(isVisitVisible(next.visits[0],next.sourceStatuses),false);
  assert.equal(next.jobs[0].technicianId,"tech");assert.equal(next.jobs[0].activeMs,2000);assert.equal(next.jobs[0].authorized,true);
  const terminal={...row("Closed","2026-10-09T15:10:00.000Z"),completed:true};
  const closed=reconcileSourceSnapshots(next,10,[terminal],later).board;
  assert.equal(closed.visits[0].closed,false);assert.equal(closed.visits[0].sourceStatus,"Closed");
  assert.deepEqual(closed.jobs,next.jobs);
});
test("other shops, stale snapshots, malformed payloads and locally closed visits do not overwrite work",()=>{
  const good=reconcileSourceSnapshots(emptyBoard(),10,[row()],now).board;
  assert.equal(reconcileSourceSnapshots(good,10,[{...row("VehicleInBay",later),shopId:11}],later).board,good);
  assert.equal(reconcileSourceSnapshots(good,10,[row("VehicleInBay","2026-10-09T14:00:00Z")],later).board,good);
  const invalid={...row("VehicleInBay",later),rawPayload:{ID:id,WorkOrderNumber:123}};
  assert.equal(reconcileSourceSnapshots(good,10,[invalid],later).failed,1);
  assert.equal(good.visits[0].sourceStatus,"Unassigned");
  good.visits[0].closed=true;
  assert.equal(reconcileSourceSnapshots(good,10,[row("VehicleInBay",later)],later).board,good);
});
test("CAS conflict preserves concurrent edits; cache failures keep board usable and explicit",async()=>{
  const initial=emptyBoard(),winner={...emptyBoard(),revision:1,sourceStatuses:[]};
  const result=await syncCachedSources(10,initial,{
    list:async()=>[row()],save:async()=>false,read:async()=>winner,
  });
  assert.equal(result.board,winner);assert.match(result.sourceSyncWarning!,/Another user/);
  const failed=await syncCachedSources(10,initial,{
    list:async()=>{throw new Error("timeout");},save:async()=>{throw new Error("must not write");},read:async()=>initial,
  });
  assert.equal(failed.board,initial);assert.match(failed.sourceSyncWarning!,/unavailable/);
});
test("RO-number intake enforces manager scope, verifies returned number and retains UUID compatibility",async()=>{
  let board=emptyBoard(),calls=0;
  const intake={sourceId:id,ro:"123",vehicle:"Test",customer:"",sourceStatus:"Unassigned",jobs:[]};
  const deps={read:async()=>board,save:async(_shop:number,_revision:number,next:typeof board)=>{board=next;return true;},
    now:()=>now,intake:async()=>intake,intakeByNumber:async(shop:number,number:string)=>{
      calls++;assert.equal(shop,10);assert.equal(number,"#123");return intake;
    }};
  const raw={requestId:randomUUID(),revision:0,command:{type:"syncNumber",roNumber:"#123"}};
  await assert.rejects(executeDispatchMutation({shopId:10,email:"tech@example.test",role:"user"},raw,deps),/manager/i);
  assert.equal(calls,0);
  await executeDispatchMutation({shopId:10,email:manager.email,role:"manager"},raw,deps);
  assert.equal(board.visits[0].ro,"123");
  await executeDispatchMutation({shopId:10,email:manager.email,role:"manager"},
    {requestId:randomUUID(),revision:board.revision,command:{type:"sync",workOrderId:id}},deps);
  assert.equal(board.visits.length,1);
  await assert.rejects(executeDispatchMutation({shopId:10,email:manager.email,role:"manager"},
    {requestId:randomUUID(),revision:board.revision,command:{type:"syncNumber",roNumber:"124"}},
    {...deps,intakeByNumber:async()=>intake}),/identity mismatch/);
});
