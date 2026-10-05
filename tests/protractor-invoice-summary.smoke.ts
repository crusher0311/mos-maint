import assert from "node:assert/strict";
import { getAdapter } from "../lib/integrations/core/normalized-adapter";

const adapter = getAdapter("protractor");
assert.ok(adapter);
const base = { ID:"invoice", WorkOrderNumber:123, WorkflowStage:"Invoice",
  InvoiceTime:"2026-09-01T12:00:00-04:00" };
const mapped = adapter.mapWorkOrder(227, {...base, Summary:{
  NetTotal:148.99, LaborTotal:100, PartsTotal:48.99, SubletTotal:0,
  OtherChargeTotal:4.5, TaxTotal:1.26, GrandTotal:154.75,
}, DiscountTotal:10, LaborTotal:999});
assert.equal(mapped.status,"closed");
assert.equal(mapped.laborTotal,100,"Summary net labor must not lose discounts twice");
assert.equal(mapped.subtotal,148.99);
assert.equal(mapped.partsTotal,48.99);
assert.equal(mapped.feesTotal,4.5);
assert.equal(mapped.taxTotal,1.26);
assert.equal(mapped.grandTotal,154.75);
assert.equal(adapter.mapWorkOrder(227,{...base,Summary:{LaborTotal:0},LaborTotal:99}).laborTotal,0);
assert.equal(adapter.mapWorkOrder(227,{...base,Summary:{LaborTotal:-10}}).laborTotal,-10);
assert.equal(adapter.mapWorkOrder(227,{...base,LaborTotal:20,GrandTotal:30}).grandTotal,30);
assert.equal(adapter.mapWorkOrder(227,{...base,LaborTotal:20}).laborTotal,20);
assert.equal(adapter.mapWorkOrder(227,{...base,Summary:{GrandTotal:0},GrandTotal:99}).grandTotal,0);
assert.equal(adapter.mapWorkOrder(227,{...base,Summary:{GrandTotal:-10}}).grandTotal,-10);
console.log("Protractor invoice Summary mapping: PASS");
const customer=adapter.mapCustomer(227,{Contact:{Name:{FirstName:"Test",LastName:"Customer"},FileAs:"Customer, Test"}});
assert.equal(customer.firstName,"Test");
assert.equal(customer.lastName,"Customer");
assert.equal(customer.fullName,"Test Customer");
assert.equal(adapter.mapCustomer(227,{FirstName:"Legacy",LastName:"Customer"}).fullName,"Legacy Customer");
