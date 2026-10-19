import assert from "node:assert/strict";
import { test } from "node:test";
import { hoursDisplay, summarizeInvoiceHours, type InvoiceHoursRow } from "./invoice-hours-summary";

function row(count: number, presented: number, sold: number, patch: Record<string, number | null> = {}): InvoiceHoursRow {
  return { key: String(count), label: "Fictional test location", current: {
    invoiceCount: count, invoicePresentedHours: presented, invoiceSoldHours: sold,
    invoicePresentedCovered: count, invoiceSoldCovered: count, invoicePopulationUnknown: 0,
    averagePresentedHoursPerInvoice: count ? presented / count : null,
    averageSoldHoursPerInvoice: count ? sold / count : null, ...patch,
  } };
}
test("fictional 100-invoice example yields 3.00 presented and 2.00 sold", () => {
  const value = summarizeInvoiceHours([row(100, 300, 200)]);
  assert.equal(hoursDisplay(value.presented.value, value.count, value.unknown), "3.00");
  assert.equal(hoursDisplay(value.sold.value, value.count, value.unknown), "2.00");
});
test("cards divide summed raw totals, not rounded location averages", () => {
  const value = summarizeInvoiceHours([
    row(3, 10, 4, { averagePresentedHoursPerInvoice: 3.33, averageSoldHoursPerInvoice: 1.33 }),
    row(97, 200, 160, { averagePresentedHoursPerInvoice: 2.06, averageSoldHoursPerInvoice: 1.65 }),
  ]);
  assert.equal(value.presented.value, 2.1);
  assert.equal(value.sold.value, 1.64);
});
test("coverage failures are independent", () => {
  const value = summarizeInvoiceHours([row(100, 300, 200, { invoicePresentedCovered: 99, averagePresentedHoursPerInvoice: null })]);
  assert.equal(value.presented.value, null);
  assert.equal(value.presented.covered, 99);
  assert.equal(value.sold.value, 2);
});
test("unknown population blocks both metrics, separately from numerator coverage", () => {
  const value = summarizeInvoiceHours([row(100, 300, 200, { invoicePopulationUnknown: 2 })]);
  assert.equal(value.presented.value, null);
  assert.equal(value.sold.value, null);
  assert.equal(value.sold.covered, 100);
  assert.equal(value.unknown, 2);
});
test("zero invoices and empty executions mean no data, not zero hours", () => {
  for (const rows of [[], [row(0, 0, 0)]]) {
    const value = summarizeInvoiceHours(rows);
    assert.equal(hoursDisplay(value.sold.value, value.count, value.unknown), "No data");
    assert.equal(value.sold.value, null);
  }
});
test("zero-count locations do not invalidate populated locations", () => {
  assert.equal(summarizeInvoiceHours([row(0, 0, 0), row(100, 300, 200)]).sold.value, 2);
});
test("missing population or numerator is never silently treated as zero", () => {
  assert.equal(summarizeInvoiceHours([row(100, 300, 200, { invoiceSoldHours: null })]).sold.value, null);
  assert.equal(summarizeInvoiceHours([row(100, 300, 200, { invoicePopulationUnknown: null })]).sold.value, null);
});
test("authoritative null average prevents a fabricated aggregate", () => {
  assert.equal(summarizeInvoiceHours([row(100, 300, 200, { averageSoldHoursPerInvoice: null })]).sold.value, null);
});
test("capped coverage never presents partial rows as totals or no data", () => {
  const value = summarizeInvoiceHours([row(0, 0, 0, { invoiceEvidenceCapped: 1 })]);
  assert.equal(value.capped, true);
  assert.equal(value.count, null);
  assert.equal(value.unknown, null);
  assert.equal(hoursDisplay(value.sold.value, value.count, value.unknown), "Incomplete data");
});
