# Controlled fleet invoice aggregation

## Local implementation

The reporting service now has an opt-in database-side aggregation path.
`INVOICE_FLEET_AGGREGATION_ENABLED=true` selects it for invoice execution plans;
unset/false preserves the existing capped raw-row path. No environment setting
was changed during implementation. This is server configuration, not a report
request or client-controlled option.

The core implementation is in lib/invoice-fleet-aggregation.ts. The former
prototype module now only re-exports compatibility names for its offline tests.

## Execution contract

- Validate 1–200 unique authorized location IDs before opening a transaction.
- Require a transaction; reject an injected bare query that bypasses admission.
- Set the transaction read-only. Use 2 MB work_mem per operator,
  hash_mem_multiplier=1, 64 MB temp_file_limit, zero parallel workers,
  1-second lock_timeout and a 5-second idle-in-transaction timeout.
- Acquire one nonblocking transaction-scoped advisory lock for this lane across
  all processes using the database. Busy requests fail explicitly and can be
  retried; they never bypass admission or fan out into location queries.
- Retain the absolute 45-second report deadline, including pool wait. Each
  statement gets at most 35 seconds or the remaining deadline, whichever is
  shorter. Stage timeout calls the database query's cancellation hook.
- Hold admission through query completion/transaction cleanup, not an app-side
  promise timeout. Commit, rollback and connection loss release the database
  lock. No manually cleared leases.
- Return only location totals. Permission, resource, unsupported-evidence and
  incomplete-result failures publish no new totals and do not retry unrestricted.
- Use stored invoice metadata only: no cache recovery, provider calls, metadata
  repair, migration, or new production index.

Memory is per operator, not a claim of 2 MB total PostgreSQL memory.
The spill limit is per backend, not a table-scan cap. Read-only aggregation can
still be expensive; production plan review and monitoring remain mandatory.

## Evidence and delivery

Same-location/provider identity peers, including out-of-range copies, remain in
the calculation. Conflicting dates remain unknown; missing or inconsistent
hours veto each average independently. Ambiguous alias lists or unsupported
evidence shapes fail the report explicitly, rather than masquerading as a
100,000-record cap or selecting a row-order-dependent winner.

The existing compiler, saved-result projection and dashboard fields are used.
Tests exercise the enabled path through the compiler and preserve its invoice
counts, raw totals, coverage flags and weighted averages. Existing saved results
are not silently rewritten by changing the configuration.

## Local verification

- Disposable PostgreSQL: concurrent admission rejection across two connections,
  read-only write rejection, lock release after commit, write failure and actual
  SQL timeout.
- 210,000-record fixture executes through the actual admission wrapper under the
  tested resource settings; an oversized single location is also checked.
- A mixed fixture with 8,000 verified invoices and 8,000 alias representations
  verifies exact counts and averages under the same settings. Alias expansion
  is materialized before identity joining to avoid a quadratic same-shop join.
- Service/compiler: enabled results, default legacy path, no cache recovery,
  authorization before SQL, expired requests, cancellation, denied settings,
  busy lane, and unsupported evidence.
- Full TypeScript check, final isolated production compilation (exit 0), and
  offline dashboard browser checks passed. Production credentials and network
  access were excluded from the build. Signed-in production UI and actual
  customer report results were not tested.

## Before production enablement

1. Review the exact release candidate and completed production build.
2. With separate authorization, verify the production reporting role can enforce
   every setting (notably temp_file_limit); do not grant privileges or drop a
   limit automatically. Review the query plan/index availability and load.
3. Approve a bounded monitored trial, including concurrent scheduled-report
   behavior. A busy scheduled report currently fails explicitly rather than
   introducing a new retry scheduler.
4. Validate the requested period against authoritative stored evidence. Missing
   source/accounting corroboration remains independent of this code change.
5. Obtain separate deployment/activation approval. Disabling the setting sends
   future requests to the original bounded path; it does not cancel a transaction
   already admitted or rewrite saved reports.
