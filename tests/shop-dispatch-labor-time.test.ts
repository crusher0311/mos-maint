import test from "node:test";
import assert from "node:assert/strict";
import {protractorBookMinutes} from "../lib/shop-dispatch/labor-time";
import {packageTechnicians} from "../lib/shop-dispatch/provider-technicians";
import {mapProtractorWorkOrder} from "../lib/shop-dispatch/protractor";
import {applyCommand,emptyBoard} from "../lib/shop-dispatch/model";
test("book time uses billed hours without double-counting lines",()=>{
 assert.equal(protractorBookMinutes({BilledHours:"1.5",ServicePackageLines:[{Type:"Labor",Hours:3}]}),90);
 assert.equal(protractorBookMinutes({Hours:0}),0);
});
test("labor lines support arrays and wrappers, exclude material and declined labor",()=>{
 const lines=[{Type:"Labor",Hours:"1.25"},{LineType:"Labor",Quantity:0.5},{Type:"Material",Quantity:9},{Type:"Labor",Hours:5,Status:"Declined"}];
 assert.equal(protractorBookMinutes({ServicePackageLines:lines}),105);
 assert.equal(protractorBookMinutes({ServicePackageLines:{ItemCollection:lines}}),105);
});
test("unknown, malformed and actual time never become book time",()=>{
 for(const pkg of [{},{ActualHours:4},{EstimatedHours:5},{ServicePackageLines:[{Type:"Labor",ActualHours:4}]},{ServicePackageLines:[{Type:"Labor",Hours:1},{Type:"Labor"}]},{Hours:Infinity},{Hours:200},{ServicePackageLines:[{Type:"Material",Quantity:3}]}])
  assert.equal(protractorBookMinutes(pkg),null);
});
test("package and labor-line technicians are preserved without material attribution or name coercion",()=>{
 const result=packageTechnicians({Technician:{ID:"ABC",Name:"First"},ServicePackageLines:{ItemCollection:[
  {Type:"Labor",Technician:{ID:"abc",Name:"First"}},
  {Type:"Labor",Technician:{ID:"DEF",Name:{FirstName:"Second",LastName:"Tech"}}},
  {Type:"Labor",Technician:"Name only"},
  {Type:"Labor",Technician:"[object Object]"},
  {Type:"Material",Technician:{ID:"no",Name:"Parts"}},
  {Type:"Labor",Status:"Declined",Technician:{ID:"no",Name:"Declined"}},
 ]}});
 assert.deepEqual(result,[{sourceId:"abc",name:"First"},{sourceId:"def",name:"Second Tech"},{sourceId:null,name:"Name only"}]);
});
test("refresh imports hours and assignments but preserves local planning, authorization and clocks",()=>{
 const id="11111111-1111-4111-8111-111111111111",pkg="22222222-2222-4222-8222-222222222222";
 const map=(hours:number,name:string)=>mapProtractorWorkOrder({ID:id,Type:"WorkOrder",ServicePackages:[{ID:pkg,Title:"Service",ServicePackageLines:[{Type:"Labor",Hours:hours,Technician:{ID:"provider",Name:name}}]}]} as any,id);
 const actor={email:"manager@example.test",manager:true,technicianId:null};
 let board=applyCommand(emptyBoard(),{type:"sync",workOrderId:id},actor,"2026-10-10T12:00:00Z",map(1.5,"First"));
 assert.equal(board.jobs[0].bookMinutes,90);
 assert.equal(board.jobs[0].technicianId,null);
 assert.equal(board.jobs[0].authorized,false);
 board.jobs[0].technicianId="local";board.jobs[0].estimatedMinutes=35;board.jobs[0].activeMs=1234;
 board=applyCommand(board,{type:"sync",workOrderId:id},actor,"2026-10-10T12:01:00Z",map(2,"Updated"));
 assert.equal(board.jobs[0].bookMinutes,120);
 assert.deepEqual(board.jobs[0].sourceTechnicians,[{sourceId:"provider",name:"Updated"}]);
 assert.equal(board.jobs[0].technicianId,"local");assert.equal(board.jobs[0].estimatedMinutes,35);assert.equal(board.jobs[0].activeMs,1234);
});
