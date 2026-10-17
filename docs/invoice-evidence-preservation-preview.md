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

## Extended local verification

- Actual SQL execution over ten fictional shops and 120,000 verified historical
  rows returned the 100 in-range invoices, with expected sold/presented averages
  of 5.5 and 6.5 hours. Making one presentation value unknown withheld only that
  average; the sold average remained valid.
- Queue/execution/persistence/retry/reopen tests passed using throwaway local PG.
- Offline browser tests passed for explicit Run, location/date filters, weighted
  cards, independent coverage, retained results, scope isolation, and mobile.
  Browser API responses are fixtures, not live production reports.
- A read-only simulation of the 90 archived real-source candidates found complete
  sold-hour evidence on all 90, but complete presented-hour evidence on only 33.
  Therefore metadata preservation alone cannot produce trustworthy presented-hour
  averages for this sample. No real full-enterprise period has been certified.

## Deferred collection omission investigation

Read-only check on 2026-10-17, using archived 2026-10-16 invoices:

- Of 90 eligible invoices, 33 contained 129 deferred packages. All 33 had
  complete presented-hour evidence.
- The other 57 omitted DeferredServicePackages entirely; none returned an
  explicit empty collection. All 57 were classified as incomplete presentation.
- Selected up to five missing-field and five known-deferred examples per shop
  from shops 227, 228, 139, and 457 (37 selected). The indexed work-order cache
  had 32 matching raw copies, all with matching Header.LastModifiedTime.
- In those 32 pairs, 15 omitted the deferred field in both copies; 17 had
  matching nonempty deferred-package counts. No missing-to-nonempty mismatch
  or explicit-empty counterpart was observed.
- These cached copies are corroboration, not proof of an independent detail
  response: their endpoint lineage is not established by the cache lookup.
- The previously documented Swagger URL returned HTTP 401 without credentials.
  Public searches did not locate an authoritative empty-collection contract.
  The June 2026 internal list/detail probe supports rich invoice-list responses,
  but does not establish a general omission-means-empty guarantee.

No business-data Protractor API calls were made for this investigation. The
reporting rule remains unchanged. A provider contract or native invoice check
is still needed before treating omitted collections as definitively empty.

## Approved live invoice-detail comparison

On 2026-10-17, an operator-approved probe made exactly ten serial read-only
invoice-detail requests for shop 227, with retries disabled, bounded deadlines,
20-second spacing, and the existing shared transport safeguards. No reporting
data or provider records were written.

- Five omitted-field controls also omitted DeferredServicePackages on the detail
  endpoint. Their regular-package counts, sold-hour evidence, and modification
  timestamps matched the archived list response.
- Five known-deferred controls returned the same package IDs/counts (2, 2, 1,
  5, 2), regular-package counts, sold/presented-hour evidence, and modification
  timestamps as the archived list response.
- All ten reads completed successfully. A separate Render log-monitor timeout
  did not affect the probe; a bounded timestamp-window log read retrieved the
  completion and remaining results. No Protractor requests were repeated.

This rules out a list-vs-detail discrepancy in these samples. It supports, but
does not independently prove, the interpretation that an omitted collection is
empty. No native UI or provider-contract confirmation has yet been obtained, so
the reporting evidence rule remains unchanged.
