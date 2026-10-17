# Reporting scope and invoice range verification

## Confirmed from code and isolated fixtures

- The enterprise resolver already intersected enterprise membership and user grants. A grant to a second enterprise did not itself widen enterprise scope.
- The page previously defaulted platform administrators to platform reporting. It now defaults to the active shop's enterprise when available, otherwise the shop; platform-wide reporting requires an explicit choice.
- Saved-report discovery previously included owned reports from other scopes. Discovery now matches the selected scope. Saved versions and delivery links retain their own stored scope rather than being rewritten.
- Legacy location filters now narrow all execution stages before querying, including comparisons and labor recovery. Independent `locationIds` are versioned with the definition and validated on every execution and result authorization. Omission preserves legacy “all authorized” behavior; empty and unauthorized explicit selections fail.
- The previous invoice query fetched up to 100,001 all-history headers. A fixture with 120,000 old verified records and ten relevant invoices now returns the relevant population plus unresolved identities. Out-of-range conflicting copies are retained. Unknown evidence is not close-date filtered or treated as zero.

## Operator-gated database rollout

No production database, provider, import, index or report rerun was performed.

The query remains deadline- and row-cap-bounded without new indexes, but can still scan historical headers. In the isolated PostgreSQL fixture the unindexed candidate stage took about 7 seconds. With the proposed indexes, EXPLAIN ANALYZE showed a bitmap date/unknown index scan and indexed identity lookups, about 5 ms execution for that fixture. This is not a production latency guarantee.

1. Inspect existing production `pg_indexes` and index validity before any approved change. No claim is made that production has these indexes.
2. Run `npx tsx scripts/print-invoice-report-indexes.ts` to **print**, not apply, matching index SQL.
3. With separate operator approval, review disk capacity and create missing indexes concurrently outside a transaction, one at a time. Check validity after interruptions; `IF NOT EXISTS` does not repair an invalid index.
4. Inspect a read-only EXPLAIN for an approved bounded shop/date range. Never disable deadlines or replace invoice dates with close dates.
5. If unknown evidence itself exceeds the cap, keep the explicit failure; data repair/import is a separate decision.

The partial-index predicate is shared with the query. Changing that predicate requires reviewing the index definitions in lockstep. The indexes use immutable JSON operations, not polymorphic JSON constructors.

## Production evidence still unavailable

No failing run identifier or exact request was supplied. The connected log application's name search returned no matching application. Therefore the user's actual enterprise, persisted run identity, membership at execution time, and failing stage are not confirmed. Do not describe the isolated bottleneck or the earlier mixed-metric SQL issue as proof of that run's failure. Operator follow-up should inspect the exact run and its redacted stage diagnostics, not rerun it.

## Checks

- `bash tests/run-report-execution.sh`: throwaway local PostgreSQL only, including actual invoice query plans and duplicate/date-conflict coverage.
- `tests/report-subsets.smoke.ts`: independent subsets, revocation, comparison execution and cache isolation.
- `tests/report-enterprise-scope.smoke.ts`: multi-enterprise assignments, stale session membership and explicit platform access.
- Existing compiler, invoice evidence, run cache, custom access and delivery checks preserve saved-version contracts.
- Offline browser fixtures use mocked APIs; they do not authenticate against or query production.

The invoice browser scenario and custom-report scenario each passed. A later
repeat of the invoice scenario failed to launch the local Chromium process
(startup timeout), rather than failing an application assertion. The signed-in
production page was not visually verified.

Completion regression tests also cover combined explicit subsets and narrower
location filters through the actual queue/worker path, empty-intersection
rejection before enqueue, and historical full-scope filtered-run retrieval with
revocation checks.
