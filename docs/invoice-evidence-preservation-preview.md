# Invoice evidence preservation and read-only preview

## Behavior

- Newly created normalized work orders retain the adapter's custom fields.
- For Protractor, a final-but-incomplete snapshot may retain a previously verified
  invoice identity/date only with matching shop and provider identity and no
  conflicting supplied date. Retained sold/presented hours become unknown, not
  stale averages.
- Valid new evidence remains authoritative. Different identities, nonfinal
  stages, invalid prior dates, and conflicting dates do not inherit evidence.
- The canonical PostgreSQL change-detection projection includes the shop and
  custom fields needed for the same protection as Mongo-backed ingestion.
- Existing rows are not bulk repaired or forced through full financial ingestion.

## Read-only preview

Run `scripts/preview-invoice-evidence-repair.ts` with explicit comma-separated
shop IDs (maximum ten) and a YYYY-MM-DD date. It reads only page zero of that
day's archived weekend-campaign response, verifies its digest, and checks the
matching Mongo and PostgreSQL records. It makes no Protractor calls and performs
no writes. Output is aggregate counts, not customer data or invoice IDs.

Candidates require usable archived evidence, unique local matching, matching
canonical provider identity, no preexisting reporting evidence in either store,
and no conflicting source dates or recorded labor-hour evidence in the inspected
snapshots. Existing evidence or conflicts require review.

The 2026-10-17 preview of archived 2026-10-16 pages found:

| Shop | Usable archived invoices | Candidates |
| --- | ---: | ---: |
| 227 | 26 | 26 |
| 228 | 32 | 32 |
| 139 | 18 | 18 |
| 457 | 14 | 14 |

One additional source document was not eligible for invoice evidence. This is a
bounded 90-record preview, not fleet-wide certification or proof that all unknown
records can be repaired. No repair was applied.

A future repair requires separate approval, expanded conflict checks, fresh
compare-and-set guards on both stores, auditable outcomes, and reporting-only
field updates. Never replace invoice totals, line items, source provenance, or
upstream invoices. Revalidate source evidence rather than trusting preview counts.

## Verification

The actual ingestion create/update regression, invoice-hour tests, canonical
skip-path regressions, and TypeScript checks passed. Signed-in UI was not tested;
these changes do not modify the UI. This preservation fix is separate from the
already-pushed duplicate-query backfill fix and has not yet been deployed.
