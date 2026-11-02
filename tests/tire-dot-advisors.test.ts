import test from "node:test";
import assert from "node:assert/strict";
import { capturedTireAdvisor, enrichTireAdvisor, tireAdvisorAnalysis } from "../lib/tire-dot-advisors";
import { emptyTireResult, extractTireInvoice, tireCsv, validateTireDefinition } from "../lib/tire-dot-report";
import { pilotEvidence } from "../lib/tire-dot-pilot";

test("service writer identity never falls back to technician; strict revision enrichment", () => {
  assert.equal(capturedTireAdvisor({ technician: { name: "Tech" } }), undefined);
  assert.deepEqual(capturedTireAdvisor({ serviceWriterId: 5, serviceWriterAccountFirstName: "Test", serviceWriterAccountLastName: "Advisor" }),
    { id: "5", name: "Test Advisor", provenance: "Captured invoice service writer" });
  const doc = { shopId: 1, workOrderId: 10, data: { id: 10, shopId: 100, vehicleId: 7, updatedDate: "2026-10-01T00:00:00Z" } };
  const candidate = { ...doc, data: { ...doc.data, serviceWriter: { id: 5, name: "Advisor" } } };
  assert.equal(enrichTireAdvisor(doc, [candidate], 1).tireAdvisor.name, "Advisor");
  for (const c of [{ ...candidate, shopId: 2 }, { ...candidate, workOrderId: 11 },
    { ...candidate, data: { ...candidate.data, updatedDate: "different" } },
    { ...candidate, data: { ...candidate.data, vehicleId: 8 } }]) {
    assert.equal(enrichTireAdvisor(doc, [c], 1), doc);
  }
  assert.equal(enrichTireAdvisor(doc, [candidate, candidate], 1), doc);
  assert.equal(enrichTireAdvisor(candidate, [candidate], 1), candidate);
  const pinned = pilotEvidence({ ...candidate.data, serviceWriter: { id: 5, name: "Advisor", email: "not-retained" } }, 100);
  assert.deepEqual(pinned.serviceWriter, { id: 5, name: "Advisor" });
});

test("advisor invoice counts deduplicate occurrences, separate locations, and leave legacy unassessed", () => {
  const r = emptyTireResult(validateTireDefinition({ dateRange: { start: "2026-10-01", end: "2026-10-31" }, locationIds: [1, 2] }), []);
  const add = (id: number, shop: number, dots: string[], advisor = true) => extractTireInvoice(r, shop, { data: {
    id, repairOrderNumber: id, postedDate: "2026-10-10T12:00:00Z",
    ...(advisor ? { serviceWriter: { id: 5, name: "=Advisor" } } : {}),
    jobs: [{ authorized: true, parts: [{ name: "Tire", quantity: 2, dotNumbers: dots }] }],
  } });
  add(1, 1, ["1", "1"]); add(2, 1, ["UNK1R7420624", "UNK1R7420624"]);
  add(3, 2, []); add(4, 1, ["2425", "2425"], false);
  const groups = tireAdvisorAnalysis(r);
  const a = groups.find(g => g.advisor === "=Advisor" && g.shopId === 1)!;
  assert.equal(a.invoices, 2); assert.equal(a.flagged, 1); assert.equal(a.invalid, 1);
  assert.equal(a.assessed, 2); assert.deepEqual(a.invoiceNumbers, ["1"]);
  assert.equal(groups.find(g => g.shopId === 2)!.missing, 1);
  assert.equal(groups.find(g => g.advisor === "Advisor unavailable")!.review, 1);
  assert.match(tireCsv(r, "invoices"), /"'=Advisor"/);
  delete r.invoices[0].usableDotEntries;
  const before = JSON.stringify(r);
  const legacy = tireAdvisorAnalysis(r).find(g => g.advisor === "=Advisor" && g.shopId === 1)!;
  assert.equal(legacy.unassessed, 1); assert.equal(legacy.assessed, 1); assert.equal(legacy.flagged, 0);
  assert.equal(JSON.stringify(r), before);
});
