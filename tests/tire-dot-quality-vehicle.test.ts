import test from "node:test";
import assert from "node:assert/strict";
import { assessTireDot } from "../lib/tire-dot-quality";
import { tireVehicle } from "../lib/tire-dot-vehicle";
import { enrichTireVin } from "../lib/tire-dot-vin";
import { emptyTireResult, extractTireInvoice, tireCsv, validateTireDefinition } from "../lib/tire-dot-report";

test("documented quality policy is conservative and deterministic", () => {
  for (const value of ["0", "1", "0000", "", "  ", "N/A", "unknown", "XXXX", null, 2425, {}, false])
    assert.equal(assessTireDot(value).status, "invalid", String(value));
  for (const value of ["2425", "ABCD239", "ABCD0025", "ABCD5425", "ABC", "AB-CD2425"])
    assert.equal(assessTireDot(value).status, "needs-review", value);
  for (const value of ["UNK1R7420624", "UNVDR7411924", "DOT AB CD 2425", "ABC1234562425"])
    assert.equal(assessTireDot(value).status, "structurally-plausible", value);
});

test("structured precedence, partial enrichment with VIN present, conflicts and exact identity", () => {
  const doc = { shopId: 1, workOrderId: 42, data: { id: 42, shopId: 10, vehicleId: 7, vehicle: { vin: "1HGCM82633A004352", make: "Land Rover" } } };
  const candidate = { shopId: 1, workOrderId: 42, data: { id: 42, shopId: 10, vehicleId: 7, vehicleYear: 2020, vehicleModel: "Range Rover Sport" } };
  const enriched = enrichTireVin(doc, [candidate], 1);
  assert.deepEqual(tireVehicle(enriched), { vin: doc.data.vehicle.vin, year: "2020", make: "Land Rover", model: "Range Rover Sport" });
  assert.equal(enriched.data, doc.data);
  assert.match(enriched.vehicleProvenance, /identity verified/);
  for (const bad of [
    { ...candidate, shopId: 2 }, { ...candidate, workOrderId: 43 },
    { ...candidate, data: { ...candidate.data, vehicleId: 8 } },
    { ...candidate, data: { ...candidate.data, shopId: 11 } },
    { ...candidate, vin: "1HGCM82633A004353" },
  ]) assert.equal(enrichTireVin(doc, [bad], 1), doc);
  assert.equal(enrichTireVin(doc, [candidate, { ...candidate, vehicleModel: "Other", data: { ...candidate.data, vehicleModel: "Other" } }], 1), doc);
  assert.deepEqual(tireVehicle({ vehicleYear: 2010, vehicleMake: "Header", vehicleModel: "Header Model",
    data: { vehicleYear: 2020, vehicleMake: "Flat", vehicle: { year: 2021, make: "", model: "Multi Word Model" } } }),
  { vin: null, year: "2021", make: "Flat", model: "Multi Word Model" });
  assert.equal(tireVehicle({ data: { vehicle: "2020 Land Rover Range Rover" } }).model, null);
});

test("mixed quality preserves occurrence identity and recorded counts; aligned safe CSV and immutable legacy exports", () => {
  const r = emptyTireResult(validateTireDefinition({ dateRange: { start: "2024-08-14", end: "2024-08-14" }, locationIds: [1] }), [{ shopId: 1, name: "Fixture" }]);
  const dots = ["UNK1R7420624", "UNK1R7420624", "1", "2425", " ", null];
  extractTireInvoice(r, 1, { data: { id: 1, postedDate: "2024-08-14T12:00:00Z", vehicle: { year: 2020, make: "=Formula", model: 'Multi, "Word" Model' },
    jobs: [{ authorized: true, parts: [{ name: "Tire", quantity: 6, dotNumbers: dots, _mosDotInherited: true }] }] } });
  assert.equal(r.counts.dotEntries, 4);
  assert.equal(r.usableDotEntries, 2);
  assert.equal(r.invoices[0].usableDotEntries, 2);
  assert.deepEqual(r.details.map(d => d.dot), dots);
  assert.deepEqual(r.details.map(d => d.entryIndex), [0, 1, 2, 3, 4, 5]);
  assert.match(r.invoices[0].exceptions.join(";"), /Structurally usable.*quantity/);
  assert.match(r.invoices[0].exceptions.join(";"), /earlier payload/);
  const parse = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(m => m[1].replaceAll('""', '"'));
  for (const view of ["details", "invoices"] as const) {
    const lines = tireCsv(r, view).slice(1).trim().split("\r\n").map(parse);
    const headers = lines[0], row = lines[1];
    for (const line of lines) assert.equal(line.length, headers.length);
    assert.equal(row[headers.indexOf("Year")], "2020");
    assert.equal(row[headers.indexOf("Make")], "'=Formula");
    assert.equal(row[headers.indexOf("Model")], 'Multi, "Word" Model');
    if (view === "details") assert.equal(row[headers.indexOf("DOT validation status")], "structurally-plausible");
    else assert.equal(row[headers.indexOf("Structurally usable DOT entries")], "2");
  }
  delete r.usableDotEntries;
  for (const row of [...r.details, ...r.invoices]) {
    delete row.year; delete row.make; delete row.model; delete row.usableDotEntries;
    if ("dotQuality" in row) delete row.dotQuality;
  }
  const before = JSON.stringify(r);
  assert.match(tireCsv(r, "details"), /not-assessed/);
  assert.match(tireCsv(r, "invoices"), /Not assessed/);
  assert.equal(JSON.stringify(r), before);
  assert.equal(r.counts.dotEntries, 4);
});
