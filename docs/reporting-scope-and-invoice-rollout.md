# Reporting scope and invoice range verification

## Confirmed from code and isolated fixtures

- The enterprise resolver already intersected enterprise membership and user grants. A grant to a second enterprise did not itself widen enterprise scope.
- The page previously defaulted platform administrators to platform reporting. It now defaults to the active shop's enterprise when available, otherwise the shop; platform-wide reporting requires an explicit choice.
- Saved-report discovery previously included owned reports from other scopes. Discovery now matches the selected scope. Saved versions and delivery links retain their own stored scope rather than being rewritten.
- Legacy location filters now narrow all execution stages before querying, including comparisons and labor recovery. Independent `locationIds` are versioned with the definition and validated on every execution and result authorization. Omission preserves legacy “all authorized” behavior; empty and unauthorized explicit selections fail.
- The previous invoice query fetched up to 100,001 all-history headers. A fixture with 120,000 old verified records and ten relevant invoices now returns the relevant population plus unresolved identities. Out-of-range conflicting copies are retained. Unknown evidence is not close-date filtered or treated as zero.

## Operator-gated database rollout

The original implementation used isolated fixtures only. The approved production
index rollout on 2026-10-17 is recorded below; no provider call, import, data repair,
or saved-report rerun was performed.

The query remains deadline- and row-cap-bounded without new indexes, but can still scan historical headers. In the isolated PostgreSQL fixture the unindexed candidate stage took about 7 seconds. With the proposed indexes, EXPLAIN ANALYZE showed a bitmap date/unknown index scan and indexed identity lookups, about 5 ms execution for that fixture. This is not a production latency guarantee.

1. Inspect existing production `pg_indexes` and index validity before any approved change. No claim is made that production has these indexes.
2. Run `npx tsx scripts/print-invoice-report-indexes.ts` to **print**, not apply, matching index SQL.
3. With separate operator approval, review disk capacity and create missing indexes concurrently outside a transaction, one at a time. Check validity after interruptions; `IF NOT EXISTS` does not repair an invalid index.
4. Inspect a read-only EXPLAIN for an approved bounded shop/date range. Never disable deadlines or replace invoice dates with close dates.
5. If unknown evidence itself exceeds the cap, keep the explicit failure; data repair/import is a separate decision.

The partial-index predicate is shared with the query. Changing that predicate requires reviewing the index definitions in lockstep. The indexes use immutable JSON operations, not polymorphic JSON constructors.

## Approved production index rollout — 2026-10-17

The operator explicitly approved the three concurrent builds and read-only
verification for shop 227, October 1 through the current time.

Preflight against the explicitly configured external production database:

- `pg_indexes` showed none of the three names or equivalent expression/partial
  definitions. Existing indexes on close/completed dates are not equivalents.
- Database size was 434 GB; work-order heap 7085 MB, existing indexes 5759 MB,
  estimated rows 5,888,717.
- The supplied Supabase dashboard showed 73% disk use, 10% CPU, 36% RAM and
  healthy status. The operator confirmed 27% free disk. Exact free bytes and
  storage I/O throughput were not supplied; database size is not volume capacity.
- The immediate pre-build activity snapshot had 26 idle clients, two extension
  waits, and no other index builds. This was a point-in-time check, not sustained
  I/O monitoring.
- The unrelated `nwo_provenance_gin_idx` was already invalid but ready, at
  1748 MB. It was not dropped, rebuilt, or otherwise changed.

Applied the exact SQL from `scripts/print-invoice-report-indexes.ts`, one statement
per request outside transactions, using one connection, 15-minute statement
timeout, 5-second lock timeout, and no parallel maintenance workers. Stopped-on-error
behavior was retained; no retry or repair was necessary.

| Index | Build duration | Size | Valid / ready |
| --- | ---: | ---: | --- |
| `reporting_invoice_verified_date` | 104.963 s | 8192 bytes | yes / yes |
| `reporting_invoice_unknown` | 117.553 s | 40 MB | yes / yes |
| `reporting_invoice_identity` | 113.105 s | 40 MB | yes / yes |

Builds ran from 16:13:49 to approximately 16:19:25 UTC. A separate read-only
connection confirmed all three remained valid and ready.
`drizzle/0039_invoice_report_indexes.sql` preserves these definitions in the
canonical migration path's separate concurrent-statement list. The parity test
compares that SQL with the query module's operator SQL.

### Bounded production plan

Executed `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the unchanged
`INVOICE_HOURS_SQL`, shop IDs `[227]`, from `2026-10-01T00:00:00.000Z` through
`2026-10-17T16:19:47.304Z`. These are UTC invoice-date bounds. The connection used
read-only transactions, a 15-second statement timeout and a 1-second lock timeout.
The existing 100,001-row safety limit was unchanged. No customer rows were printed.

- Planning: **3.092 ms**; execution: **1879.708 ms**.
- Candidate scan used a bitmap OR of the verified-date and unknown indexes.
- Peer lookups used `reporting_invoice_identity` (19,399 loops, zero peer rows).
- Result: 19,398 rows, below the safety cap; no temporary blocks read or written.
- Shared buffers: 67,080 hits, 8,920 reads.
- The verified-date index contributed zero rows. The unknown index produced
  19,399 candidates before filtering. This is not 19,398 verified October invoices:
  unknown evidence intentionally remains independent of date bounds.

The global verified-date index had zero estimated entries after creation; the
unknown and identity indexes each had about six million. The rollout therefore
establishes valid indexes and actual planner use, **not invoice evidence coverage**.
No evidence population was repaired or imported.

A non-executing pre-completion EXPLAIN used `nwo_shop_id_idx` for candidate and peer
lookups. No pre-rollout execution timing was collected, so no production speedup
ratio is claimed. The 1.88-second result is one bounded observation, not a fleet or
end-to-end report latency guarantee.

Verification: `node --import tsx --test tests/invoice-report-index-parity.test.ts`,
`npm run test:invoice-hours`, and `git diff --check` passed. No application/UI code
changed, no app server was booted against shared production stores, and no
signed-in UI was verified.

## Original failed-report evidence still unavailable

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
