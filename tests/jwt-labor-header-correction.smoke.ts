import assert from "node:assert/strict";
import {cents,validateLaborHeaderSource} from "../lib/jwt-labor-header-correction-guard";
const n={wo:"701000001",invoice:"701100001",date:"2026-09-15",labor:"12.34"};
const row={shop_id:227,work_order_number:n.wo,status:"closed",labor_total:0,business_date:n.date,
 provenance:{sourceIds:[{system:"protractor",idValue:"source-id"}]}};
const source={ID:"source-id",WorkOrderNumber:n.wo,InvoiceNumber:n.invoice,InvoiceTime:"2026-09-15T12:00:00Z",
 Type:"WorkOrder",WorkflowStage:"Invoice",Summary:{LaborTotal:12.34}};
validateLaborHeaderSource(row,n,source);
validateLaborHeaderSource({...row,labor_total:12.34},n,source);
validateLaborHeaderSource(row,n,{...source,InvoiceNumber:0});
assert.throws(()=>validateLaborHeaderSource(row,n,{...source,InvoiceNumber:0,ID:"wrong"}));
assert.throws(()=>validateLaborHeaderSource(row,n,{...source,InvoiceNumber:0,Type:"Invoice"}));
validateLaborHeaderSource(row,{...n,labor:"-15.00"},{...source,Summary:{LaborTotal:-15}});
assert.throws(()=>validateLaborHeaderSource(row,{...n,labor:"-15.00"},{...source,Summary:{LaborTotal:15}}));
for(const patch of [{shop_id:228},{status:"draft"},{labor_total:1},{soft_delete:{isDeleted:true}},
 {business_date:"2026-09-16"},{recovery_digest:"already-recovered"},{provenance:{sourceIds:[]}}])
 assert.throws(()=>validateLaborHeaderSource({...row,...patch},n,source));
for(const patch of [{ID:"different"},{InvoiceNumber:"wrong"},{WorkOrderNumber:"wrong"},
 {WorkflowStage:"WorkOrder"},{Type:"CreditInvoice"},{Status:"Void"},
 {InvoiceTime:"2026-09-15T23:59:00-05:00"},{Summary:{}},{Summary:{LaborTotal:1234}}])
 assert.throws(()=>validateLaborHeaderSource(row,n,{...source,...patch}));
for(const value of [null,undefined,"",true,NaN,Infinity,12.345])assert.throws(()=>cents(value));
assert.equal(cents("12.34"),1234);
console.log("Fixed-scope labor header identity, dates, units, concurrency-state and missing-value guards: PASS");
