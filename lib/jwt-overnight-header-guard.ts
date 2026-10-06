import assert from "node:assert/strict";
import {cents} from "./jwt-labor-header-correction-guard";
/** Header-only repair: never rename, merge, delete, create or reparent an RO. */
export function verifyOvernightHeader(row:any, native:any, source:any, shopId:number) {
  assert.ok(shopId>=227&&shopId<=236&&Number.isInteger(shopId));
  assert.ok(!(shopId===227&&native.date.startsWith("2026-09")));
  assert.equal(row.shop_id,shopId);
  assert.equal(native.shopId,shopId);
  assert.match(source.ID,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  assert.equal(String(source.WorkOrderNumber),native.wo);
  assert.ok(String(source.InvoiceNumber)===native.invoice ||
    (source.Type==="WorkOrder"&&String(source.InvoiceNumber)==="0"));
  assert.ok(["WorkOrder","Invoice"].includes(source.Type));
  assert.equal(source.WorkflowStage,"Invoice");
  assert.ok(source.Status==null||["Invoice","Invoiced","Paid","Closed"].includes(source.Status));
  assert.equal(new Date(source.InvoiceTime).toISOString().slice(0,10),native.date);
  assert.equal(row.business_date,native.date);
  assert.ok(["closed","paid","invoiced"].includes(row.status));
  assert.ok(!row.soft_delete?.isDeleted);
  assert.equal(row.provenance?.sourceSystem,"protractor");
  assert.ok(row.provenance.sourceIds?.some((s:any)=>s.system==="protractor"&&
    String(s.idValue).toLowerCase()===source.ID.toLowerCase()));
  assert.ok(row.work_order_number===native.wo||
    row.work_order_number.toLowerCase()===source.ID.toLowerCase());
  assert.equal(cents(source.Summary?.LaborTotal),native.laborCents);
  assert.ok(cents(row.labor_total)===0||cents(row.labor_total)===native.laborCents);
  return native.laborCents/100;
}
