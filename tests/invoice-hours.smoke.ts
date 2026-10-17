import assert from "node:assert/strict";
import { aggregateInvoiceHours, invoiceHoursEvidence, type InvoiceHoursFact } from "../lib/invoice-hours-contract";
import { compileReportDefinition, executeReportDefinition } from "../lib/report-definition-compiler";
import { INVOICE_HOURS_SQL } from "../lib/invoice-hours-query";
import { invoiceHoursDisplay } from "../lib/invoice-hours-display";
import { PROTRACTOR_UNINVOICED_STATUSES } from "../lib/invoice-status-policy";

const start = new Date("2026-09-01T00:00:00Z"), end = new Date("2026-09-30T23:59:59.999Z");
const id = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12,"0")}`;
const raw = (n: number, sold = 2, declined = 1): any => ({
  ID: id(n), Type: "Invoice", WorkflowStage: "Invoice", InvoiceNumber: n + 1,
  InvoiceTime: "2026-09-02T12:00:00Z", ServicePackages: [
    { ID: "sold", Status: "Completed", IsInvoicing: true, ServicePackageLines: [{ ID: "line", Type: "Labor", BilledHours: sold }] },
  ], DeferredServicePackages: [{ ID: "declined", Status: "Deferred", ServicePackageLines: [{ Type: "Labor", Hours: declined }] }],
});
const fact = (n: number, shop = 1, payload = raw(n)): InvoiceHoursFact => ({
  id: `normalized-${n}`, shop_id: shop, provider: "protractor", status: "invoiced",
  source_ids: [{ system: "protractor", idType: "invoice_id", idValue: id(n) }],
  invoice_evidence: invoiceHoursEvidence(payload),
});
const aggregate = (rows: InvoiceHoursFact[]) => aggregateInvoiceHours(rows, start, end);
for(const status of PROTRACTOR_UNINVOICED_STATUSES) {
  assert.equal(aggregate([{...fact(1),status,invoice_evidence:null}]).summary.invoicePopulationUnknown,0);
  assert.equal(aggregate([{...fact(1),status}]).summary.invoiceCount,1,"verified invoice overrides a stale stage");
  assert.equal(aggregate([{...fact(1),provider:"unsupported",status,invoice_evidence:null}]).summary.invoicePopulationUnknown,1);
}
for(const status of ["closed","paid","invoiced","unrecognized"]) {
  assert.equal(aggregate([{...fact(1),status,invoice_evidence:null}]).summary.invoicePopulationUnknown,1);
}
const hundred = Array.from({ length: 100 }, (_, n) => fact(n));
assert.equal(aggregate(hundred).summary.averagePresentedHoursPerInvoice, 3);
assert.equal(aggregate(hundred).summary.averageSoldHoursPerInvoice, 2);
const uneven = [...hundred, fact(101, 2, raw(101, 100, 100))];
assert.equal(aggregate(uneven).summary.averageSoldHoursPerInvoice, 300 / 101);
assert.equal(aggregate(uneven).summary.averagePresentedHoursPerInvoice, 500 / 101);
assert.equal(aggregate([fact(1), { ...fact(1), id: "duplicate-normalized" }]).summary.invoiceCount, 1);
const conflict = fact(1, 1, raw(1, 5));
assert.equal(aggregate([fact(1), conflict]).summary.averageSoldHoursPerInvoice, null);
assert.equal(aggregate([fact(1), conflict]).summary.invoiceCount, 1);
const differentDate = fact(1, 1, { ...raw(1), InvoiceTime: "2026-08-01T00:00:00Z" });
assert.equal(aggregate([fact(1), differentDate]).summary.invoicePopulationUnknown, 1);
assert.equal(aggregate([fact(1, 1, { ...raw(1), InvoiceTime: "2026-10-01T00:00:00Z" })]).summary.invoiceCount, 0);
assert.equal(aggregate([fact(1, 1, raw(1, 0, 0))]).summary.averageSoldHoursPerInvoice, 0);
assert.equal(aggregate([]).summary.averageSoldHoursPerInvoice, null);
assert.equal(aggregate([]).summary.invoiceCount, 0);
const noDeclined = fact(1, 1, { ...raw(1), DeferredServicePackages: null });
const omittedDeferred = raw(1);
delete omittedDeferred.DeferredServicePackages;
assert.equal(invoiceHoursEvidence(omittedDeferred)?.presented, 2, "confirmed omission on a verified invoice means no deferred jobs");
assert.equal(aggregate([fact(1,1,omittedDeferred)]).summary.averagePresentedHoursPerInvoice,2);
for (const value of [null, undefined, {}, "missing"]) {
  assert.equal(invoiceHoursEvidence({...omittedDeferred,DeferredServicePackages:value})?.presented,null,
    "an explicit invalid deferred collection is not confirmed absence");
}
assert.equal(invoiceHoursEvidence({...omittedDeferred,ServicePackages:null})?.presented,null);
assert.equal(invoiceHoursEvidence({...omittedDeferred,WorkflowStage:"Estimate"}),null);
assert.equal(invoiceHoursEvidence({...omittedDeferred,InvoiceNumber:0}),null);
assert.equal(invoiceHoursEvidence({...omittedDeferred,InvoiceTime:undefined}),null);
assert.equal(invoiceHoursEvidence({...omittedDeferred,ID:"invalid"}),null);
const omittedMissingHours=structuredClone(omittedDeferred);
delete omittedMissingHours.ServicePackages[0].ServicePackageLines[0].BilledHours;
assert.equal(invoiceHoursEvidence(omittedMissingHours)?.presented,null,"missing labor hours are not zero");
const omittedMissingDisposition=structuredClone(omittedDeferred);
delete omittedMissingDisposition.ServicePackages[0].IsInvoicing;
assert.equal(invoiceHoursEvidence(omittedMissingDisposition)?.presented,null);
const omittedWithRegularDecline=structuredClone(omittedDeferred);
omittedWithRegularDecline.ServicePackages.push(raw(1).DeferredServicePackages[0]);
assert.equal(invoiceHoursEvidence(omittedWithRegularDecline)?.presented,3,"declined work in regular packages still counts");
assert.equal(aggregate([noDeclined]).summary.averageSoldHoursPerInvoice, 2);
assert.equal(aggregate([noDeclined]).summary.averagePresentedHoursPerInvoice, null);
assert.equal(aggregate([noDeclined]).summary.invoicePresentedCovered, 0);
assert.equal(aggregate([{ ...fact(1), invoice_evidence: { ...fact(1).invoice_evidence!, sold: null, presented: 3 } }]).summary.averagePresentedHoursPerInvoice, 3);
assert.equal(invoiceHoursDisplay("averageSoldHoursPerInvoice", { invoiceCount: 100, invoiceSoldCovered: 100, invoicePopulationUnknown: 0, averageSoldHoursPerInvoice: 2 }), "2.00 hours / invoice");
assert.match(invoiceHoursDisplay("averageSoldHoursPerInvoice", { invoiceCount: 100, invoiceSoldCovered: 50, invoicePopulationUnknown: 0, averageSoldHoursPerInvoice: null })!, /Incomplete data \(50\/100/);
const missingSold = raw(1);
delete missingSold.ServicePackages[0].ServicePackageLines[0].BilledHours;
missingSold.ServicePackages[0].ServicePackageLines[0].EstimatedHours = 50;
assert.equal(invoiceHoursEvidence(missingSold)?.sold, null, "estimated hours are not invoiced labor");
assert.equal(aggregate([fact(1, 1, missingSold)]).summary.invoiceSoldCovered, 0);
const duplicatePackages = raw(1);
duplicatePackages.ServicePackages.push(duplicatePackages.ServicePackages[0], duplicatePackages.DeferredServicePackages[0]);
assert.equal(invoiceHoursEvidence(duplicatePackages)?.sold, 2);
assert.equal(invoiceHoursEvidence(duplicatePackages)?.presented, 3);
const duplicateLines = raw(1);
duplicateLines.ServicePackages[0].ServicePackageLines.push(duplicateLines.ServicePackages[0].ServicePackageLines[0]);
assert.equal(invoiceHoursEvidence(duplicateLines)?.sold, 2);
// Contradictions must be detected before canonical package merging overwrites
// one copy. Both source orderings and both collection shapes are supported.
for (const reverse of [false, true]) {
  const conflictingCopies = raw(1);
  const other = structuredClone(conflictingCopies.ServicePackages[0]);
  other.ServicePackageLines[0].BilledHours = 7;
  conflictingCopies.ServicePackages.push(other);
  if (reverse) conflictingCopies.ServicePackages.reverse();
  conflictingCopies.ServicePackages = { ItemCollection: conflictingCopies.ServicePackages };
  const evidence = invoiceHoursEvidence(conflictingCopies);
  assert.equal(evidence?.sold, null, "same package/line IDs with conflicting hours are not covered");
  assert.equal(evidence?.presented, null);
  const summary = aggregate([fact(1, 1, conflictingCopies)]).summary;
  assert.equal(summary.invoiceCount, 1, "conflicts do not remove the eligible invoice");
  assert.equal(summary.invoiceSoldCovered, 0);
  assert.equal(summary.invoicePresentedCovered, 0);
  assert.equal(summary.averageSoldHoursPerInvoice, null);
  assert.equal(summary.averagePresentedHoursPerInvoice, null);
}
const conflictingDeferredTwin = raw(1);
const deferredTwin = structuredClone(conflictingDeferredTwin.DeferredServicePackages[0]);
deferredTwin.ServicePackageLines[0].Hours = 4;
conflictingDeferredTwin.ServicePackages.push(deferredTwin);
assert.equal(invoiceHoursEvidence(conflictingDeferredTwin)?.sold, 2, "declined-only conflicts leave sold coverage intact");
assert.equal(invoiceHoursEvidence(conflictingDeferredTwin)?.presented, null);
const conflictingPackageTotals = raw(1);
conflictingPackageTotals.ServicePackages[0].BilledHours = 2;
conflictingPackageTotals.ServicePackages.push({ ...conflictingPackageTotals.ServicePackages[0], BilledHours: 3 });
assert.equal(invoiceHoursEvidence(conflictingPackageTotals)?.sold, null);
const richAndThin = raw(1);
richAndThin.ServicePackages.push({ ID: "sold", IsInvoicing: true });
assert.equal(invoiceHoursEvidence(richAndThin)?.sold, 2, "missing fields can still be enriched by a matching rich copy");
const noPackageId = raw(1);
delete noPackageId.DeferredServicePackages[0].ID;
assert.equal(invoiceHoursEvidence(noPackageId)?.sold, 2);
assert.equal(invoiceHoursEvidence(noPackageId)?.presented, null);
for (const patch of [
  { InvoiceTime: "0001-01-01T00:00:00" }, { InvoiceTime: undefined },
  { InvoiceTime: "2026-02-30T00:00:00Z" },
  { InvoiceTime: "bad", ClosedDate: "2026-09-02" }, { InvoiceNumber: 0 },
  { Type: "CreditInvoice" }, { WorkflowStage: "Open" }, { ID: "not-an-invoice" },
]) assert.equal(invoiceHoursEvidence({ ...raw(1), ...patch }), null);
assert.equal(invoiceHoursEvidence({ ...raw(1), InvoiceTime: "2026-09-30T23:00:00-05:00" })?.date, "2026-10-01T04:00:00.000Z");
assert.equal(invoiceHoursEvidence({ ...raw(1), InvoiceTime: "2026-09-01T00:00:00" })?.date, "2026-09-01T00:00:00.000Z");
const open = { ...fact(1), status: "open", invoice_evidence: null };
assert.equal(aggregate([open]).summary.invoiceCount, 0);
assert.equal(aggregate([open]).summary.invoicePopulationUnknown, 0);
const unsupported = { ...fact(1), provider: "tekmetric" };
assert.equal(aggregate([unsupported]).summary.invoicePopulationUnknown, 1);
assert.equal(aggregate([unsupported]).summary.averageSoldHoursPerInvoice, null);
const terminalMissing = { ...fact(1), invoice_evidence: null };
for (const reverse of [false, true]) {
  const verified = fact(1);
  const missing = { ...terminalMissing, id: "missing-copy" };
  const mixed = [
    verified, missing,
    ...["tekmetric", "shopware", "protractor"].flatMap(provider => ["open", "estimate", "in_progress", "work_in_progress"].map(status =>
      ({ ...fact(9), id: `${provider}-${status}`, provider, status, invoice_evidence: null }))),
  ];
  if (reverse) mixed.reverse();
  const value = aggregate(mixed).summary;
  assert.equal(value.invoiceCount, 1);
  assert.equal(value.invoicePopulationUnknown, 0);
  assert.equal(value.averageSoldHoursPerInvoice, 2);
  assert.equal(value.averagePresentedHoursPerInvoice, 3);
  assert.equal(value.invoiceSoldCovered, 1);
  assert.equal(value.invoicePresentedCovered, 1);
  const outOfRange = aggregateInvoiceHours(mixed, new Date("2026-08-01"), new Date("2026-08-31T23:59:59Z")).summary;
  assert.equal(outOfRange.invoiceCount, 0);
  assert.equal(outOfRange.invoicePopulationUnknown, 0, "resolved duplicate cannot poison other periods");
  for (const conflictRow of [differentDate, conflict]) {
    const contradictory = [verified, missing, conflictRow];
    if (reverse) contradictory.reverse();
    const withConflict = aggregate(contradictory).summary;
    assert.equal(withConflict.averageSoldHoursPerInvoice, null);
    assert.equal(withConflict.averagePresentedHoursPerInvoice, null);
    assert.equal(withConflict.invoicePopulationUnknown, conflictRow === differentDate ? 1 : 0);
    assert.equal(withConflict.invoiceCount, conflictRow === differentDate ? 0 : 1);
  }
  const recovered = [missing, { ...missing, id: "recoverable", cached_source: { shopId: 1, rawPayload: raw(1) } }];
  assert.equal(aggregate(reverse ? recovered.reverse() : recovered).summary.invoicePopulationUnknown, 0);
}
assert.equal(aggregate([fact(1), { ...terminalMissing, shop_id: 2 }]).summary.invoicePopulationUnknown, 1, "identities never reconcile across shops");
assert.equal(aggregate([fact(1), {
  ...terminalMissing, provider: "tekmetric", source_ids: [{ system: "tekmetric", idType: "invoice_id", idValue: id(1) }],
}]).summary.invoicePopulationUnknown, 1, "identities never reconcile across providers");
assert.equal(aggregate([fact(1), { ...terminalMissing, source_ids: [] }]).summary.invoicePopulationUnknown, 1, "no guessed identity match");
const uppercaseEvidence = fact(1);
uppercaseEvidence.invoice_evidence = { ...uppercaseEvidence.invoice_evidence!, id: uppercaseEvidence.invoice_evidence!.id.toUpperCase() };
assert.equal(aggregate([uppercaseEvidence, terminalMissing]).summary.invoicePopulationUnknown, 0);
assert.equal(aggregate([terminalMissing]).summary.invoicePopulationUnknown, 1);
assert.equal(aggregate([terminalMissing, fact(2)]).summary.averageSoldHoursPerInvoice, null);
assert.equal(aggregate([{ ...terminalMissing, cached_source: { shopId: 1, rawPayload: raw(1) } }]).summary.invoiceCount, 1);
assert.equal(aggregate([{ ...terminalMissing, cached_source: { shopId: 2, rawPayload: raw(1) } }]).summary.invoiceCount, 0);
assert.equal(aggregate([{ ...terminalMissing, cached_source: { shopId: 1, rawPayload: raw(2) } }]).summary.invoiceCount, 0);
assert.doesNotMatch(INVOICE_HOURS_SQL, /closed_date|completed_date|last_modified|JOIN normalized_service_jobs/i);
assert.match(INVOICE_HOURS_SQL, /LIMIT 100001/);
const definition: any = { version: 1, id: "invoice-test-v1", name: "Invoice hours",
  dateRange: { start: "2026-09-01", end: "2026-09-30" },
  metrics: ["averagePresentedHoursPerInvoice", "averageSoldHoursPerInvoice"],
  dimensions: ["location"], presentation: { kind: "table" }, comparison: { mode: "none" } };
const scope: any = { kind: "enterprise", enterpriseId: "fixture", shopIds: [1, 2],
  shops: [{ shopId: 1, name: "One" }, { shopId: 2, name: "Two" }] };
assert.deepEqual(compileReportDefinition(definition, scope).execution.stages, ["invoice"]);
assert.throws(() => compileReportDefinition({ ...definition, dimensions: ["date"] }, scope), /Invoice averages/);
assert.throws(() => compileReportDefinition({ ...definition, dimensions: ["technician"] }, scope), /Invoice averages/);
async function main() {
  const stages: string[] = [];
  const result = await executeReportDefinition(definition, scope, { serviceOptions: {
    query: (text, params, context) => {
      assert.equal(text, INVOICE_HOURS_SQL);
      assert.deepEqual(params, ["{1,2}", start.toISOString(), end.toISOString()]);
      stages.push(context!.stage);
      return Promise.resolve(uneven);
    },
  } });
  assert.deepEqual(stages, ["invoice"]);
  assert.equal(result.rows[0].current.averageSoldHoursPerInvoice, 2);
  assert.equal(result.rows[1].current.averageSoldHoursPerInvoice, 100);
  assert.deepEqual(result.metadata.executedRange, definition.dateRange);
  assert.deepEqual(result.metadata.executedScope?.shopIds, [1, 2]);
  assert.ok(result.metadata.dataQuality.notes.some(n => n.includes("not a reconciliation")));
  const filtered = await executeReportDefinition({ ...definition, filters: [{ dimension: "location", operator: "eq", value: "2" }] }, scope,
    { serviceOptions: { query: (_text, params) => {
      assert.deepEqual(params, ["{2}", start.toISOString(), end.toISOString()], "location filter narrows bounded authorized scan");
      return Promise.resolve(uneven.filter(row => row.shop_id === 2));
    } } });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0].shopId, 2);
  console.log("Invoice hours evidence, independent coverage, weighted averages and governed execution: PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
