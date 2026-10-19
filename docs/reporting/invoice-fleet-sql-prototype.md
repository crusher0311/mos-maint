# Offline database-side invoice aggregation assessment

## Status

**Superseded for integration status:** the assessed SQL is now in the core
reporting library behind default-off activation and transaction admission.
See invoice-fleet-integration.md. The assessment below records the prototype
stage, not the current integration state.

An offline prototype now exists in scripts/invoice-fleet-sql-prototype.ts.
It is not imported by the production reporting path. The live raw-row cap,
cache recovery, saved reports, delivery behavior, indexes and permissions are
unchanged. This is feasibility evidence, not a release-ready replacement.

## Budget assessed

The disposable PostgreSQL test uses one connection, a 10-second statement
timeout, 2 MB work_mem per operator, a 64 MB temporary-file cap, and no parallel
query workers. The result is limited by validated scope to at most 200 location
rows. The application never receives the raw identity closure. There is no
per-location retry or live query fan-out.

The first implementation exceeded the temporary-file limit on the large fixture.
Removing a redundant materialized closure and unused columns let the same
fixture pass without raising the budget.

These settings are not a measurement of peak database RAM or a fleet-wide
concurrency limit. They do not bound the number of table pages PostgreSQL scans.
Production eligibility still requires a concurrency/admission design, confirmation
that its reporting role can enforce the settings, query-plan measurements, and
an overall deadline including connection wait and cancellation cleanup. Do not
interpret a fast disposable fixture as a production performance guarantee.

## Verified

- 210,000 unknown orders plus an out-of-range conflicting peer return ten rows
  totaling 210,001 unknown identities, not a fabricated average.
- The same data concentrated in one oversized location gives the same exact
  result without paging.
- Results agree with the existing complete-location diagnostic.
- Tests also compare real owner fixtures across all-date and selected-period
  ranges, including soft deletion, missing evidence and location boundaries.
- Duplicate copies are not double counted; missing presented hours and
  conflicting sold hours veto their respective averages independently.
- Weighted averages use raw totals, not averages of location averages.
- Unauthorized and duplicate requested locations and incomplete results fail.
- Competing alias lists and unsupported evidence versions return unavailable
  totals rather than choosing a winner or silently discarding evidence.
- A one-millisecond timeout cancels the query rather than returning partial totals.
- The offline suite and full TypeScript check pass.

## Deliberate limitations before integration

The existing JavaScript unknown-identity map can overwrite alias lists for the
same first identity depending on row order. The prototype refuses conflicting
alias lists instead of choosing a winner. Noncanonical invoice evidence is also
unsupported; it must not be silently interpreted as zero hours or zero invoices.
These rejection paths have dedicated fixtures, but still need explicit
product-facing semantics before live integration. The prototype's capped-result helper is only
an unavailable-value carrier, not permission to label these cases as a
100,000-record overflow.

The prototype uses stored invoice metadata only, not Mongo cache recovery. A
future integration must make that coverage distinction explicit and cannot
silently introduce provider fetches or production metadata repairs.

Next: harden malformed/ambiguous evidence cases and validate the transaction
resource/admission wrapper before connecting this to the service. The separate
accounting corroboration remains necessary; this query does not repair source
evidence or establish trustworthy averages for the actual fleet.
