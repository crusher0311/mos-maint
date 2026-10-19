// Execute server aggregation in network-denied Node, never in the browser.
import { mkdirSync, writeFileSync } from "node:fs";
import { aggregateInvoiceHours, type InvoiceHoursFact } from "../../lib/invoice-hours-contract";
const id = "10000000-0000-0000-0000-000000000001";
const verified: InvoiceHoursFact = { id: "verified", shop_id: 1, provider: "protractor", status: "invoiced",
  source_ids: [{ system: "protractor", idType: "invoice_id", idValue: id }],
  invoice_evidence: { version: 1, id, date: "2026-09-02T12:00:00Z", sold: 2, presented: 3 } };
const facts: InvoiceHoursFact[] = [
  { ...verified, id: "missing", invoice_evidence: null },
  { ...verified, id: "open", provider: "tekmetric", status: "open", invoice_evidence: null }, verified,
];
const summarize = (rows: InvoiceHoursFact[]) => aggregateInvoiceHours(rows,
  new Date("2026-09-01"), new Date("2026-09-30T23:59:59.999Z")).summary;
mkdirSync("generated-artifacts", { recursive: true });
writeFileSync("generated-artifacts/invoice-population.json", JSON.stringify({
  capped: summarize(Array.from({ length: 100001 }, () => verified)),
  resolved: summarize(facts),
  conflict: summarize([...facts, { ...verified, id: "conflict",
    invoice_evidence: { ...verified.invoice_evidence!, sold: 7, presented: 8 } }]),
}));
