import assert from "node:assert/strict";
import {verifyOvernightHeader} from "../lib/jwt-overnight-header-guard";
const id="ce321e56-bf5d-4653-a428-1c47ece1a9fc";
const n={shopId:228,wo:"7021001",invoice:"702999",date:"2026-08-01",laborCents:-750};
const source={ID:id,WorkOrderNumber:n.wo,InvoiceNumber:n.invoice,Type:"Invoice",WorkflowStage:"Invoice",
 InvoiceTime:"2026-08-01T12:00:00Z",Summary:{LaborTotal:-7.5}};
const row={shop_id:228,work_order_number:id,business_date:n.date,status:"closed",labor_total:0,
 provenance:{sourceSystem:"protractor",sourceIds:[{system:"protractor",idValue:id}]}};
assert.equal(verifyOvernightHeader(row,n,source,228),-7.5);
assert.equal(verifyOvernightHeader({...row,work_order_number:n.wo},n,source,228),-7.5);
for(const patch of [{work_order_number:"other"},{status:"draft"},{shop_id:229},{labor_total:5},
 {business_date:"2026-08-02"},{soft_delete:{isDeleted:true}},{provenance:{sourceSystem:"protractor",sourceIds:[]}}])
 assert.throws(()=>verifyOvernightHeader({...row,...patch},n,source,228));
for(const patch of [{ID:"bad"},{InvoiceNumber:"other"},{Type:"CreditInvoice"},{WorkflowStage:"Estimate"},
 {InvoiceTime:"2026-08-02T12:00:00Z"},{Summary:{}},{Summary:{LaborTotal:0}}])
 assert.throws(()=>verifyOvernightHeader(row,n,{...source,...patch},228));
assert.throws(()=>verifyOvernightHeader({...row,shop_id:227},{...n,shopId:227,date:"2026-09-01"},source,227));
console.log("JWT GUID header guard: legacy/numeric identities, signed amounts, protected scope and conflict rejection passed");
