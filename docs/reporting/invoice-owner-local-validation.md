# Invoice-owner local validation

## Scope and safety

This is a local simulation, not a deployed fix or a production repair.
`scripts/run-invoice-owner-report.sh` creates and removes a marked disposable
PostgreSQL database. Its companion TypeScript script reads a bounded owner
closure from existing normalized PostgreSQL/Mongo source copies, makes no
provider requests, and performs no production writes.

`/tmp/invoice-owner-closure.json` is a prerequisite, not durable evidence. On
October 19 it was absent, as was the earlier full-fleet dump. Both the seed
identity preview and owner closure were recreated from bounded, read-only
source queries; the resulting closure still contained 26 parents and 329
children. The validator fails closed on changed parents, work-order numbers,
child counts, immutable child hashes, unexpected inbound foreign keys, or caps.

To reproduce (requires the existing source credentials and local PostgreSQL
tools; never substitute a production target for the marked local database):

```sh
umask 077
node --import tsx scripts/trace-invoice-identity-links.ts --repair-preview \
  > /tmp/invoice-identity-repair-preview.jsonl
node --import tsx scripts/preview-invoice-owner-closure.ts
bash scripts/run-invoice-owner-report.sh
```

The fleet is JWT's ten locations, **227–236**, not all shops on the platform.
All fleet report columns, parent payloads, and dependent financial rows are read
in **one PostgreSQL repeatable-read, read-only transaction**. Source concurrency
is one; statements have a five-second timeout. Snapshot capture is capped at
100,000 rows per shop / 500,000 total and uses 250-row batches with 50 ms pauses.
The actual report's 100,000-row cap is checked, not silently truncated.

Additional evidence comprises the work-order cache and normalized Mongo mirror,
plus retained pages from `protractor-weekend-2026-10-17` and
`invoice-evidence-recovery-2026-10-17`. Archive reads use indexed campaign/shop
ID ranges, five-page batches, five-second limits, at most 2,000 pages per
campaign/shop, a capture cutoff, and digest verification. Cache/mirror lookups
use existing indexes and fail at 101 matches. These are **sequential Mongo
reads, not an atomic snapshot across Mongo and PostgreSQL**; retention gaps
cannot prove that a provider invoice never existed.

Child validation independently compares every retained occurrence using the
current normalization rules and PostgreSQL decimal scales. Conflicts and
stored/source mismatches are reported, not overwritten. A local before/after
copy preserves stored financial values, checks parent foreign keys and
line-to-job ownership, and compares all rows. This is not a production repair.

## Earlier cohort-only result — October 19, 2026

- Original combined records: **26**.
- Separated provider identities: **36**.
- Previously structurally validated children: **329**.
- Owners with complete invoice-hours evidence in the inspected copies: **26**.
- Owners still lacking positive invoice-number evidence: **10**.
- Verified owners with presented hours exceeding sold hours: **11**.

The actual report SQL was executed against the disposable database.

For September 18–October 17:

| Measure | Original cohort | Separated-owner preview |
| --- | ---: | ---: |
| Verified invoices within period | 0 | 0 |
| Unknown invoice population | 26 | 10 |

All 26 verified invoice dates are outside this requested period. The result
does not mean 26 new invoices were imported or that fleet-wide unknowns fell by
16: the earlier full-fleet snapshot is no longer present, and this is a new,
cohort-only read.

An all-date control also checked financial totals rather than only date
exclusion:

- Verified invoices: **26**.
- Sold hours: **34.37**.
- Presented hours: **60.20**.
- Difference: **25.83 hours**.

Report totals matched the reconstructed owner-specific source evidence within
numeric tolerance. Averages correctly remain unavailable because ten identities
are unresolved. Stored-copy, owner-structure and invoice-report regression
suites passed. No latest-copy override, fabricated zero hours, cross-owner
evidence transfer, or automatic financial repair was used.

## Earlier remaining prerequisites

1. Cross-check the ten unresolved identities and the reconstructed evidence
   against additional stored archives/caches; keep conflicting or missing
   evidence unresolved.
2. Validate child financial-row ownership and values end to end, beyond the
   existing structural preservation simulation.
3. Recreate a disposable full-fleet snapshot and compare the complete report
   within that same run. Do not mix totals from different source snapshots.
4. Production repair and release require separate approval.

## Completed broader validation — October 19, 2026

This section supersedes the earlier prerequisites and cohort-only inference.
The final source transaction began at **2026-10-19 03:10:09.566176 UTC**,
snapshot `390653630:390653630:`. Its 215,060 work orders were copied into a
marked disposable PostgreSQL database. Before and after use that same copy;
only the 26 reviewed parent rows are replaced by the 36 proposed owners.
The local database was removed after the run.

### Retained evidence and unresolved identities

The additional scan validated **176 archive-page digests / 4,357 payloads**:
60 / 1,350 for shop 227; 58 / 1,444 for 229; 58 / 1,563 for 230. The capture
cutoff was `2026-10-19T03:09:58.403Z`. There were **14 matching archive
payloads** and **10 work-order cache copies** for the cohort.

The 26 previously reconstructed owners remain complete: **34.37 sold hours,
60.20 presented hours**, all outside September 18–October 17. The real
all-date report agrees with these source totals; 11 have deferred hours.
Their additional archive match count was zero, so this is not independent
archive corroboration of all 26.

The ten held owners remain held, but the reason is now more precise:

| Shop | Hashed owner prefix | Strict disposition |
| --- | --- | --- |
| 227 | bb6dc7cdf30b | conflicting date |
| 227 | 500d59b47754 | conflicting date |
| 227 | 3df04f89c259 | conflicting date |
| 227 | b72ea7beba2b | conflicting date |
| 227 | b6732de57586 | conflicting date |
| 229 | e6b4347cecc5 | conflicting date |
| 229 | 802b3a9c7413 | conflicting date |
| 229 | a4669b01d5fb | conflicting date |
| 230 | ee84324aca81 | missing positive invoice number |
| 230 | 556c652c1135 | missing positive invoice number |

Eight now have matching archived evidence, but their retained copies disagree
on date. No latest-copy choice or older-sentinel exception was enabled.
The two remaining owners have no matching archive evidence in the scanned
campaigns. Missing evidence is not proof of a non-invoice.

### Child ownership and money

All **329** stored children survive the local owner reassignment with **zero
changed financial projections, missing/duplicate rows, or broken parent/job
links**. Immutable full-row hashes were also checked against the fresh closure.
This preservation test is separate from agreement with retained source values:

| Child table | Total | Normalization projection matches | Stored/source mismatch | Retained-copy value conflict |
| --- | ---: | ---: | ---: | ---: |
| Service jobs | 136 | 59 | 70 | 7 |
| Line items | 169 | 3 | 149 | 17 |
| Payments | 24 | 24 | 0 | 0 |
| **Total** | **329** | **86** | **219** | **24** |

“Matches” means comparison using the current adapter's normalization rules,
not proof that every provider-native financial field is complete. Missing and
zero remain distinct. In particular, the 149 line mismatches all involve
discountAmount; overlaps also include laborRate (64), unitCost (60),
laborHours (5), extendedPrice (4), and unitPrice (4). Job mismatches include
laborHoursBilled (59), total (48), partsTotal (40), laborTotal (24).
The 24 copy conflicts affect 17 lines and seven jobs; no copy was selected to
overwrite another. Counts of fields overlap and must not be added as row counts.

Stored totals preserved **before = after**, not proposed corrections:

| Field | Before | After | Rows with unknown value |
| --- | ---: | ---: | ---: |
| Job total | 730.07 | 730.07 | 0 |
| Job labor total | 339.95 | 339.95 | 0 |
| Job parts total | 390.12 | 390.12 | 0 |
| Job billed hours | 7.95 | 7.95 | 123 |
| Line extended price | 9,784.99 | 9,784.99 | 0 |
| Line labor hours | 46.82 | 46.82 | 87 |
| Payment amount | 9,276.53 | 9,276.53 | 0 |

These child totals are not interchangeable with invoice labor evidence. They
include different dispositions and incomplete normalized fields. The mismatch
between job, line and payment totals is a blocker, not a balancing adjustment.
There is **no approved child financial rewrite**.

### Exact report comparison: September 18–October 17

The unchanged **fleet-wide real report SQL returns 100,001 rows before and
after**, triggering its existing 100,000-row cap. Both actual fleet summaries
are therefore **unavailable**, not zero. No cap or production index was changed.

For a complete offline diagnostic, the same SQL was run separately for every
location within the same local snapshot. Each location stayed below the cap.
The union was passed through the real report aggregator, not a substitute
invoice calculation:

| Measure | Before | After owner preview |
| --- | ---: | ---: |
| Full-fleet SQL summary | capped / unavailable | capped / unavailable |
| Diagnostic location-union rows | 209,294 | 209,278 |
| Diagnostic verified invoices in period | 0 | 0 |
| Diagnostic unknown invoice population | 209,294 | 209,276 |
| Diagnostic covered sold / presented hours | 0 / 0 | 0 / 0 |
| Diagnostic sold / presented averages | unavailable / unavailable | unavailable / unavailable |
| Cohort-only unknown population | 26 | 10 |

Zero **verified** invoices is not evidence of zero business activity: the
overwhelming majority lack usable stored invoice evidence. This run did not
reapply earlier temporary full-fleet evidence proposals that are no longer
available. The diagnostic is not the capped application report.

| Shop | Snapshot work orders | Unknown before | Unknown after |
| --- | ---: | ---: | ---: |
| 227 | 19,470 | 18,975 | 18,970 |
| 228 | 23,643 | 22,944 | 22,944 |
| 229 | 24,973 | 24,398 | 24,395 |
| 230 | 24,604 | 24,039 | 24,029 |
| 231 | 26,153 | 25,316 | 25,316 |
| 232 | 19,467 | 18,914 | 18,914 |
| 233 | 34,814 | 33,844 | 33,844 |
| 234 | 14,313 | 13,916 | 13,916 |
| 235 | 17,309 | 16,916 | 16,916 |
| 236 | 10,314 | 10,032 | 10,032 |

The 18-population reduction differs from the 16-row reduction because of the
report's identity/peer handling: shop 230's after-query has 24,031 rows but
24,029 unknowns. Do not describe this as 18 imported or repaired invoices.

### Remaining blockers and checks

- Ten identities remain unresolved: eight date conflicts, two missing positive
  invoice numbers. The retained campaign scan is bounded, not all provider history.
- 219 children differ from their source projections and 24 have conflicting
  retained values. Structural preservation does not establish financial correctness.
- Fleet-wide application reporting remains capped; even the exhaustive offline
  diagnostic has 209,276 unknowns and cannot produce reliable averages.
- Mongo evidence is not atomic with the PostgreSQL snapshot.
- Production repair, evidence-policy relaxation, provider calls, deployment,
  backfill changes and production indexes require separate approval.

Passed: `npm run typecheck`, `npm run test:invoice-hours`,
`tests/invoice-stored-evidence.smoke.ts`,
`tests/invoice-owner-repair-model.smoke.ts`,
`tests/invoice-owner-financial-audit.smoke.ts`, and the disposable
`scripts/run-invoice-owner-report.sh` run. No application UI was changed or
started for this database-only validation. Production writes and provider
requests: **zero**.
