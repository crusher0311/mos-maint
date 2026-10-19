import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { ProtractorAdapter } from "../lib/integrations/core/normalized-adapter";
import { NormalizedIngestionService } from "../lib/integrations/core/normalized-ingestion";

// Run unchanged in BOTH service-specific release checkouts. The adapter and
// ingestion implementation are real; only persistence is replaced, with no
// provider client, credentials, repair executor or reporting flag enabled.
const id = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
const otherId = "11111111-1111-4111-8111-111111111111";
const date = "2026-10-16T12:00:00.000Z";
const adapter = new ProtractorAdapter();
const source = (): any => ({
  ID: id, Type: "Invoice", WorkflowStage: "Invoice", InvoiceNumber: 123,
  InvoiceTime: date, Total: 250,
  ServicePackages: [{ ID: "sold", Status: "Completed", IsInvoicing: true,
    ServicePackageLines: [{ ID: "labor", Type: "Labor", BilledHours: 2 }] }],
  DeferredServicePackages: [{ ID: "deferred", Status: "Deferred",
    ServicePackageLines: [{ ID: "declined-labor", Type: "Labor", Hours: 1 }] }],
});
const evidence = (sold: number | null, presented: number | null) =>
  ({ version: 1, id, date, sold, presented });
const previous = () => ({
  _id: "stored", shopId: 25, version: 1, createdAt: new Date(date), softDelete: {},
  customFields: { invoiceHours: evidence(88, 99) },
  provenance: { sourceIds: adapter.getSourceIds(source()), contentHash: "old" },
});

async function ingest(raw: any, prior: any, expected: any, conflict = false) {
  const pg: any[] = [], mongo: any[] = [];
  const db: any = { collection: () => ({
    findOne: async () => prior,
    insertOne: async (doc: any) => { mongo.push(doc); return { insertedId: doc._id }; },
    updateOne: async (_query: any, update: any) => { mongo.push(update.$set); return { matchedCount: 1 }; },
  }) };
  const service = new NormalizedIngestionService(db, "protractor", 25, undefined, {
    dualWriteToSupabase: false, createAuditLog: false, dualWriteToJobIndex: false,
    dualWriteToRepairPatterns: false, syncRunId: "offline-compatibility",
  }, adapter);
  (service as any).supabaseDualWriter = {
    findWorkOrderByNaturalKey: async () => prior,
    upsertWorkOrder: async (doc: any) => { pg.push(doc); },
  };
  const result = await service.ingestWorkOrder(raw);
  if (conflict) {
    assert.equal(result.success, false);
    assert.equal(pg.length + mongo.length, 0, "identity veto precedes both parent writes");
    return;
  }
  assert.equal(result.success, true, result.message);
  assert.ok(pg.length, "actual ingestion must write the canonical document");
  const mapped = adapter.mapWorkOrder(25, raw);
  for (const doc of [...pg, ...mongo]) {
    assert.deepEqual(doc.customFields.invoiceHours, expected);
    assert.deepEqual(doc.rawPayload, raw);
    assert.equal(doc.grandTotal, mapped.grandTotal, "hours backport does not repair finances");
    assert.deepEqual(doc.provenance.sourceIds.filter((s: any) => s.idType === "invoice_id"),
      adapter.getSourceIds(raw).filter(s => s.idType === "invoice_id"));
  }
}

async function main() {
  const cases: [string, any, any][] = [];
  const add = (name: string, mutate: (r: any) => void, expected: any) => {
    const raw = source(); mutate(raw); cases.push([name, raw, expected]);
  };
  add("complete", () => {}, evidence(2, 3));
  add("changed hours", r => r.ServicePackages[0].ServicePackageLines[0].BilledHours = 4, evidence(4, 5));
  add("explicit zero", r => r.ServicePackages[0].ServicePackageLines[0].BilledHours = 0, evidence(0, 1));
  add("missing regular collection", r => delete r.ServicePackages, evidence(null, null));
  add("malformed deferred", r => r.DeferredServicePackages = null, evidence(2, null));
  // Release candidates predate the separately approved omitted-deferred rule.
  // Keep their conservative behavior; do not silently import a newer policy.
  add("omitted deferred", r => delete r.DeferredServicePackages,
    evidence(2, process.argv.includes("--release-candidate") ? null : 2));
  add("estimated only", r => r.ServicePackages[0].ServicePackageLines =
    [{ ID: "labor", Type: "Labor", EstimatedHours: 40 }], evidence(null, null));
  add("missing invoicing", r => delete r.ServicePackages[0].IsInvoicing, evidence(null, null));
  add("missing job identity", r => delete r.ServicePackages[0].ID, evidence(null, null));
  add("duplicate lines", r => r.ServicePackages[0].ServicePackageLines.push(
    structuredClone(r.ServicePackages[0].ServicePackageLines[0])), evidence(2, 3));
  for (const reverse of [false, true]) {
    add(`conflicting copies ${reverse}`, r => {
      const copy = structuredClone(r.ServicePackages[0]);
      copy.ServicePackageLines[0].BilledHours = 7;
      r.ServicePackages.push(copy);
      if (reverse) r.ServicePackages.reverse();
      r.ServicePackages = { ItemCollection: r.ServicePackages };
    }, evidence(null, null));
  }
  for (const [name, raw, expected] of cases) {
    assert.deepEqual(adapter.mapWorkOrder(25, raw).customFields?.invoiceHours, expected, name);
    await ingest(raw, null, expected);
    await ingest(raw, previous(), expected);
  }
  const incomplete = { ...source(), Type: "WorkOrder", InvoiceNumber: 0 };
  assert.equal(adapter.mapWorkOrder(25, incomplete).customFields?.invoiceHours, null);
  await ingest(incomplete, previous(), evidence(null, null));
  await ingest(incomplete, null, null);
  for (const change of [
    { InvoiceTime: "2026-10-15T12:00:00Z" }, { InvoiceTime: "invalid" },
    { WorkflowStage: "Estimate" }, { Status: "Voided" }, { Type: "Credit" },
  ]) await ingest({ ...incomplete, ...change }, previous(), null);
  await ingest(incomplete, { ...previous(), shopId: 26 }, null);
  for (const ids of [[otherId], [id, otherId]]) {
    const prior = previous();
    prior.provenance.sourceIds = ids.map(idValue => ({ system: "protractor",
      idType: "invoice_id", idValue })) as any;
    await ingest(source(), prior, null, true);
  }
  console.log(`PASS real adapter and ingestion: ${cases.length} create/update cases, retention and identity/date vetoes`);
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
