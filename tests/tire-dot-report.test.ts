import test from "node:test";
import assert from "node:assert/strict";
import { emptyTireResult, extractTireInvoice, tireCsv, tireSaleCandidate, validateTireDefinition } from "../lib/tire-dot-report";
import { TIRE_DOT_LIMITS } from "../lib/tire-dot-report-contract";
import { nullableAuthorizationInvoice } from "./fixtures/tekmetric-null-authorization";

test("source-backed nullable authorization is an exception, never an approved tire sale", () => {
  const raw = nullableAuthorizationInvoice();
  const def = validateTireDefinition({ dateRange: { start: "2026-10-01", end: "2026-10-31" }, locationIds: [32] });
  const r = emptyTireResult(def, [{ shopId: 32, name: "Example" }]);
  extractTireInvoice(r, 32, { data: raw });
  assert.equal(r.counts.tireQuantity, 2);
  assert.equal(r.counts.dotEntries, 2);
  assert.deepEqual(r.details.map(d => d.dot), ["001", "001"]);
  assert.match(r.invoices[0].exceptions.join(" "), /authorization is unknown/);
  assert.match(tireCsv(r, "invoices"), /authorization is unknown/);
  const unknownOnly = emptyTireResult(def, [{ shopId: 32, name: "Example" }]);
  extractTireInvoice(unknownOnly, 32, { data: { ...raw, jobs: raw.jobs.filter(j => j.authorized === null) } });
  assert.equal(unknownOnly.invoices.length, 1, "unknown-only tire invoice stays visible");
  assert.equal(unknownOnly.counts.tireQuantity, 0);
  assert.equal(unknownOnly.details.length, 0);
  assert(unknownOnly.coverage.reasons.some(r => r.includes("authorization is unknown")));
});

export const definition = () => validateTireDefinition({ dateRange: { start: "2024-08-14", end: "2024-08-14" }, locationIds: [311, 32] });
export const result = () => emptyTireResult(definition(), [{ shopId: 311, name: "Fixture location" }, { shopId: 32, name: "Other fixture" }]);
/** Synthetic identifiers/vehicle; source-backed raw field shape and DOT occurrences
 * from the supplied verified example. This is not a coverage audit. */
export function rawInvoice(id = "100") {
  return { workOrderId: id, data: {
    id, repairOrderNumber: "49", postedDate: "2024-08-14T12:00:00Z", repairOrderStatus: { name: "Posted" },
    milesIn: 59663, milesOut: 59663, vehicle: { vin: "FIXTUREVIN", year: 2020, make: "Example", model: "Car" },
    jobs: [{ id: 7, name: "Mount and balance", authorized: true, parts: [
      { id: 1, name: "Pirelli 225/45R18", brand: "Pirelli", quantity: 2, dotNumbers: ["UNK1R7420624", "UNK1R7420624"] },
      { id: 2, name: "Pirelli 225/45R18", brand: "Pirelli", quantity: 2, dotNumbers: ["UNVDR7411924", "UNVDR7411624"] },
    ] }],
  } };
}
test("source shape preserves all four DOT occurrences and per-invoice quantity", () => {
  const r = result(); extractTireInvoice(r, 311, rawInvoice());
  assert.deepEqual(r.counts, { invoices: 1, partLines: 2, tireQuantity: 4, dotEntries: 4 });
  assert.equal(r.details.filter(d => d.dot === "UNK1R7420624").length, 2);
  assert.equal(new Set(r.details.map(d => d.key)).size, 4);
  assert.equal(r.details[0].mileage, 59663);
  extractTireInvoice(r, 32, rawInvoice());
  assert.equal(r.invoices.length, 2, "same invoice number/provider ID in another shop stays distinct");
  const csv = tireCsv(r, "invoices");
  assert.equal(csv.split("\r\n").filter(Boolean).length, 3);
});
test("UTC inclusive bounds and invalid dates", () => {
  const r = result();
  for (const [i, date] of ["2024-08-13T23:59:59.999Z", "2024-08-14T00:00:00Z", "2024-08-14T23:59:59.999Z", "2024-08-15T00:00:00Z"].entries()) {
    const doc = rawInvoice(String(i)); doc.data.postedDate = date; extractTireInvoice(r, 311, doc);
  }
  assert.equal(r.counts.invoices, 2);
  assert.throws(() => validateTireDefinition({ ...definition(), dateRange: { start: "2024-02-30", end: "2024-03-01" } }), /valid/);
  assert.throws(() => validateTireDefinition({ ...definition(), dateRange: { start: "2020-01-01", end: "2024-03-01" } }), /366/);
});
test("tire patches and plugs are repair materials even with tire categories or DOT values", () => {
  for (const name of ["TIRE PATCH", "tire patch", "Tire patches", "Tire patching", "Tire plug",
    "TIRE PLUGS", "Tire plugging", "Patch-plug combination", "Tire repair kit"]) {
    assert.equal(tireSaleCandidate({ name, partType: "Tire", category: { name: "Tires" },
      quantity: 1, dotNumbers: ["NOT-A-TIRE"] }), false, name);
  }
  assert.equal(tireSaleCandidate({ name: "Patchwork Tire 225/45R18", quantity: 1 }), true,
    "whole-word exclusions must not reject unrelated product names");
  assert.equal(tireSaleCandidate({ name: "225/45R18", description: "Wide contact patch for grip", quantity: 1 }), true,
    "contact-patch tread descriptions do not make a genuine tire a repair material");
  assert.equal(tireSaleCandidate({ name: "TIRE PATCH", description: "Contact patch repair material", quantity: 1 }), false);
});
test("repair-only invoices contribute no tire quantities, DOT exceptions or CSV rows", () => {
  const doc: any = rawInvoice();
  doc.data.jobs[0].parts = [{id: 3, name: "TIRE PATCH", quantity: 1, dotNumbers: []},
    {id: 4, name: "Tire plug", quantity: 2, dotNumbers: []}];
  const r = result(); extractTireInvoice(r, 311, doc);
  assert.deepEqual(r.counts, {invoices: 0, partLines: 0, tireQuantity: 0, dotEntries: 0});
  assert.equal(r.details.length, 0);
  assert.equal(r.invoices.length, 0);
  assert.doesNotMatch(tireCsv(r, "details"), /TIRE PATCH|Tire plug|No DOT in captured evidence/);
});
test("sensor plurals, protection plans and tire shaving are not tire sales", () => {
  const names = ["TIRE PRESSURE SENSORS", "TIRE PRESSURE MONITORING SENSORS",
    "TIRE PRESSURE SENSOR", "Tire valves", "Nationwide Tire Protection Plan",
    "TIRE SHAVE TO 9 /32NDS", "Tire shaving"];
  for (const name of names) {
    assert.equal(tireSaleCandidate({ name, category: "Tires", dotNumbers: ["2425"] }), false, name);
    assert.equal(tireSaleCandidate({ description: name, partType: "Tire" }), false, name);
  }
  const doc: any = rawInvoice();
  doc.data.jobs[0].parts.push(...names.map((name, id) => ({ id: 100 + id, name, quantity: 4, dotNumbers: [] })));
  const r = result(); extractTireInvoice(r, 311, doc);
  assert.deepEqual(r.counts, { invoices: 1, partLines: 2, tireQuantity: 4, dotEntries: 4 });
  assert.equal(r.details.length, 4);
  assert.equal(r.invoices[0].exceptions.length, 0);
  assert.doesNotMatch(tireCsv(r, "details"), /SENSORS|Protection Plan|SHAVE/);
  doc.data.jobs[0].parts = doc.data.jobs[0].parts.slice(2);
  const excluded = result(); extractTireInvoice(excluded, 311, doc);
  assert.equal(excluded.counts.invoices, 0);
  assert.equal(excluded.details.length, 0);
});
test("mixed invoices keep genuine tires and repeated DOTs without counting repair materials", () => {
  const doc: any = rawInvoice();
  doc.data.jobs[0].name = "Tire patch and tire replacement";
  doc.data.jobs[0].parts.push({id: 3, name: "TIRE PATCH", quantity: 1, dotNumbers: []},
    {id: 4, name: "Tire plug", quantity: 1, dotNumbers: ["NOT-A-TIRE"]});
  const r = result(); extractTireInvoice(r, 311, doc);
  assert.deepEqual(r.counts, {invoices: 1, partLines: 2, tireQuantity: 4, dotEntries: 4});
  assert.equal(r.details.filter(d => d.dot === "UNK1R7420624").length, 2);
  assert.doesNotMatch(tireCsv(r, "details"), /TIRE PATCH|NOT-A-TIRE|No DOT in captured evidence/);
  assert.doesNotMatch(tireCsv(r, "invoices"), /No DOT in captured evidence/);
});
test("missing fields, zero invoice mileage, no current-vehicle fallback", () => {
  const r = result(); const doc: any = rawInvoice();
  delete doc.data.milesIn; delete doc.data.milesOut; doc.data.vehicle.mileage = 999999;
  doc.data.jobs[0].parts[0].dotNumbers = []; doc.data.jobs[0].parts[1].dotNumbers = [];
  extractTireInvoice(r, 311, doc);
  assert.equal(r.invoices[0].mileage, null);
  assert.equal(r.invoices[0].dotEntries, 0);
  assert.ok(r.invoices[0].exceptions.includes("No DOT in captured evidence (not verified against Tekmetric UI)"));
  assert.ok(r.invoices[0].exceptions.includes("Missing invoice mileage"));
  doc.data.id = doc.workOrderId = "101"; doc.data.milesIn = 0; doc.data.milesOut = 400;
  extractTireInvoice(r, 311, doc); assert.equal(r.invoices[1].mileage, 0);
});
test("declined/open/archived/deleted and non-tire work do not contribute", () => {
  for (const name of ["DOT 4 brake fluid", "Tire rotation", "Mount labor", "Tire disposal", "TPMS sensor", "Wheel balance"]) {
    assert.equal(tireSaleCandidate({ name, quantity: 1, dotNumbers: ["bad"] }), false, name);
  }
  assert.equal(tireSaleCandidate({ name: "Oil filter", quantity: 1 }), false);
  for (const patch of [
    (d: any) => d.data.jobs[0].authorized = false,
    (d: any) => d.data.jobs[0].status = "open",
    (d: any) => d.data.jobs[0].deleted = true,
    (d: any) => d.data.deletedDate = "2024-08-15",
    (d: any) => d.data.repairOrderStatus = "In Progress",
    (d: any) => d.data.jobs[0].parts.forEach((p: any) => p.archived = true),
    (d: any) => d.status = "Void",
    (d: any) => d.status = "Archived",
    (d: any) => d.deletedDate = "2024-08-15",
  ]) {
    const r = result(), d = rawInvoice(); patch(d); extractTireInvoice(r, 311, d); assert.equal(r.invoices.length, 0);
  }
});
test("missing raw and dates are incomplete, not proof of no sales", () => {
  const r = result(); extractTireInvoice(r, 311, {}); extractTireInvoice(r, 311, { data: {} });
  const d: any = rawInvoice(); delete d.data.postedDate; extractTireInvoice(r, 311, d);
  assert.equal(r.coverage.status, "incomplete"); assert.equal(r.coverage.missingRaw, 2); assert.equal(r.coverage.missingPostedDate, 1);
});
test("structured tire types and prefixed widths survive absent labels and DOTs", () => {
  for (const width of ["P205", "LT315", "ST205", "205"]) {
    assert.equal(tireSaleCandidate({ width, ratio: 55, diameter: 18 }), true);
  }
  assert.equal(tireSaleCandidate({ partType: { code: "TIRE", name: "Tire" } }), true);
  assert.equal(tireSaleCandidate({ width: "garbage205", ratio: 55, diameter: 18 }), false);
  assert.equal(tireSaleCandidate({ name: "TIRE PRESSURE SENSORS", partType: { code: "TIRE" } }), false);
  const r = result(), d: any = rawInvoice();
  d.data.jobs[0].parts = [{ id: 1, partType: { code: "TIRE" }, width: "LT315", quantity: 5, dotNumbers: [] }];
  extractTireInvoice(r, 311, d);
  assert.equal(r.counts.tireQuantity, 5);
  assert.equal(r.counts.dotEntries, 0);
});

test("posted authorized archived jobs remain sales but deletion and declines still veto", () => {
  for (const archive of [{ archived: true }, { isArchived: true }, { archivedDate: "2024-08-15" }]) {
    const d: any = rawInvoice(); Object.assign(d.data.jobs[0], archive);
    const r = result(); extractTireInvoice(r, 311, d);
    assert.equal(r.counts.tireQuantity, 4);
    for (const veto of [{ authorized: false }, { status: "declined" }, { deleted: true }, { deletedAt: "2024-08-15" }, { isDeleted: true }]) {
      const copy = structuredClone(d); Object.assign(copy.data.jobs[0], veto);
      const excluded = result(); extractTireInvoice(excluded, 311, copy);
      assert.equal(excluded.counts.tireQuantity, 0);
    }
  }
});
test("textual CSV identifiers and formula protection with duplicate entries", () => {
  const r = result(), d = rawInvoice();
  d.data.repairOrderNumber = "00049";
  d.data.jobs[0].parts[0].dotNumbers = ["001234", "001234"];
  d.data.jobs[0].parts[0].name = "=HYPERLINK(\"x\") tire";
  extractTireInvoice(r, 311, d); r.generatedAt = "2026-01-01T00:00:00Z";
  const csv = tireCsv(r, "details");
  assert.equal((csv.match(/'001234/g) || []).length, 2);
  assert.match(csv, /"'00049"/); assert.match(csv, /"'=HYPERLINK/);
  assert.match(csv, /Coverage notes/); assert.match(csv, /2024-08-14/);
});
test("result cap is atomic per invoice with explicit incomplete counts", () => {
  const r = result();
  r.details = Array(TIRE_DOT_LIMITS.rows - 1).fill({});
  extractTireInvoice(r, 311, rawInvoice());
  assert.equal(r.limited, true); assert.equal(r.invoices.length, 0); assert.equal(r.counts.dotEntries, 0);
});
