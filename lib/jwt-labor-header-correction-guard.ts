import assert from "node:assert/strict";
export function cents(value:unknown):number {
 assert.ok(typeof value==="number" || (typeof value==="string"&&value.trim()!==""),"Missing money");
 const n=Number(value);
 assert.ok(Number.isFinite(n)&&Math.abs(n*100-Math.round(n*100))<0.00001,"Invalid cents");
 return Math.round(n*100);
}
export function validateLaborHeaderSource(row:any,n:any,source:any){
 assert.equal(row.shop_id,227);
 assert.equal(row.work_order_number,n.wo);
 assert.ok(["closed","invoiced","paid"].includes(row.status));
 assert.ok(!row.soft_delete?.isDeleted);
 assert.equal(row.business_date,n.date);
 assert.ok(!row.recovery_digest,"Previously recovered invoice excluded");
 assert.ok(cents(row.labor_total)===0||cents(row.labor_total)===cents(n.labor),"Changed labor total");
 assert.equal(String(source?.WorkOrderNumber),n.wo);
 // These verified closed WorkOrder snapshots omit the invoice number as 0.
 // WO number + provider GUID + date + native amount remain mandatory below.
 // Never accept a conflicting nonzero invoice number or an Invoice payload
 // with an unavailable invoice number.
 assert.ok(String(source?.InvoiceNumber)===n.invoice ||
   (source?.Type==="WorkOrder"&&String(source?.InvoiceNumber)==="0"),"Invoice number conflict");
 assert.ok(["Invoice","WorkOrder"].includes(source?.Type));
 assert.equal(source?.WorkflowStage,"Invoice");
 assert.ok(source.Status==null||["Invoice","Invoiced","Paid","Closed"].includes(source.Status));
 assert.ok(Number.isFinite(Date.parse(source.InvoiceTime)));
 assert.equal(new Date(source.InvoiceTime).toISOString().slice(0,10),n.date);
 assert.ok(row.provenance?.sourceIds?.some((s:any)=>s.system==="protractor"&&
   String(s.idValue).toLowerCase()===String(source.ID).toLowerCase()),"Source GUID mismatch");
 assert.equal(cents(source?.Summary?.LaborTotal),cents(n.labor));
 assert.notEqual(cents(n.labor),0,"Zero native total is not a correction");
}
