import { test } from "node:test";
import assert from "node:assert/strict";
import { tireLocalDay, validTireTimeZone } from "../lib/tire-dot-dates";
import { enrichTireVin } from "../lib/tire-dot-vin";
import { emptyTireResult, extractTireInvoice, tireCsv, validateTireDefinition } from "../lib/tire-dot-report";

test("Central date boundaries honor daylight savings, not a fixed CST offset", () => {
  assert.equal(tireLocalDay("2026-10-01T04:59:59Z", "America/Chicago"), "2026-09-30");
  assert.equal(tireLocalDay("2026-10-01T05:00:00Z", "America/Chicago"), "2026-10-01");
  assert.equal(tireLocalDay("2026-11-02T05:59:59Z", "America/Chicago"), "2026-11-01");
  assert.equal(tireLocalDay("2026-11-02T06:00:00Z", "America/Chicago"), "2026-11-02");
  assert.equal(validTireTimeZone("not/a/zone"), false);
});

const source = () => ({ data: { id: 42, shopId: 10, vehicleId: 7, postedDate: "2026-11-01T04:00:00Z",
  repairOrderNumber: 5, jobs: [{ id: 8, authorized: true, parts: [{ id: 9, name: "Tire", quantity: 1, dotNumbers: [] }] }] } });
test("identity-enrichment is exact, conflict-safe, and leaves DOT evidence unchanged", () => {
  const doc = source();
  const c = { shopId: 1, workOrderId: 42, data: { id: 42, shopId: 10, vehicleId: 7 }, vin: "1HGCM82633A004352" };
  const enriched = enrichTireVin(doc, [c], 1);
  assert.equal(enriched.vin, c.vin);
  assert.equal(enriched.data, doc.data);
  assert.match(enriched.vinProvenance, /identity verified/);
  for (const bad of [{ ...c, shopId: 2 }, { ...c, workOrderId: 43 }, { ...c, data: { ...c.data, vehicleId: 8 } },
    { ...c, data: { ...c.data, shopId: 11 } }, { ...c, vin: "bad" }]) {
    assert.equal(enrichTireVin(doc, [bad], 1), doc);
  }
  assert.equal(enrichTireVin(doc, [c, { ...c, vin: "1HGCM82633A004353" }], 1), doc);
});
test("local dates include October evening invoices; legacy UTC snapshots remain UTC", () => {
  const old = validateTireDefinition({ dateRange: { start: "2026-10-01", end: "2026-10-31" }, locationIds: [1] });
  const local = validateTireDefinition({ ...old, timeZones: { 1: "America/Chicago" } });
  const legacyResult = emptyTireResult(old, [{ shopId: 1, name: "Fixture" }]);
  const result = emptyTireResult(local, legacyResult.locations);
  extractTireInvoice(legacyResult, 1, source());
  extractTireInvoice(result, 1, source());
  assert.equal(legacyResult.counts.invoices, 0);
  assert.equal(result.counts.invoices, 1);
  assert.match(result.details[0].exceptions.join(), /not verified against Tekmetric UI/);
  assert.match(tireCsv(result, "details"), /Start shop-local inclusive/);
  assert.match(tireCsv(legacyResult, "details"), /Start UTC inclusive/);
  assert.match(tireCsv(result, "details"), /America\/Chicago/);
});
