import assert from "node:assert/strict";
import {reviewInvoiceDate,reviewInvoiceChronology} from "../scripts/invoice-date-review";
const id="11111111-1111-1111-1111-111111111111";
const raw={ID:id,Type:"WorkOrder",WorkflowStage:"Invoice",InvoiceNumber:0,InvoiceTime:"2026-08-01T12:00:00-04:00"};
const check=(raws:any[])=>reviewInvoiceDate([id],raws);
assert.deepEqual(check([raw]),{classification:"consistent_final_invoice_date",date:"2026-08-01T16:00:00.000Z"});
assert.equal(check([raw,{...raw,InvoiceNumber:123}]).classification,"consistent_final_invoice_date");
assert.equal(check([raw,{...raw,InvoiceTime:"2026-10-01T12:00:00Z"}]).classification,"date_conflict");
assert.equal(check([{...raw,InvoiceTime:"0001-01-01T00:00:00"}]).classification,"date_unverified");
assert.equal(check([{...raw,InvoiceTime:"2026-02-30T00:00:00"}]).classification,"date_unverified");
assert.equal(check([{...raw,WorkflowStage:"ScheduledWork"}]).classification,"finality_unverified");
assert.equal(check([{...raw,Type:"CreditSlip"}]).classification,"finality_unverified");
assert.equal(check([{...raw,InvoiceNumber:undefined}]).classification,"number_unverified");
assert.equal(check([{...raw,ID:"wrong"}]).classification,"identity_conflict");
assert.equal(check([]).classification,"missing_source");
console.log("PASS date-scope hypothesis: identity, actual invoice date, explicit zero, no fallback dates");
const final={...raw,Header:{LastModifiedTime:"2026-08-01T16:00:00Z"}};
const old={...raw,WorkflowStage:"ScheduledWork",InvoiceTime:"0001-01-01T00:00:00",Header:{LastModifiedTime:"2026-08-01T15:00:00Z"}};
const chrono=(xs:any[])=>reviewInvoiceChronology([id],xs).classification;
assert.equal(chrono([old,final]),"consistent_final_invoice_date");
for(const changed of [
  {...old,ID:"22222222-2222-2222-2222-222222222222"},
  {...old,Header:{LastModifiedTime:"2026-08-01T16:00:00Z"}},
  {...old,Header:{LastModifiedTime:"2026-08-01T17:00:00Z"}},
  {...old,Header:{}},
  {...old,Header:{LastModifiedTime:"2026-08-01T15:00:00"}},
  {...old,InvoiceTime:"2026-07-01T15:00:00Z"},
  {...old,Type:"CreditSlip"},
  {...old,InvoiceNumber:123},
])assert.equal(chrono([changed,final]),"chronology_unverified");
assert.equal(chrono([old,final,{...final,InvoiceTime:"2026-10-01T12:00:00Z"}]),"date_conflict");
console.log("PASS chronology: identity, strict ordering, timezone, dates and credit vetoes");
