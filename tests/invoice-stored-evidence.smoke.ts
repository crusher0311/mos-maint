import assert from "node:assert/strict";
import { reconcileStored } from "../scripts/invoice-stored-evidence";
const id="11111111-1111-1111-1111-111111111111";
const raw={ID:id,Type:"WorkOrder",WorkflowStage:"Invoice",InvoiceNumber:123,
  InvoiceTime:"2026-09-19T12:00:00Z",ServicePackages:{ItemCollection:[{
    ID:"22222222-2222-2222-2222-222222222222",Status:"Completed",IsInvoicing:true,
    ServicePackageLines:{ItemCollection:[{ID:"33333333-3333-3333-3333-333333333333",
      Type:"Labor",Quantity:2,Unit:"Hours",Price:100,Total:200}]}
  }]}};
const resolved=reconcileStored([id],[raw],[]);
assert.equal(resolved.reason,"verified_complete");
assert.equal(resolved.evidence?.sold,2);
assert.equal(reconcileStored([id],[raw,structuredClone(raw)],[resolved.evidence]).reason,"verified_complete");
assert.equal(reconcileStored([id],[],[]).reason,"no_matched_payload");
assert.equal(reconcileStored([],[],[]).reason,"missing_provider_identity");
assert.equal(reconcileStored([id],[{...raw,InvoiceNumber:0}],[]).reason,"missing_positive_invoice_number");
assert.equal(reconcileStored([id],[raw],[null]).reason,"conflicting_evidence");
assert.equal(reconcileStored([id],[{...raw,InvoiceNumber:0,InvoiceTime:"0001-01-01T00:00:00"}],[resolved.evidence]).reason,"conflicting_date");
const changed=structuredClone(raw);
changed.InvoiceNumber=0;
changed.ServicePackages.ItemCollection[0].ServicePackageLines.ItemCollection[0].Quantity=4;
// Explicit deferred collection lets legacy recorded-hour evidence act as a veto.
assert.equal(reconcileStored([id],[{...changed,DeferredServicePackages:[]}],[resolved.evidence]).reason,"conflicting_recorded_hours");
assert.equal(reconcileStored(["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],[raw],[]).reason,"conflicting_evidence");
console.log("PASS stored reconciliation: source completeness, identity/date/hour conflicts, no fabricated zero evidence");
