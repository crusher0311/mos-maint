# Stored-status classification experiment

## Targeted candidate trace and local date-scope hypothesis

A targeted 2026-10-18 trace selected three unresolved zero-number records per
shop **from the actual report SQL candidates**, plus the one in-period invoice
with incomplete hours. All 30 selected zero-number records had July/August
InvoiceTime values in matched stored WorkOrder/Invoice payloads. None had a
matching capture in the two inspected operator campaigns. This bounded,
deterministic sample is not a representative estimate of the full unknown set.
The dedicated invoice-cache collections were not reread by this targeted trace;
they were included in the preceding full reconciliation.

The incomplete-hours record has five deferred labor hours but omits the regular
ServicePackages collection in all inspected copies, including its positive-number
capture. Missing regular work is not evidence of zero sold hours; leave it held.

`--review-date-scope` (with stored reconciliation and credit separation) tests
only date eligibility, not new invoice or labor evidence. It accepts an explicit
nonnegative invoice number, final ordinary-invoice shape, bound GUID, and valid
actual InvoiceTime only when all matched copies agree. It excludes only
out-of-period records. Existing invoice evidence and reconciliation conflicts
remain untouched. Unknown or conflicting normalized peers veto exclusion,
including a peer on the other side of the date boundary. No fallback close,
creation, or completion dates are used.

Fixtures verify no change to ordinary invoice counts/hours, retention of
in-period unknowns and cross-period conflicts, and identical results after
resuming. This remains a local hypothesis, not a production policy change.

Completed ten-shop comparison on 2026-10-18 (214,899 copied records; report
period September 18–October 17 inclusive UTC):

| Local stage | Verified invoices | Unknown population | Invoices with complete hours |
| --- | ---: | ---: | ---: |
| Stored-evidence reconciliation | 6,259 | 11,313 | 6,258 |
| Separate reviewed credits | 6,259 | 10,002 | 6,258 |
| Exclude consistently dated out-of-period records | 6,259 | 152 | 6,258 |

The date experiment removed 9,850 out-of-period records from unknown population
without changing invoice counts or covered labor totals (6,757.11 sold hours;
13,608.82 presented hours, apart from floating-point summation noise).
All ten locations still have unresolved population, and both fleet averages
remain unavailable. The single incomplete-hours invoice also remains held.
These are comparisons within one run; source data changed between earlier
runs, so their differing invoice/credit counts are not experiment effects.
Zero provider requests and production writes; no deployment.

### Offline remainder inspection

The retained local copy reproduced 6,259 verified invoices and 152 unknown
records without reading external stores. The remainder consists of:

- 108 missing positive invoice numbers: 48 have mixed open/completed and
  invoice-stage snapshots; 60 have no recognized final invoice stage in the
  retained shape summaries (59 WorkOrder, one missing/other type).
- 30 conflicting-date records.
- 8 conflicting-evidence records.
- 2 conflicting-identity records.
- 4 conflicting-recorded-hours records.

All 152 normalized rows say `closed`; this does not resolve their source
contradictions. The single incomplete-hours invoice is additional to these
unknown records, not part of the 152. Shape summaries do not retain source
chronology or complete payloads, so they cannot prove that an open snapshot is
older than the invoice snapshot, or resolve disagreements. No additional rows
were reclassified. The offline inspector creates only temporary local objects
and checks that the report exactly reproduces the retained result.

### Targeted mixed-status chronology trace

Read-only inspection of all 48 mixed-status candidates found:

- Every record had a single consistent InvoiceTime across its inspected
  invoice-stage copies, before the September 18 reporting-period start.
- Every inspected non-invoice copy had a source Header.LastModifiedTime earlier
  than every matched invoice-stage copy for that record.
- No matching invoice captures were found in the two inspected operator
  campaigns. Dedicated invoice-cache collections were not reread by this trace;
  the preceding full reconciliation included them.
- Local cache updatedAt can be later than the actual source modification.
  Therefore local maintenance timestamps must not decide source chronology.

This supports testing a source-chronology-aware date exclusion locally, not
declaring these records newly verified invoices. It has not yet been applied to
the report: the measured unknown count remains 152. An exclusion policy would
still need per-copy identity binding, valid source timestamps, agreement among
final copies, and vetoes for equal/newer nonfinal snapshots and other conflicts.
The trace made no provider requests or production writes; typechecking passed.

### Local chronology experiment

`--review-chronology` adds a separate, opt-in local comparison after the strict
date-scope report. It preserves both strict and chronology reviews from the same
source reads, reruns the same report SQL, and asserts unchanged verified invoice
counts, labor coverage and totals. Normalized identity-peer vetoes still apply.

Earlier nonfinal copies must have the same provider identity, explicit zero
invoice number, a recognized work stage, no real conflicting invoice date, and
a valid timezone-qualified provider modification time strictly before every
final copy. Missing, equal, newer, malformed or contradictory source evidence
remains held. This is date-only exclusion; it does not establish sold hours or
new verified invoices.

Chronology unit tests, full disposable PostgreSQL regression/resume tests and
typechecking passed. The prior temporary database was no longer present when
validation resumed, so real-data verification requires a rebuilt read-only
preview rather than assuming the earlier 152-record result still applies.
No production reporting policy has been changed.

Completed rebuilt comparison on 2026-10-18: 215,060 stored records across all ten
shops, zero provider requests and production writes. Within this same run the
strict date-scope result had 152 unknown records; chronology reduced that to
106, a reduction of 46 rather than the projected 48. Do not report 104 as verified.
Both stages had 6,260 verified invoices, 6,259 with complete hours, 6,757.31
covered sold hours and 13,610.82 covered presented hours. Counts, coverage and
labor totals passed the unchanged-value assertions. Both averages remain null.
The one-invoice difference from the previous run reflects changed source data,
not the chronology experiment. Reporting is not yet fully verified or deployed.

## Local credit-document experiment

`--stored-reconcile --separate-credits` adds a local-only credit review. A record
is separated only when every matched raw/header copy is a final CreditSlip with
an explicit positive number, matching provider identity and consistent valid
invoice date. Ordinary invoice evidence vetoes credit exclusion. A second
normalized record sharing the identity also vetoes exclusion if its type is
unverified or its credit date conflicts, including across the reporting boundary.

The real invoice SQL runs first unchanged, then against a disposable local view
excluding only those reviewed credit records. Separate counts distinguish
in-period from out-of-period credit records. This does not net credits against
labor totals, change production SQL, change production work-order statuses, or
establish complete upstream coverage. Fixture tests cover both the unchanged
invoice totals and unknown/cross-date peer vetoes.

Completed real-data comparison on 2026-10-18 (214,776 copied records):
1,304 reviewed credit records separated, comprising 36 within the requested
period and 1,268 outside it. Unknown population fell from 11,306 to 10,002.
Ordinary invoice count stayed at 6,258; covered sold hours stayed at 6,756.61
and covered presented hours at 13,601.20. Coverage stayed at 6,257 invoices,
with one incomplete-hours invoice; both averages remained unavailable.
The remaining candidate diagnostics were 9,958 missing positive invoice numbers
and 44 conflicts. These unknown records are not proven in-period invoices.
No provider calls, production writes or deployments were performed.

## Header/source audit — 2026-10-18

Read-only audit of 214,740 normalized records and 502 digest-verified capture
pages across the ten JWT shops; zero provider requests and production writes.
Results describe sequential source snapshots, not a single fleet-atomic snapshot.

- 2,430 zero-number normalized WorkOrder/Invoice records dated in the reporting
  period matched positive-number captures by invoice identity and exact date.
  Another 522 matching records were outside the period.
- These are corroborated records, **not additional recovered invoices**. The
  previous reconciliation already used source captures; no report rerun was
  performed by this header audit and labor values were not compared here.
- CreditSlip appeared as the unsupported invoice-stage type: 34 normalized
  records dated within the reporting period and 1,263 outside it. The captures
  also included this type. Do not silently include credit notes in ordinary
  invoice counts or apply financial netting without a defined contract.
- 15,961 normalized rows had no usable projected raw header. Other stored
  sources were not exhaustively reconciled by this audit; this is not evidence
  that the payload is absent everywhere.

The audit does not authorize dropping the positive-number requirement globally.
Use independent capture evidence where available, reconcile contradictions, and
validate any separate credit-document treatment in the real local report first.

The optional local validator flags `--stored-reconcile --classify-uninvoiced`
compare the real report before and after classifying stored uninvoiced work.
This is not a production reporting-policy change or authorization to repair live
work-order statuses.

Every matched raw copy must have the correct provider identity, a recognized
uninvoiced workflow stage, a WorkOrder/Estimate type, an explicit zero invoice
number, and no recorded invoice date other than the provider's empty date sentinel.
Any stored invoice evidence, archive identity, or reconciliation conflict vetoes
classification. Missing fields and unrecognized stages remain unresolved.
This establishes only the state documented in stored snapshots, not provider
completeness or current upstream status.

Use `--keep-local` as the launcher's first argument to retain the private local
database on success as well as failure. The report baseline preserves original
statuses independently of the experimental local classification. Resume with
the same classification flags; the original evidence-only and classified reports
must reproduce without rereading completed shops.

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

## Native confirmation and local rule update

On 2026-10-17 the user confirmed that the two omitted-field examples checked in
Protractor had neither deferred nor declined work. The local invoice-hours
calculation now recognizes omission as an empty deferred collection only after
invoice identity, positive invoice number, invoice date, finality, and a regular
package collection have passed validation. Explicit null/undefined/malformed
deferred fields remain unknown. Missing hours and dispositions are not inferred.
The legacy labor-evidence calculation was not relaxed.

Recomputing the same archived sample locally now produces complete sold and
presented coverage for all 90 invoices:

| Shop | Invoices | Sold hours | Presented hours |
| --- | ---: | ---: | ---: |
| 227 | 26 | 28.80 | 47.82 |
| 228 | 32 | 50.75 | 112.72 |
| 139 | 18 | 18.15 | 29.42 |
| 457 | 14 | 75.80 | 127.00 |

Combined: 173.50 sold hours and 316.96 presented hours, averaging approximately
1.93 and 3.52 hours per invoice, respectively. These are local simulations for
one archived day across four shops, not a full-period production report.
Production evidence and cached report results remain unchanged. Existing
stored metadata still requires a separately authorized, guarded repair.

## Full-period disposable-database validation

`bash scripts/run-jwt-report-local.sh` creates a fresh loopback PostgreSQL cluster
marked as disposable. The validator refuses an unmarked target and has no apply
mode. Source PostgreSQL sessions default to read-only and each shop is copied
under a repeatable-read, read-only transaction with a ten-second statement limit.
Copying uses batches of 100 primary keys with pacing, not a long-running cursor
that mixes source reads and local insert round trips. The launcher removes the
temporary cluster after success. Failed or timed-out runs retain the stopped
private local cluster so completed shops can be resumed without re-reading
production. The launcher prints its temporary directory; resume with
`bash scripts/run-jwt-report-local.sh --resume-run /tmp/jwt-report-local.EXAMPLE --stored-reconcile`.
The overall validation limit is one hour; per-query production read deadlines
and pacing remain unchanged. Resume requires the same mode, verifies completed
shop row counts, recopies an unfinished shop, and restores the untouched
local reporting baseline before repeating before/after comparisons.

Scope is checked against the JWT enterprise's actual ten-member list. The period
is September 18–October 17, 2026, inclusive in UTC, matching the report being
investigated. Shops are snapshotted sequentially, not at one fleet-wide instant;
active imports can continue during the read-only exercise.

Only minimal reporting columns are stored locally. Customer/vehicle payloads
are not persisted. Invoice-source fields are evaluated in memory. Candidate
evidence can come from the stored raw invoice or digest-verified weekend
archives. Conflicting dates, identities, or recorded hours are withheld.
Explicit existing metadata is not overwritten. Archive evidence is not
manufactured for zero-number or otherwise invalid invoices.

The actual production invoice SQL runs against the disposable copy before and
after the local-only metadata update, including the existing row limit and
coverage rules. Per-location results are emitted as aggregates. An executable
offline integration test (`bash tests/run-invoice-local-preview.sh`) checks the
same pipeline against a second disposable source database, including unchanged
source rows, null raw payloads, archived evidence, conflicting hours, and unknown
populations withholding averages.

This is a candidate preview, not a production repair manifest. Production
application would additionally require fresh cross-store validation, compare-
and-set guards, an auditable manifest, and separate operator approval. Neither
a successful script exit nor a recoverable-row count proves the full report is
usable: the final report's cap, unknown population, and coverage must be checked.

The full-copy exercise exposed Protractor pre-invoice stages incorrectly counted
as unknown invoices. The local policy now excludes the explicitly mapped draft,
scheduled, checked-in, authorized, inspection, waiting, paused, and work-complete
stages when no verified invoice evidence exists. This is provider-specific;
closed/paid/invoiced/unknown statuses remain unresolved without invoice evidence.
Verified evidence still overrides a stale pre-invoice status. SQL and aggregation
share the policy; JSON-null evidence is not treated as a populated invoice.

A bounded follow-up check of 50 unresolved closed records from each of the first
three copied shops found 124 matching work-order-cache snapshots. All 124 lacked
a positive invoice number; none supplied usable invoice evidence. Their raw
dates included both the selected period and earlier dates, but unverified dates
were not used to hide records. This is a sampled diagnosis, not a full count of
the remaining source gap.

For subsequent verification without additional production reads, the baseline
can be retained as a mode-0600 temporary PostgreSQL dump containing only the
minimal copied reporting rows and candidate evidence. The capture checks all ten
shop counts and existing-evidence counts under an exported repeatable-read
snapshot before dumping. `scripts/replay-invoice-local.sh` restores that baseline
into another marked loopback cluster and runs the latest report SQL before and
after a local-only repair. A retention failure must not silently substitute an
already-repaired baseline. Delete the temporary dump when verification ends.

## Full-scope result, 2026-10-17

The completed ten-shop snapshot contained 214,229 records. There were no existing
invoice-hours metadata objects in this snapshot. The proposed local-only repair
populated 191,632 rows; 22,589 lacked recoverable evidence from the inspected
sources and eight were held for conflicts.

The latest SQL and status policy were replayed against the untouched retained
baseline:

| Measure | Before | After local repair |
| --- | ---: | ---: |
| Rows returned by bounded report query | 100,001 (cap exceeded) | 18,659 |
| Verified invoices in selected period | Not available | 1,824 |
| Unknown invoice population | Not available | 16,834 |
| Sold/presented covered invoices | Not available | 1,824 / 1,824 |
| Full-population averages | Unavailable | Incomplete data |

The unknown population includes historical closed records; it is NOT a count
of confirmed missing invoices in the selected month. Covered totals were
1,955.05 sold hours and 3,789.21 presented hours, but dividing them by the
verified subset would not produce a valid full-population average.

The production dashboard summary functions were checked against all ten actual
local-result rows and correctly returned "Incomplete data" for both averages.
Regression tests, the disposable-source safety test, and TypeScript passed.
No production repair, deployment, or additional provider request occurred.

Conclusion: metadata preservation and local repair fix the lost-evidence and
record-limit failures, but do not certify the full report. More authoritative
invoice-source evidence and review of held conflicts are required. Do not deploy
this as a completed reporting recovery merely because the scripts exited zero.

## Partial recovery archive validation, October 17 evening Central

A fresh read-only copy of all ten JWT shops evaluated the same September
18–October 17 UTC period. Recovery archive captures were cut off at
2026-10-18T01:19:34.390Z; the recovery continues independently. Existing weekend
archives were also evaluated with digest checks and the same identity/date/hour
conflict vetoes. This is not an end-of-recovery result or a provider completeness
reconciliation. Sequential shop snapshots now contained 214,245 rows, versus
214,229 in the earlier run.

Across 282 archive pages and stored raw payloads, the local-only repair proposed
196,009 rows, left 18,187 without recoverable evidence, and withheld 49 conflicting
rows. These are all-history storage counts, not selected-period invoice counts.

| Selected-period report measure | Earlier local result | Partial recovery result |
| --- | ---: | ---: |
| Verified invoices | 1,824 | 5,931 |
| Unknown invoice population | 16,834 | 12,486 |
| Invoices with complete sold/presented hours | 1,824 | 5,930 |
| Query rows after local repair | 18,659 | 18,419 |
| Full-population averages | Incomplete | Incomplete |

Covered totals were 6,553.53 sold hours and 13,351.35 presented hours, not full
population totals. One verified invoice at shop 233 still had incomplete hours.
Every location retained an unknown population, which can include historical
records outside the chosen dates; those records cannot be excluded without
authoritative date/identity evidence. The unchanged baseline still exceeded the
100,000-row limit before local repair.

The run completed with zero production writes and zero provider requests.
This demonstrates progress, not readiness to deploy or authorize a production
repair. Source data changed between runs, so the comparison is operational
progress rather than an identical-snapshot experiment isolating archive effects.

## Stored-data reconciliation mode

Run `bash scripts/run-jwt-report-local.sh --stored-reconcile` to compare the
stored PostgreSQL raw payloads with shop/identity-matched work-order caches,
normalized Mongo copies, invoice snapshots, full invoice caches, PostgreSQL
cache mirrors when present, and digest-verified capture archives. No provider
client is used and the operator-paused source recovery is not restarted.

Legacy Mongo invoice collections have only their `_id` index in the inspected
environment. This mode first builds an in-memory identity directory using
bounded `_id` keyset pages and a high-water mark, then reads matching payloads
by `_id`. It does not add indexes or repeat unindexed per-invoice lookups.
Exact case variants are used for the indexed work-order and mirror lookups;
unmatched mixed-case keys are not proof that a source copy is absent.

Identity, date and recorded-hour contradictions remain vetoes. A stale or
incomplete copy is not silently overwritten by whichever source is read last.
Rows with missing payloads are distinct from payloads without positive invoice
numbers. Existing normalized pre-invoice status exclusions remain unchanged;
an unverified historical date is never used to remove an unknown invoice from
the selected period.

Only minimal reporting rows and hashed-ID diagnostics are stored in disposable
local PostgreSQL. Diagnostics group missing identity, missing payload, missing
positive invoice number, invalid identity/date/finality, conflicts and verified
incomplete hours. Candidate-row counts are not deduplicated invoice counts.
The source stores can change during this read-only run; it is not a fleet-wide
atomic snapshot or a guarantee of complete upstream history.

Offline checks cover invoice-cache-only recovery, source read-only enforcement,
actual report SQL, and identity/date/hour conflicts. A successful test or script
exit does not authorize production metadata repair or deployment.
