import test from "node:test";
import assert from "node:assert/strict";
import {buildSkillProfiles} from "../lib/shop-dispatch/skills";
import {applyCommand,emptyBoard} from "../lib/shop-dispatch/model";
const tech={id:"local",name:"Tech",email:"",active:true,sourceId:"employee"};
const labor=(id="employee")=>({Type:"Labor",Technician:{ID:id,Name:"Technician"}});
const invoice=(id:string,date:string,lines:any[],extra:any={})=>({
 ID:id,InvoiceTime:date,Type:"WorkOrder",Completed:false,WorkOrderNumber:id,
 ServicePackages:{ItemCollection:[{ID:"pkg",ServicePackageHeader:{Title:"Brake Service"},ServicePackageLines:{ItemCollection:lines}}]},...extra,
});
test("invoiced skill evidence deduplicates pages and labor lines, counts shared work, and orders recency",()=>{
 const first=invoice("1","2026-01-01T12:00:00Z",[labor(),labor(),labor("other")]);
 const second=invoice("2","2026-02-01T12:00:00Z",[labor()]);
 const result=buildSkillProfiles([{invoices:[first,first,second]}],[tech,{...tech,id:"unlinked",sourceId:undefined}]);
 const skill=result[0].skills[0];
 assert.equal(skill.count,2);assert.equal(skill.sharedJobCount,1);
 assert.equal(skill.lastCompletedAt,"2026-02-01T12:00:00.000Z");
 assert.equal(skill.evidence[0].ro,"2");assert.equal(skill.key,"brake service");
 assert.deepEqual(result[1].skills,[]);
});
test("credits, undated orders, parts-only attribution and declined packages never establish skills",()=>{
 const declined=invoice("d","2026-01-01T12:00:00Z",[labor()]);
 declined.ServicePackages.ItemCollection[0].Status="Declined";
 const rows=[
 invoice("c","2026-01-01T12:00:00Z",[labor()],{Type:"CreditSlip"}),
 invoice("o","",[labor()]),declined,
 invoice("p","2026-01-01T12:00:00Z",[{...labor(),Type:"Material"}]),
 ];
 assert.deepEqual(buildSkillProfiles([{invoices:rows}],[tech])[0].skills,[]);
});
test("manager assessments are audited, editable, removable and never grant employment or login access",()=>{
 const manager={email:"manager@example.test",manager:true,technicianId:null};
 const now="2026-10-09T12:00:00Z";
 const board=emptyBoard();board.technicians.push(tech);
 const cmd={type:"skill" as const,technicianId:"local",key:" Brake Service ",title:"Brake service",status:"confirmed" as const,notes:"Observed independently"};
 const confirmed=applyCommand(board,cmd,manager,now);
 assert.equal(confirmed.technicians[0].skills?.[0].key,"brake service");
 assert.equal(confirmed.technicians[0].skills?.[0].reviewedBy,manager.email);
 assert.equal(confirmed.technicians[0].email,"");
 assert.equal(confirmed.audit.at(-1)?.action,"skill");
 const edited=applyCommand(confirmed,{...cmd,status:"not-qualified"},manager,now);
 assert.equal(edited.technicians[0].skills?.length,1);
 assert.equal(edited.technicians[0].skills?.[0].status,"not-qualified");
 const removed=applyCommand(edited,{...cmd,status:"remove"},manager,now);
 assert.deepEqual(removed.technicians[0].skills,[]);
 assert.throws(()=>applyCommand(board,cmd,{...manager,manager:false},now),/Manager/);
 assert.throws(()=>applyCommand(board,{...cmd,technicianId:"foreign"},manager,now),/not found/);
});
