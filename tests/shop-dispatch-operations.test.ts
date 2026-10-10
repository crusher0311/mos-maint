import test from "node:test";
import assert from "node:assert/strict";
import {z} from "zod";
import {emptyBoard,applyCommand,blockers,commandSchema,type Actor,type Board,type Command} from "../lib/shop-dispatch/model";
import {dependencySuggestions,promiseRisk,readinessReasons} from "../lib/shop-dispatch/operations";
import {assertDependencyPlans,recommendNextJobs} from "../lib/shop-dispatch/operations-scheduling";
const now="2026-10-12T14:00:00.000Z",clock=Date.parse(now);
const manager={email:"manager@test.invalid",manager:true,technicianId:null};
const tech={email:"tech@test.invalid",manager:false,technicianId:"tech"};
const ready={parts:"received" as const,diagnostics:"ready" as const,requiredSkills:[],blockers:[],checks:[]};
function fixture(){
 let b=emptyBoard();
 const command=(c:Command)=>{b=applyCommand(b,c,manager,now);};
 command({type:"technician",id:"tech",name:"Tech",email:tech.email,active:true});
 command({type:"technician",id:"two",name:"Second",email:"two@test.invalid",active:true});
 command({type:"visit",id:"visit",ro:"100",vehicle:"Test",customer:""});
 command({type:"job",id:"repair",visitId:"visit",title:"Replace control arm",bookMinutes:60});
 command({type:"job",id:"align",visitId:"visit",title:"Wheel alignment",bookMinutes:30});
 command({type:"plan",jobId:"repair",technicianId:"tech",plannedStart:null,estimatedMinutes:null,prerequisites:[],resource:null,authorized:true});
 command({type:"operationsMode",enabled:true});
 return b;
}
function mutate(b:Board,c:z.input<typeof commandSchema>,actor:Actor=manager){return applyCommand(b,commandSchema.parse(c),actor,now);}
test("readiness is opt-in and enforced at start, including skills and owned blockers",()=>{
 let b=fixture();
 assert.throws(()=>mutate(b,{type:"start",jobId:"repair"},tech),/Readiness/);
 const legacy=mutate(b,{type:"operationsMode",enabled:false});
 assert.equal(mutate(legacy,{type:"start",jobId:"repair"},tech).jobs[0].status,"active");
 b=mutate(b,{type:"readiness",jobId:"repair",readiness:{...ready,parts:"partial",requiredSkills:["suspension"],blockers:[{id:"approval",reason:"Confirm authorization",owner:"Service advisor",resolved:false}]}});
 assert.ok(blockers(b,b.jobs[0]).some(r=>r.includes("partial")));
 assert.ok(blockers(b,b.jobs[0]).some(r=>r.includes("Service advisor")));
 assert.ok(blockers(b,b.jobs[0]).some(r=>r.includes("Confirmed skill")));
 assert.throws(()=>mutate(b,{type:"start",jobId:"repair"},tech),/Blocked/);
 b=mutate(b,{type:"readiness",jobId:"repair",readiness:ready});
 assert.equal(readinessReasons(b,b.jobs[0]).length,0);
 assert.equal(mutate(b,{type:"start",jobId:"repair"},tech).jobs[0].status,"active");
});
test("staff cannot change readiness or another technician's checks; closed visits stay locked",()=>{
 let b=fixture();
 assert.throws(()=>mutate(b,{type:"readiness",jobId:"repair",readiness:ready},tech),/Manager/);
 b=mutate(b,{type:"readiness",jobId:"repair",readiness:{...ready,checks:[{id:"road",label:"Road test"}]}});
 assert.throws(()=>mutate(b,{type:"quality",jobId:"repair",checkId:"road",done:true},tech),/Start the job/);
 assert.throws(()=>mutate(b,{type:"handoff",jobId:"repair",note:"Test"},{email:"other@test.invalid",manager:false,technicianId:"two"}),/assigned/);
 b.visits[0].closed=true;
 assert.throws(()=>mutate(b,{type:"readiness",jobId:"repair",readiness:ready}),/closed/i);
 assert.equal(commandSchema.safeParse({type:"readiness",jobId:"repair",shopId:99,readiness:ready}).success,false);
});
test("handoff required on reassignment; new owner acknowledges before start; final checks gate completion",()=>{
 let b=fixture();b=mutate(b,{type:"readiness",jobId:"repair",readiness:{...ready,checks:[{id:"road",label:"Road test"}]}});
 const plan:Command={type:"plan",jobId:"repair",technicianId:"two",plannedStart:null,estimatedMinutes:null,resource:null,authorized:true,prerequisites:[]};
 assert.throws(()=>mutate(b,plan),/fresh handoff/);
 b=mutate(b,{type:"handoff",jobId:"repair",note:"Repair verified; alignment and road test remain."},tech);
 b=mutate(b,plan);
 const second={email:"two@test.invalid",manager:false,technicianId:"two"};
 assert.throws(()=>mutate(b,{type:"start",jobId:"repair"},second),/Handoff/);
 b=mutate(b,{type:"acknowledgeHandoff",jobId:"repair"},second);
 b=mutate(b,{type:"start",jobId:"repair"},second);
 assert.throws(()=>mutate(b,{type:"complete",jobId:"repair"},second),/quality checks/);
 b=mutate(b,{type:"quality",jobId:"repair",checkId:"road",done:true},second);
 assert.equal(b.jobs[0].operations!.checks[0].completedBy,second.email);
 b=mutate(b,{type:"complete",jobId:"repair"},second);
 assert.equal(b.jobs[0].status,"completed");
 b=mutate(b,{type:"quality",jobId:"repair",checkId:"road",done:false},second);
 b.jobs[1].status="completed";b.jobs[1].operations={...b.jobs[0].operations!,checks:[]};
 assert.throws(()=>mutate(b,{type:"close",visitId:"visit"}),/quality checks/);
});
test("blocker timestamps persist; changing a check invalidates its previous signoff",()=>{
 let b=fixture();
 const input={...ready,blockers:[{id:"part",reason:"Verify delivery",owner:"Parts",resolved:false}],checks:[{id:"q",label:"Check repair"}]};
 b=mutate(b,{type:"readiness",jobId:"repair",readiness:input});
 const opened=b.jobs[0].operations!.blockers[0].openedAt;
 b.jobs[0].operations!.checks[0].completedAt=now;
 b=mutate(b,{type:"readiness",jobId:"repair",readiness:{...input,blockers:[{...input.blockers[0],resolved:true}],checks:[{id:"q",label:"New inspection"}]}});
 assert.equal(b.jobs[0].operations!.blockers[0].openedAt,opened);
 assert.equal(b.jobs[0].operations!.blockers[0].resolvedAt,now);
 assert.equal(b.jobs[0].operations!.checks[0].completedAt,null);
});
test("dependency suggestions never apply themselves or match inspection-only work",()=>{
 const b=fixture();
 assert.deepEqual(dependencySuggestions(b,b.jobs[1]).map(s=>s.jobId),["repair"]);
 assert.deepEqual(b.jobs[1].prerequisites,[]);
 b.jobs[0].title="Inspect suspension";
 assert.equal(dependencySuggestions(b,b.jobs[1]).length,0);
});
test("dependency scheduling rejects overlap, unknown durations, reverse edits and cycles",()=>{
 let b=fixture();b.jobs[0].plannedStart=now;b.jobs[1].prerequisites=["repair"];b.jobs[1].plannedStart="2026-10-12T14:30:00Z";
 assert.throws(()=>assertDependencyPlans(b,"align",clock),/cannot be planned/);
 b.jobs[1].plannedStart="2026-10-12T15:00:00Z";
 assert.doesNotThrow(()=>assertDependencyPlans(b,"align",clock));
 b.jobs[0].bookMinutes=120;
 assert.throws(()=>assertDependencyPlans(b,"repair",clock),/cannot be planned/);
 b.jobs[0].bookMinutes=null;
 assert.throws(()=>assertDependencyPlans(b,"align",clock),/known duration/);
 assert.throws(()=>mutate(b,{type:"plan",jobId:"repair",technicianId:"tech",plannedStart:null,estimatedMinutes:60,prerequisites:["align"],resource:null,authorized:true}),/cycle/);
});
test("promise risk distinguishes unknown from a dependency lower bound that misses the promise",()=>{
 let b=fixture();
 assert.equal(promiseRisk(b,"visit",clock).level,"unknown");
 b.visits[0].promiseAt="2026-10-12T15:15:00Z";b.jobs[1].prerequisites=["repair"];
 assert.equal(promiseRisk(b,"visit",clock).level,"at-risk");
 b.visits[0].promiseAt="2026-10-12T18:00:00Z";
 assert.equal(promiseRisk(b,"visit",clock).level,"unknown");
 assert.ok(promiseRisk(b,"visit",clock).reasons.some(r=>r.includes("Readiness")));
});
test("recommendations require fresh schedule evidence and exclude time off, holds and wrong skills",()=>{
 let b=fixture();b=mutate(b,{type:"readiness",jobId:"repair",readiness:ready});
 assert.equal(recommendNextJobs(b,"tech",clock).length,0);
 const weekly=[{day:1,start:"08:00",end:"17:00"}];
 b.schedule={holds:[],settings:{enabled:true,timeZone:"America/Chicago",weekly,technicians:[{id:"tech",weekly,timeOff:[]}],resources:[],bufferMinutes:0,leadMinutes:60},appointments:{startDate:"2026-10-12",endDate:"2026-10-13",fetchedAt:now,complete:true,appointments:[]}};
 assert.equal(recommendNextJobs(b,"tech",clock)[0]?.jobId,"repair");
 b.schedule.settings!.technicians[0].timeOff=[{start:now,end:"2026-10-12T16:00:00Z"}];
 assert.equal(recommendNextJobs(b,"tech",clock).length,0);
 b.schedule.settings!.technicians[0].timeOff=[];
 b.jobs[0].operations!.requiredSkills=["alignment"];
 assert.equal(recommendNextJobs(b,"tech",clock).length,0);
 b.jobs[0].operations!.requiredSkills=[];
 b.schedule.appointments!.complete=false;
 assert.equal(recommendNextJobs(b,"tech",clock).length,0);
});
