import assert from "node:assert/strict";
import { prepareRetainedInvoiceReview, reviewDigest } from "../lib/invoice-repair/retained-invoice-review";

// Synthetic data only. Never substitute this fixture for retained production evidence.
const id = "303b1f3b-46da-4936-b616-e84e7e96d714";
function fixture() {
  const raw = {
    ID: id, WorkOrderNumber: 127591, WorkflowStage: "Invoice",
    Header: { LastModifiedTime: "2026-10-22T16:49:58.31-04:00" },
    InvoiceTime: "2026-10-22T16:49:58.463-04:00",
    Summary: { GrandTotal: 536.39, NetTotal: 500, TaxTotal: 36.39 },
    ServicePackages: { ItemCollection: [] },
  };
  const target = {
    id: "6ada5b24eaa5818c8a3b265a", version: 3,
    updated_at: "2026-10-22T21:15:39.325Z",
    provenance: { sourceIds: [{ system: "protractor", idType: "invoice_id", idValue: id.toUpperCase() }] },
    raw_data: { rawPayload: { Header: { LastModifiedTime: "2026-10-22T15:46:41.223-04:00" } } },
    status: "inspection_in_progress", closed_date: null, completed_date: null,
  };
  const plan = {
    mode: "review_only_no_writes", shopId: 283, workOrderNumber: 127591,
    target: { id: target.id, version: 3, updatedAt: target.updated_at,
      rowEvidenceSha256: reviewDigest(target), stage: target.status,
      providerModified: target.raw_data.rawPayload.Header.LastModifiedTime },
    source: { collection: "protractor_work_orders", providerId: id, payloadSha256: reviewDigest(raw),
      stage: "Invoice", providerModified: raw.Header.LastModifiedTime,
      invoiceTime: raw.InvoiceTime, grandTotal: 536.39 },
  };
  return { plan, retained: { shopId: 283, workOrderId: id, rawPayload: raw }, target };
}
const run = (f: ReturnType<typeof fixture>) => prepareRetainedInvoiceReview(f.plan, f.retained, f.target);
const result = run(fixture());
assert.equal(result.executionReady, false);
assert.equal(result.mapped.grandTotal, 536.39);
assert.equal(result.mapped.closedDate?.toISOString(), "2026-10-22T20:49:58.463Z");
assert.equal(result.canonicalId, fixture().target.id);
const graph = fixture();
const raw: any = graph.retained.rawPayload;
raw.ServicePackages.ItemCollection = [{
  ID: "job-1", Name: "Synthetic job",
  ServicePackageLines: { ItemCollection: [{ ID: "line-1", Type: "Labor", Description: "Synthetic labor", Hours: 1 }] },
}];
raw.Payments = { ItemCollection: [{ ID: "payment-1", Amount: 536.39 }] };
raw.Inspections = [{ ID: "inspection-1" }];
raw.Recommendations = { ItemCollection: [{ ID: "recommendation-1" }] };
graph.plan.source.payloadSha256 = reviewDigest(raw);
const graphReview = run(graph);
assert.deepEqual(graphReview.counts, { jobs: 1, lines: 1, payments: 1, inspections: 1, recommendations: 1 });
assert.equal(graphReview.entities.jobs[0].providerJobId, "job-1");
assert.equal(graphReview.entities.jobs[0].lines[0].sourceId, "line-1");
assert.equal(graphReview.entities.jobs[0].mapped.workOrderId, result.canonicalId);
assert.equal(graphReview.entities.payments[0].workOrderId, result.canonicalId);
for (const mutate of [
  (f: any) => f.target.version++,
  (f: any) => f.target.raw_data.unreviewed = true,
  (f: any) => f.retained.rawPayload.Summary.GrandTotal = 1,
  (f: any) => f.retained.rawPayload.ServicePackages.ItemCollection.push({ ID: "new" }),
  (f: any) => f.retained.shopId = 284,
  (f: any) => f.retained.workOrderId = "wrong",
  (f: any) => f.plan.target.id = "replacement",
  (f: any) => f.plan.source.collection = "webhook_events",
  (f: any) => f.plan.source.invoiceTime = "2026-10-23T00:00:00Z",
  (f: any) => {
    delete f.retained.rawPayload.ServicePackages;
    f.plan.source.payloadSha256 = reviewDigest(f.retained.rawPayload);
  },
  (f: any) => {
    f.plan.source.providerModified = f.retained.rawPayload.Header.LastModifiedTime = f.plan.target.providerModified;
    f.plan.source.payloadSha256 = reviewDigest(f.retained.rawPayload);
  },
]) {
  const f = fixture();
  mutate(f);
  assert.throws(() => run(f));
}
console.log("Retained invoice review: identity, drift, completeness, dates and totals checks passed.");
