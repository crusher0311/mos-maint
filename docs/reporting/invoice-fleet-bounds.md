# Large-fleet invoice evidence bounds

The application retains the existing single-query 100,000-order budget and
45-second request deadline. The SQL returns at most 100,001 rows (one overflow
sentinel), including same-location identity peers outside the requested period.
Neither SQL limit has been raised; no production index or database change is
part of this work.

An overflow now returns explicit capped coverage rather than rejecting the
entire report. `invoiceEvidenceCapped: 1` survives custom-report projection and
saved delivery. Eligible invoices, unknown population, covered hours, coverage
counts and both averages are null. The dashboard and shared report renderer
explain the limit and suggest fewer locations. No cache recovery runs on the
truncated rows. Normal query failures and deadlines still fail explicitly.

The sentinel is a count of returned representations, **not** an exact count of
unknown invoices or a lower bound. Unseen identity peers could resolve unknowns,
introduce date conflicts, or invalidate hours. Thus even apparently complete
locations within a truncated fleet result are withheld.

## Per-location assessment

Identity reconciliation is scoped by location and provider. Complete,
independently queried location closures can be combined by summing counts and
raw hours, not by averaging location averages. Out-of-range peers must remain
in each query. Unknown populations and independent sold/presented coverage
vetoes continue to block averages.

This is implemented **only in the offline owner-validation diagnostic**.
Its existing fixed ten-location snapshot runs one capped query per location,
with the existing statement timeout; it retains summaries rather than an
unbounded union of fleet rows. Any capped location makes the fleet diagnostic
capped too. Scope membership and complete location coverage are checked.

A live per-location fallback is deliberately not enabled: it could multiply
the existing total row/query budget by the authorized fleet size, even when
each individual query is bounded. A future exact large-fleet implementation
needs a separate resource-budget design and identity-preserving SQL aggregate
validation. The offline snapshot's 209,294 versus 209,276 unknowns do not imply
valid averages or justify a larger live cap.

## Offline checks

`npm run test:invoice-owner-offline` uses a credential-free Unix-socket-only
disposable PostgreSQL instance. Its large-fleet fixture includes 210,000 unknown
orders, an out-of-range conflicting invoice peer, and an unauthorized location.
It verifies capped fleet output, exact complete-location diagnostic unknowns,
unavailable averages, scope rejection, and a single oversized location.

`npm run test:invoice-hours` checks the actual service/compiler capped path,
no extra queries or recovery, projected coverage flags, display semantics and
existing strict evidence policies.
