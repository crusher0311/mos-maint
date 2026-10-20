import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {isolatedStaffDatabase} from "./helpers/staff-inspection-fixture";
import {admitGuidedRO,confirmGuidedRO} from "../lib/data/repositories/guided-ro-operations";
import {ROArrivalPhotos} from "../lib/data/repositories/ro-arrival-photos";
import {handoffRO} from "../lib/auto-dvi/staff/ro-handoff";
import {emptyBoard,type Intake} from "../lib/shop-dispatch/model";
let isolated:Awaited<ReturnType<typeof isolatedStaffDatabase>>;
before(async()=>{isolated=await isolatedStaffDatabase(27836);});
after(async()=>{await isolated.close();});
const database=()=>isolated.client.db(`guided_${randomUUID().replaceAll("-","")}`);
test("admission is exclusive; pending verification never admits another provider write",async()=>{
  const db=database(),input={id:randomUUID(),shopId:66,actor:"advisor",payload:{concerns:["noise"],clientRequestId:randomUUID()},recoveryOnly:false};
  const results=await Promise.all([admitGuidedRO(db,input),admitGuidedRO(db,input)]);
  assert.equal(results.filter(r=>r.admitted).length,1);
  assert.deepEqual(await admitGuidedRO(db,{...input,recoveryOnly:true}),{admitted:false,result:null});
  await assert.rejects(admitGuidedRO(db,{...input,payload:{concerns:["changed"]}}));
  await assert.rejects(admitGuidedRO(db,{...input,actor:"another"}));
  await assert.rejects(admitGuidedRO(db,{...input,shopId:67}));
});
test("late confirmation survives a lost response and returns the original official RO",async()=>{
  const db=database(),input={id:randomUUID(),shopId:66,actor:"advisor",payload:{clientRequestId:randomUUID()},recoveryOnly:false};
  await admitGuidedRO(db,input);
  await assert.rejects(confirmGuidedRO(db,input.id,{ok:true,workOrderId:randomUUID(),workOrderNumber:9}));
  await confirmGuidedRO(db,input.id,{ok:true,workOrderId:input.id,workOrderNumber:1234});
  assert.deepEqual(await admitGuidedRO(db,{...input,recoveryOnly:true}),{admitted:false,
    result:{ok:true,workOrderId:input.id,workOrderNumber:1234}});
  await assert.rejects(admitGuidedRO(db,{...input,id:randomUUID(),recoveryOnly:true}));
});
test("arrival photos persist binary bytes with bounded exact retries and shop isolation",async()=>{
  const db=database(),repo=new ROArrivalPhotos(async()=>db),id=randomUUID(),requestId=randomUUID();
  const bytes=Buffer.from("89504e470d0a1a0a0000","hex");
  await assert.rejects(repo.requireConfirmed(66,id));
  const input={id,shopId:66,actor:"advisor",payload:{},recoveryOnly:false};
  await admitGuidedRO(db,input);await confirmGuidedRO(db,id,{ok:true,workOrderId:id,workOrderNumber:12});
  await repo.requireConfirmed(66,id);
  const first=await repo.put(66,id,requestId,"image/png",bytes);
  assert.deepEqual(await repo.put(66,id,requestId,"image/png",bytes),first);
  assert.deepEqual((await repo.read(66,id,first.id)).bytes,bytes);
  await assert.rejects(repo.read(67,id,first.id));
  await assert.rejects(repo.put(66,id,requestId,"image/png",Buffer.concat([bytes,Buffer.from("a")])));
  await assert.rejects(repo.put(66,id,randomUUID(),"image/jpeg",bytes));
  await assert.rejects(repo.put(66,id,randomUUID(),"image/png",Buffer.alloc(4*1024*1024+1)));
  assert.equal((await repo.list(66,id)).length,1);
  assert.equal((await repo.list(67,id)).length,0);
  for(let i=1;i<12;i++)await repo.put(66,id,randomUUID(),"image/png",bytes);
  await assert.rejects(repo.put(66,id,randomUUID(),"image/png",bytes),/Maximum 12/);
});
function fixture(){
  let board=emptyBoard();const id=randomUUID();
  const access={shopId:66,actor:"advisor",email:"advisor@example.invalid",canEdit:true};
  const intake:Intake={sourceId:id,ro:"1234",customer:"Fixture customer",vehicle:"Fixture vehicle",sourceStatus:"WorkOrder",jobs:[]};
  const deps={access:async()=>access,read:async()=>structuredClone(board),
    save:async(_shop:number,revision:number,next:typeof board)=>{if(revision!==board.revision)return false;board=next;return true;},
    fetch:async()=>intake,now:()=>new Date().toISOString()};
  return {id,access,intake,deps,board:()=>board};
}
test("confirmed native identity opens one visit without any create API, including repeated handoff",async()=>{
  const f=fixture(),request={requestId:randomUUID(),workOrderId:f.id,workOrderNumber:1234};
  const first=await handoffRO(request,f.deps),second=await handoffRO({...request,requestId:randomUUID()},f.deps);
  assert.deepEqual(first,second);assert.equal(f.board().visits.length,1);
  assert.equal(f.board().jobs.length,0);assert.match(first!.href,/dvi=1/);
});
test("handoff rejects identity mismatch, no entitlement, revoked authority and closed local visits",async()=>{
  const f=fixture(),request={requestId:randomUUID(),workOrderId:f.id,workOrderNumber:1234};
  await assert.rejects(handoffRO({...request,workOrderNumber:999},f.deps));
  f.access.canEdit=false;await assert.rejects(handoffRO(request,f.deps));f.access.canEdit=true;
  let calls=0;
  await assert.rejects(handoffRO(request,{...f.deps,access:async()=>({...f.access,canEdit:++calls===1})}));
  await handoffRO(request,f.deps);f.board().visits[0].closed=true;
  await assert.rejects(handoffRO(request,f.deps),/Closed/);
});
test("handoff preserves concurrent work and fails explicitly after bounded CAS conflicts",async()=>{
  const f=fixture();let saves=0;
  await assert.rejects(handoffRO({requestId:randomUUID(),workOrderId:f.id,workOrderNumber:1234},
    {...f.deps,save:async()=>{saves++;return false;}}),/Retry opening DVI/);
  assert.equal(saves,3);assert.equal(f.board().visits.length,0);
});
