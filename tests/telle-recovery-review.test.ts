import "./helpers/deny-network-egress";
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {cents,evidenceHash,reviewReference,validateReferences,type Reference,type Capture,
  type Retained} from "../scripts/lib/telle-recovery-review";
const now=Date.parse("2026-11-10T12:00:00Z"),at=new Date(now).toISOString();
const id="abcdef01-0000-4000-8000-000000000001";
const ref:Reference={invoiceNumber:"101000001",workOrderNumber:"100001",reportDate:"2026-07-01",
  expectedTotalCents:12345,reportType:"Invoice"};
function capture(patch:Record<string,any>={}):Capture{
  return {shopId:282,providerId:id,capturedAt:at,payload:{ID:id.toUpperCase(),InvoiceNumber:ref.invoiceNumber,
    WorkOrderNumber:ref.workOrderNumber,InvoiceTime:"2026-07-01T05:30:00Z",Type:"WorkOrder",
    WorkflowStage:"Invoice",Header:{LastModifiedTime:"2026-11-09T12:00:00Z"},
    Summary:{GrandTotal:"123.4500"},...patch}};
}
function prior(c= capture(),patch:Partial<Retained>={}):Retained{
  return {providerId:id,invoiceNumber:ref.invoiceNumber,workOrderNumber:ref.workOrderNumber,
    version:c.payload.Header.LastModifiedTime,bodyHash:evidenceHash(c.payload),...patch};
}
const reason=(c:Capture|undefined,r=ref,records:Retained[]=[])=>{
  const out=reviewReference(r,c,records,now);
  return "reason" in out?out.reason:out.status;
};
test("exact signed cents, zero credits and unknown amounts",()=>{
  assert.equal(cents("-59.8800"),-5988);assert.equal(cents("0.0000"),0);assert.equal(cents(123.45),12345);
  for(const value of [undefined,null,true,"1.001",NaN,Infinity,"1e3","9007199254740992"])
    assert.throws(()=>cents(value));
});
test("create/update/unchanged are metadata-only proposals with pinned before-images",()=>{
  const c=capture(),created=reviewReference(ref,c,[],now);
  assert.equal("proposedChange" in created&&created.proposedChange,"create");
  assert.equal(created.writeAuthorized,false);assert.equal(created.deliveryAuthorized,false);
  const same=reviewReference(ref,c,[prior()],now);
  assert.equal("proposedChange" in same&&same.proposedChange,"unchanged");
  const old=prior(c,{version:"2026-11-08T12:00:00Z",bodyHash:"a".repeat(64)});
  const updated=reviewReference(ref,c,[old],now);
  assert.equal("proposedChange" in updated&&updated.proposedChange,"update");
  assert.deepEqual("expectedBefore" in updated&&updated.expectedBefore,{version:old.version,bodyHash:old.bodyHash});
  assert.equal(JSON.stringify(created).includes("GrandTotal"),false);
});
test("newer writes, equal-version differences, duplicate stores and conflicting IDs hold",()=>{
  assert.equal(reason(capture(),ref,[prior(capture(),{version:at})]),"newer_record_exists");
  assert.equal(reason(capture(),ref,[prior(capture(),{bodyHash:"b".repeat(64)})]),"same_version_conflict");
  assert.equal(reason(capture(),ref,[prior(),prior()]),"multiple_existing_copies");
  assert.equal(reason(capture(),ref,[prior(capture(),{providerId:"abcdef02-0000-4000-8000-000000000001"})]),"conflicting_existing_identity");
});
test("credits preserve type/sign/relationships and never become service or delivery authority",()=>{
  for(const value of ["-59.88","0.00"]){
    const credit={...ref,reportType:"Credit Invoice" as const,expectedTotalCents:cents(value)};
    const c=capture({Type:"CreditSlip",Summary:{GrandTotal:value},InvoiceID:"original-invoice"});
    const before=JSON.stringify(c);
    const out=reviewReference(credit,c,[],now);
    assert.equal(out.status,"credit_review_required");
    assert.equal("serviceHistoryAuthorized" in out&&out.serviceHistoryAuthorized,false);
    assert.equal(out.deliveryAuthorized,false);assert.equal(JSON.stringify(c),before);
  }
  assert.equal(reason(capture({Type:"CreditSlip"})),"type_or_stage_mismatch");
  assert.equal(reason(capture(),{...ref,reportType:"Credit Invoice"}),"type_or_stage_mismatch");
});
test("identity, type, amount, timestamp and size violations hold without side effects",()=>{
  assert.equal(reason(undefined),"missing_capture");
  assert.equal(reason({...capture(),shopId:635}),"identity_or_shop_mismatch");
  assert.equal(reason(capture({ID:"wrong"})),"identity_or_shop_mismatch");
  assert.equal(reason(capture({InvoiceNumber:"other"})),"reference_mismatch");
  assert.equal(reason(capture({WorkflowStage:"ScheduledWork"})),"type_or_stage_mismatch");
  assert.equal(reason(capture({Summary:{GrandTotal:"123.46"}})),"amount_mismatch");
  assert.equal(reason(capture({Summary:{GrandTotal:"123.451"}})),"fractional_or_invalid_amount");
  assert.equal(reason(capture({InvoiceTime:"2026-07-01T05:30:00"})),"invalid_timestamp");
  assert.equal(reason(capture({Header:{}})),"invalid_timestamp");
  assert.equal(reason(capture({Note:"x".repeat(512*1024)})),"payload_too_large");
  assert.equal(reason({...capture(),capturedAt:"2026-11-10T11:00:00Z"}),"stale_or_future_evidence");
  assert.equal(reason({...capture(),capturedAt:"2026-11-10T13:00:00Z"}),"stale_or_future_evidence");
  assert.equal(reason(capture({InvoiceID:"other"})),"conflicting_invoice_identity");
  assert.equal(reason(capture({Payments:{ItemCollection:[{InvoiceID:"other"}]}})),"conflicting_payment_identity");
});
test("Chicago DST boundaries and unique work-order fallback are explicit",()=>{
  assert.equal(reason(capture({InvoiceTime:"2026-07-01T04:59:59Z"})),"date_mismatch");
  const winter={...ref,reportDate:"2026-01-02"};
  assert.equal(reason(capture({InvoiceTime:"2026-01-02T05:59:59Z"}),winter),"date_mismatch");
  assert.equal(reason(capture({InvoiceTime:"2026-01-02T06:00:00Z"}),winter),"reviewable");
  assert.equal(reason(capture({InvoiceNumber:"0"})),"reviewable");
  const ambiguous=reviewReference(ref,capture({InvoiceNumber:"0"}),[],now,false);
  assert.equal("reason" in ambiguous&&ambiguous.reason,"reference_mismatch");
});
test("reruns and object key ordering produce identical evidence hashes",()=>{
  assert.equal(evidenceHash({a:1,b:2}),evidenceHash({b:2,a:1}));
  assert.deepEqual(reviewReference(ref,capture(),[],now),reviewReference(ref,capture(),[],now));
});
test("scope pins reject arbitrary invoice sets and the CLI has no apply mode",()=>{
  assert.throws(()=>validateReferences([]),/count/);
  assert.throws(()=>validateReferences(Array.from({length:233},()=>ref)),/manifest/);
  const out=spawnSync(process.execPath,["--import","tsx","scripts/review-telle-recovery.ts","--apply"],{encoding:"utf8"});
  assert.equal(out.status,1);assert.match(out.stderr,/usage_verify_scope_or_review/);
});
