# HEART pre-release validation — October 1–20, 2026

## Release decision: hold

### Correction after direct raw invoice-number lookup

The normalized-gated counts below are the initial result, not the final count.
Direct shop-scoped queries of `data.repairOrderNumber`, `workOrderNumber` and
`repairOrderNumber` located **70 of the 72 previously unresolved invoices**.
All 70 match all seven monetary fields exactly. Combined, **2,618 of 2,620**
invoices match, totaling **$2,130,288.97**. Two remain unresolved, totaling
**$132.51**. Seven shop queries reached their safety deadline after returning
matches, so absence and duplicate completeness are not certified. No retrieved
additional invoice contained nonempty DOT entries.

This demonstrates why normalized associations must not gate raw DOT discovery.
Use `scripts/verify-heart-raw-unresolved.ts` and its ignored local evidence for
the supplemental direct-raw results. Release remains held for DOT coverage.

The uploaded enterprise Sales Details export establishes a reference population
of 2,620 distinct location/invoice pairs and $2,130,421.48 in Total Sales.
It is an all-invoice report, not a tire-sales population.

Read-only comparison found 2,548 corresponding retained raw Tekmetric invoices.
Every located invoice matches all seven exported money fields exactly, in cents:
labor, parts, sublet, fees, discounts, tax, and total sales.

| Result | Invoices | Export total |
|---|---:|---:|
| Located, all seven amounts match | 2,548 | $2,108,067.10 |
| Unresolved by bounded indexed lookup | 72 | $22,354.38 |
| Amount mismatch among located invoices | 0 | $0.00 |

Unresolved does not mean definitively missing from every retained source.
The lookup matched current enterprise shop membership and location identifiers,
then used normalized Tekmetric source invoice identities to obtain provider RO
IDs, followed by exact shop-scoped raw-cache reads. One unresolved entry has a
provider identity but no unique matching raw invoice; 71 lack a usable normalized
identity through that lookup. No upstream requests, writes, indexes or production
activation occurred.

## Tire report is not yet verified for live use

- None of the 2,548 retrieved raw invoices had a nonempty `dotNumbers` collection.
  This does not prove the provider has no DOT data; it establishes a retained
  evidence gap requiring investigation.
- The current parser returns 71 tire-candidate invoices / 74 part lines /
  98 recorded quantity, all without DOT entries. This is **not** a complete tire
  count and must not be presented as an accurate registration report.
- 82 retrieved raw invoices lack a usable posted date. Some stored snapshots
  have Accounts Receivable or earlier workflow states, although they appear in
  the posted-sales export. The parser's current status policy needs further
  source-backed validation; financial agreement alone does not authorize changing
  invoice eligibility or repairing source records.
- CSV timestamps use CDT (UTC-05:00); the report uses inclusive UTC days.
  Identity-led comparison avoids incorrectly calling a date-window lookup miss
  a missing invoice. Any date-based reconciliation must align the two calendars.

## Evidence and reproducibility

`scripts/reconcile-heart-sales.ts` consumes a minimized local copy of the
uploaded export (location, invoice, posted timestamp, seven monetary columns),
reads current membership and matches indexed invoice identities. It checkpoints
per-location comparison outputs under the ignored `generated-artifacts/` folder.
Customer names and contact details are not included in reconciliation downloads.

The earlier `scripts/verify-heart-tire-dot.ts` date-scoped traversal timed out
for seven shops and must not be used as coverage proof. Its zero/partial result
was superseded by the CSV-anchored comparison, not treated as no sales.

Next investigation must distinguish missing normalized associations, missing
retained raw data, and omitted DOT fields before approving live reporting.
Do not widen scans, install production indexes, re-fetch provider history or
repair records without separate authorization.
