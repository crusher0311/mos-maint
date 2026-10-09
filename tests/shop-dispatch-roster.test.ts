import test from "node:test";
import assert from "node:assert/strict";
import {applyCommand,emptyBoard,actorFor,resourcesFor,type Command} from "../lib/shop-dispatch/model";
import {mapRoster} from "../lib/shop-dispatch/roster";
const now="2026-10-09T17:00:00Z",manager={email:"manager@example.test",manager:true,technicianId:null};
const step=(b:ReturnType<typeof emptyBoard>,c:Command)=>applyCommand(b,c,manager,now);
test("roster entries need no accounts; later linking keeps identity, work and provider link",()=>{
 let b=emptyBoard();
 b=step(b,{type:"technician",id:"one",name:"One",email:"",active:true});
 b=step(b,{type:"technician",id:"two",name:"Two",email:"",active:true});
 assert.equal(actorFor(b,"","user").technicianId,null);
 b=applyCommand(b,{type:"importTechnician",id:"one",sourceId:"employee"},manager,now,undefined,{id:"employee",name:"Provider name",active:true});
 b=step(b,{type:"technician",id:"one",name:"Provider name",email:"one@example.test",active:true});
 assert.equal(b.technicians[0].sourceId,"employee");
 assert.equal(actorFor(b,"one@example.test","user").technicianId,"one");
 assert.throws(()=>step(b,{type:"technician",id:"two",name:"Two",email:"one@example.test",active:true}),/already mapped/);
 assert.throws(()=>applyCommand(b,{type:"importTechnician",id:"two",sourceId:"employee"},manager,now,undefined,{id:"employee",name:"One",active:true}),/already has a lane/);
});
test("custom bays persist, enforce occupancy, reject unknown resources and preserve legacy rack",()=>{
 let b=emptyBoard();assert.equal(resourcesFor(b)[0].id,"rack");
 b=step(b,{type:"resource",id:"bay",name:"Bay 2",active:true});
 for(const id of ["one","two"]){
 b=step(b,{type:"technician",id,name:id,email:"",active:true});
 b=step(b,{type:"visit",id,ro:id,vehicle:"Test",customer:""});
 b=step(b,{type:"job",id,visitId:id,title:"Test",bookMinutes:null});
 b=step(b,{type:"plan",jobId:id,technicianId:id,plannedStart:null,estimatedMinutes:null,prerequisites:[],resource:"bay",authorized:true});
 }
 b=step(b,{type:"start",jobId:"one",pauseCurrent:false});
 assert.throws(()=>step(b,{type:"start",jobId:"two",pauseCurrent:false}),/Bay 2 is occupied/);
 assert.throws(()=>step(b,{type:"resource",id:"bay",name:"Bay 2",active:false}),/Reassign/);
 b=step(b,{type:"resource",id:"bay",name:"North bay",active:true});
 assert.equal(b.jobs[0].resource,"bay");
 assert.throws(()=>step(b,{type:"plan",jobId:"two",technicianId:"two",plannedStart:null,estimatedMinutes:null,prerequisites:[],resource:"missing",authorized:true}),/active bay/);
 assert.throws(()=>applyCommand(b,{type:"resource",id:"x",name:"X",active:true},{...manager,manager:false},now),/Manager/);
});
test("provider roster validates identities and marks inactive staff without creating logins",()=>{
 const rows=mapRoster([{ID:"ABC",FileAs:"Person"},{ID:"ABC",FileAs:"Duplicate"},{ID:"X",FileAs:"Inactive",IsActive:false},{ID:"",FileAs:"Invalid"}]);
 assert.deepEqual(rows,[{id:"abc",name:"Person",active:true},{id:"x",name:"Inactive",active:false}]);
});
