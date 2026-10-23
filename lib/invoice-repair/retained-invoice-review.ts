import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getAdapter } from "../integrations/core/normalized-adapter";
import { getProtractorPackageIdentity } from "../integrations/protractor/package-normalization";

/** Compatibility with the original read-only preparer's JSON evidence hash.
 * This is NOT a lossless native-row CAS token. */
export const reviewDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const providerId = "303b1f3b-46da-4936-b616-e84e7e96d714";
const targetId = "6ada5b24eaa5818c8a3b265a";
const sameId = (value: unknown) => String(value).toLowerCase() === providerId;
const instant = (value: unknown) => {
  assert.equal(typeof value, "string", "Explicit provider timestamp required");
  assert.match(value as string, /(?:Z|[+-]\d{2}:\d{2})$/);
  const parsed = Date.parse(value as string);
  assert.ok(Number.isFinite(parsed), "Invalid timestamp");
  return parsed;
};

/** Offline preparation only. Input target must be the original ordered
 * projection, not a whole-row object reconstructed with different key order.
 * Source is the retained protractor_work_orders document, never an export body.
 * No credentials, clients, ingestion service, or executable production entry. */
export function prepareRetainedInvoiceReview(plan: any, retained: any, target: any) {
  assert.equal(plan.mode, "review_only_no_writes");
  assert.equal(plan.shopId, 283);
  assert.equal(plan.workOrderNumber, 127591);
  assert.equal(plan.target.id, targetId);
  assert.equal(plan.source.collection, "protractor_work_orders");
  assert.ok(sameId(plan.source.providerId));
  assert.equal(String(retained.shopId), "283");
  assert.ok(sameId(retained.workOrderId));
  const raw = retained.rawPayload ?? retained.data;
  assert.ok(raw && sameId(raw.ID), "Retained source identity mismatch");
  assert.equal(String(raw.WorkOrderNumber), "127591");
  assert.equal(raw.WorkflowStage, "Invoice");
  assert.equal(plan.source.stage, "Invoice");
  assert.equal(reviewDigest(raw), plan.source.payloadSha256, "Source digest changed");
  assert.equal(target.id, plan.target.id);
  assert.equal(target.version, plan.target.version, "Target version changed");
  assert.equal(reviewDigest(target), plan.target.rowEvidenceSha256, "Target evidence changed");
  assert.equal(new Date(target.updated_at).toISOString(), plan.target.updatedAt);
  assert.equal(target.status, plan.target.stage);
  assert.ok(target.provenance?.sourceIds?.some((s: any) =>
    s.system === "protractor" && ["invoice_id", "work_order_id"].includes(s.idType) &&
    sameId(s.idValue)), "Canonical provenance mismatch");
  assert.equal(raw.Header?.LastModifiedTime, plan.source.providerModified);
  assert.equal(target.raw_data?.rawPayload?.Header?.LastModifiedTime, plan.target.providerModified);
  assert.ok(instant(raw.Header.LastModifiedTime) > instant(plan.target.providerModified),
    "Source must be newer than target");
  assert.equal(raw.InvoiceTime, plan.source.invoiceTime);
  instant(raw.InvoiceTime);
  assert.equal(Number(raw.Summary?.GrandTotal), 536.39);
  assert.equal(Number(plan.source.grandTotal), 536.39);
  const packages = raw.ServicePackages?.ItemCollection ?? raw.ServicePackages;
  assert.ok(Array.isArray(packages), "Full retained service-package collection required");

  const adapter = getAdapter("protractor");
  assert.ok(adapter, "Protractor normalized adapter unavailable");
  const mapped = adapter.mapWorkOrder(283, raw);
  assert.ok(["invoiced", "closed", "paid"].includes(String(mapped.status)));
  assert.equal(mapped.grandTotal, 536.39);
  assert.equal(mapped.closedDate?.getTime(), instant(raw.InvoiceTime));
  assert.equal(mapped.completedDate?.getTime(), instant(raw.InvoiceTime));
  const jobs = adapter.extractRawServiceJobsFromWorkOrder(raw);
  const entities = {
    vehicle: adapter.extractVehicleFromWorkOrder(raw),
    customer: adapter.extractCustomerFromWorkOrder(raw),
    jobs: jobs.map(job => ({
      providerJobId: getProtractorPackageIdentity(job),
      mapped: adapter.mapServiceJob(283, targetId, job),
      lines: adapter.extractLineItemsFromServiceJob(job).map(line => ({
        sourceId: line._sourceId,
        // Canonical job IDs must be resolved from the archived target graph;
        // the placeholder cannot be used as a database write document.
        mapped: adapter.mapLineItem(283, targetId, "REVIEW_ONLY_UNRESOLVED_JOB", line),
      })),
    })),
    payments: adapter.extractPaymentsFromWorkOrder(raw).map(p => adapter.mapPayment(283, targetId, p)),
    inspections: adapter.extractInspectionsFromWorkOrder(raw),
    recommendations: adapter.extractRecommendationsFromWorkOrder(raw),
  };
  return {
    mode: "review_only_no_writes",
    executionReady: false,
    productionRepairApproved: false,
    planDigest: reviewDigest(plan),
    sourceDigest: reviewDigest(raw),
    targetEvidenceDigest: reviewDigest(target),
    canonicalId: targetId,
    mapped,
    entities,
    counts: {
      jobs: entities.jobs.length,
      lines: entities.jobs.reduce((n, job) => n + job.lines.length, 0),
      payments: entities.payments.length,
      inspections: entities.inspections.length,
      recommendations: entities.recommendations.length,
    },
    blockers: [
      "Review native full-row before/after graph and canonical child identity matches.",
      "Verify deployed writer coverage, paired installation, holds and drained durable admissions.",
      "Approve maintenance execution separately, bound to exact plan, source and target evidence.",
      "Use maintenance exclusion across every write; this projection digest is not atomic CAS.",
      "Validate all persisted entities and retain the fence on partial or unknown outcomes.",
    ],
  };
}
