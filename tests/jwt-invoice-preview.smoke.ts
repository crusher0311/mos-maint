import assert from "node:assert/strict";
import { previewJwtInvoices, type InvoicePreviewDeps } from "../lib/jwt-invoice-preview";
import { recoveryEvidence } from "../lib/jwt-invoice-recovery-evidence";
import { captureApprovedRecoverySource } from "../lib/jwt-approved-recovery-source";
import native from "../docs/reporting/jwt-701-september-1-native-identities.json";

async function main() {
  let reads = 0, scopes = 0;
  const deps: InvoicePreviewDeps = {
    authorize: async () => ({}),
    enterprise: async () => ({ name: "JWT", shopIds: [227] }),
    relayMode: () => "relay",
    interactive: async work => { scopes++; return work(); },
    policy: async () => ({ allowed: true, callbackOnly: true, allowInteractive: true }),
    read: async () => { reads++; return { ok: true, data: { ItemCollection: [{
      WorkOrderNumber: "701008329", InvoiceNumber: "701006622", InvoiceTime: "2026-09-01T12:00:00",
      Type: "Invoice", Customer: "PRIVATE", VIN: "PRIVATE",
    }] } }; },
  };
  assert.equal((await previewJwtInvoices({...deps, authorize: async () => { throw Error(); }})).status, 401);
  assert.equal(scopes, 0);
  assert.equal((await previewJwtInvoices({...deps, enterprise: async () => ({name:"Other",shopIds:[227]})})).status,409);
  assert.equal((await previewJwtInvoices({...deps, relayMode: () => "direct"})).status,409);
  for (const policy of [
    {allowed:false}, {allowed:true,callbackOnly:true},
    {allowed:true,requireTimedTrial:true},
  ]) assert.equal((await previewJwtInvoices({...deps,policy:async()=>policy})).status,409);
  assert.equal(reads,0);
  const success = await previewJwtInvoices(deps);
  assert.equal(success.status,200);
  assert.equal(reads,1);
  assert.match(JSON.stringify(success.body), /absent_by_both_numbers/);
  assert.ok(!JSON.stringify(success.body).includes("PRIVATE"));
  for (const type of ["WorkOrder", "Invoice", "CreditInvoice", "Appointment", "unrecognized"]) {
    const run = (overrides: Record<string, unknown> = {}) => previewJwtInvoices({
      ...deps, read: async () => ({ok:true,data:{ItemCollection:[{
        WorkOrderNumber:"701008329", InvoiceNumber:"701006622",
        InvoiceTime:"2026-09-01T12:00:00", Type:type, ...overrides,
      }]}}),
    });
    const matched = await run();
    assert.match(JSON.stringify(matched.body), /Native identity and date matched/);
    assert.match(JSON.stringify(matched.body), /Closure not verified/);
    for (const change of [
      {InvoiceNumber:"999"}, {WorkOrderNumber:"999"},
      {InvoiceTime:"2026-09-02T12:00:00"}, {InvoiceTime:null},
    ]) {
      const unmatched = await run(change);
      assert.match(JSON.stringify(unmatched.body), /Unverified: identity or date/);
      assert.doesNotMatch(JSON.stringify(unmatched.body), /Native identity and date matched/);
    }
  }
  const oversized = await previewJwtInvoices({...deps,read:async()=>({ok:true,data:{ItemCollection:Array(26).fill({})}})});
  assert.equal(oversized.status,502);
  const failed = await previewJwtInvoices({...deps,read:async()=>({ok:false,error:"SECRET PROVIDER RESPONSE"})});
  assert.equal(failed.status,503);
  assert.ok(!JSON.stringify(failed.body).includes("SECRET"));
  console.log("JWT authenticated invoice preview: ALL PASS");
  const source = {Type:"WorkOrder", WorkflowStage:"Closed", Status:"Closed", InvoiceTime:"2026-09-01T12:00:00"};
  const row = {id:"test",work_order_number:"1",status:"work_complete",business_date:null,deleted:false};
  assert.match(recoveryEvidence(source,"1","2",true,[]).proposedAction,/Candidate insert/);
  assert.match(recoveryEvidence(source,"1","2",true,[row]).proposedAction,/Candidate header update/);
  const observedSource = {...source,WorkflowStage:"Invoice",Status:null};
  assert.match(recoveryEvidence(observedSource,"1","2",true,[]).proposedAction,/Candidate insert/);
  assert.match(recoveryEvidence(observedSource,"1","2",true,[row]).proposedAction,/status closed,/);
  assert.match(recoveryEvidence({...observedSource,Status:"WorkInProgress"},"1","2",true,[row]).proposedAction,/Hold/);
  assert.match(recoveryEvidence(source,"1","2",true,[{...row,status:"paid",business_date:"2026-09-01"}]).proposedAction,/No header recovery/);
  for (const records of [[{...row,deleted:true}],[row,row],[{...row,work_order_number:"2"}]])
    assert.match(recoveryEvidence(source,"1","2",true,records).proposedAction,/Hold/);
  assert.match(recoveryEvidence(source,"1","2",true,null).proposedAction,/unavailable/);
  assert.match(recoveryEvidence(source,"1","2",false,[]).proposedAction,/Hold/);
  for (const change of [{Type:"CreditInvoice"},{Type:"unknown"},{WorkflowStage:"WorkCompleted"},{Status:"WorkInProgress"},{InvoiceTime:"2026-09-01T99:00:00"}])
    assert.match(recoveryEvidence({...source,...change},"1","2",true,[]).proposedAction,/Hold/);
  const failedStored = await previewJwtInvoices({...deps, stored:async()=>{throw Error("PRIVATE");}});
  assert.match(JSON.stringify(failedStored.body),/database evidence unavailable/);
  assert.ok(!JSON.stringify(failedStored.body).includes("PRIVATE"));
  console.log("JWT recovery evidence dry run: ALL PASS");
  const full = native.map((n,i)=>({
    ID:`00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`,
    Type:"WorkOrder",WorkflowStage:"Invoice",Status:null,
    WorkOrderNumber:n.wo,InvoiceNumber:n.invoice,
    InvoiceTime:"2026-09-01T12:00:00-04:00",ServicePackages:{ItemCollection:[]},
  }));
  const bundle=captureApprovedRecoverySource(full);
  assert.equal(bundle.invoices.length,21);
  assert.ok(!bundle.invoices.some(r=>r.WorkOrderNumber==="701008320"));
  const first = bundle.invoices[0];
  for (const patch of [
    {ID:"invalid"},{WorkflowStage:"WorkInProgress"},{Status:"Voided"},
    {InvoiceTime:"0001-01-01T00:00:00"},{ServicePackages:null},
    {Type:"CreditInvoice"},{InvoiceNumber:"999"},
  ]) assert.throws(()=>captureApprovedRecoverySource(full.map(r=>r.ID===first.ID?{...r,...patch}:r)));
  assert.throws(()=>captureApprovedRecoverySource(full.filter(r=>r.ID!==first.ID)));
  assert.throws(()=>captureApprovedRecoverySource([...full,first]));
  assert.throws(()=>captureApprovedRecoverySource(Array(26).fill(first)));
  console.log("JWT approved source capture: ALL PASS (no writes)");
}
main().catch(e=>{console.error(e);process.exit(1);});
