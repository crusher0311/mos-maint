import test from "node:test";
import assert from "node:assert/strict";
import {historicalCandidates,readHistoricalRoster} from "../lib/shop-dispatch/historical-roster";
const page=(lines:unknown[])=>({invoices:[{ServicePackages:{ItemCollection:[{ServicePackageLines:{ItemCollection:lines}}]}}]});
test("history suggestions deduplicate identities, retain multiple technicians, and mark unknown current status",()=>{
 const rows=historicalCandidates([page([
  {Technician:{ID:"ABC",Name:"One"}},
  {Technician:{ID:"abc",Name:"One"}},
  {Technician:{ID:"DEF",Name:{FirstName:"Two",LastName:"Tech"}}},
  {Technician:"[object Object]"},
 ])]);
 assert.deepEqual(rows,[{id:"abc",name:"One",active:true,historical:true},{id:"def",name:"Two Tech",active:true,historical:true}]);
});
test("ambiguous names and missing identities are not silently selected",()=>{
 assert.deepEqual(historicalCandidates([page([
  {Technician:{ID:"same",Name:"One"}},{Technician:{ID:"same",Name:"Other"}},
  {Technician:{Name:"No identity"}},
 ])]),[]);
});
test("history reads are current-shop, completed-job scoped and bounded; cross-shop rows are rejected",async()=>{
 const calls:any[]=[];
 const db={collection:(name:string)=>({find:(filter:any,options:any)=>{
   calls.push({name,filter,options});
   return {maxTimeMS:(ms:number)=>{
     assert.ok(ms>0&&ms<=5000);
     return {toArray:async()=>name==="operator_history_import_jobs"
       ?[{_id:"owned",shopId:538},{_id:"foreign",shopId:999}]
       :[page([{Technician:{ID:"one",Name:"One"}}])]};
   }};
 }})};
 const result=await readHistoricalRoster(538,db as any);
 assert.equal(result.employees.length,1);
 assert.deepEqual(calls[0].filter,{shopId:538,status:"completed"});
 assert.equal(calls.length,2);
 assert.deepEqual(calls[1].filter,{_id:{$gte:"owned:",$lt:"owned:\uffff"}});
 assert.equal(calls[1].options.limit,501);
 await assert.rejects(()=>readHistoricalRoster(-1,db as any),/Invalid history shop/);
});
