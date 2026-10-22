# Feed failure diagnostics and recovery — local verification

Production population remains paused. These changes were not deployed.
The initial local verification used no production access; the separately
approved feed-only diagnostic is recorded below.

## Changes

- Feed failures expose only an allowlisted category, fixed processing stage,
  event count and elapsed milliseconds. Raw error messages, stacks, driver
  fields, addresses, payloads and resume tokens are excluded.
- Categories distinguish timeout, network, server selection, authorization,
  cancellation, known PostgreSQL failures, history gaps and unknown errors.
  Unknown remains unknown; diagnostics do not prove that retry is safe.
- Existing gap handling, time budgets and durable token semantics are unchanged.
- A failed post-worker feed poll now reaches the operator rather than being
  hidden by the successful worker result. Committed inventory stays committed;
  the failure does not authorize an automatic retry or reader activation.

## Verification

`bash tests/run-reporting-projection-worker.sh` passed on disposable PostgreSQL
16.10, including installation/ACL tests. The harness strips ambient credentials
and denies network egress.

New cases exercise partial consumption followed by a timeout, unchanged durable
cursor and withdrawn freshness, recovery by a new consumer, exact replay,
freshness only after an empty poll, allowlisted classification, absence of
private error text from logs/results, and propagation of a post-worker failure.
Existing rollback-before-commit, interleaved-consumer, history-gap, backlog,
batching and reader-isolation tests also passed.

`npm run typecheck` passed after adding the explicit diagnostic union guard.

## Remaining production evidence

The earlier `stream_unavailable` result did not retain an error classification;
it cannot be diagnosed retrospectively from these changes. A separately approved,
bounded feed-only diagnostic run is the next evidence-gathering step. Such a run
writes reporting cursor/freshness/invalidation bookkeeping and can mark builds
failed on a confirmed history gap; it is not a read-only check. Keep population
and customer readers disabled during it.

## Approved feed-only diagnostic — 2026-10-22

Fresh production target/flag/permission/index and scoped-trigger checks passed.
The operator's feed-only path was syntax checked and exercised with a stub to
confirm that it returns before any population tick.

At 17:55:41 UTC the first poll stopped with `stream_unavailable`, category
`timeout`, stage `read_event`, zero events, after 1,257 ms inside the poll.
The overall diagnostic took about 1.4 seconds and stopped immediately rather
than spending the remaining 60-second/40-poll allowance on automatic retries.
The configured Mongo operation timeout is 1,000 ms. This establishes a read
timeout in this attempt, not its underlying network/server cause or the exact
cause of the earlier unclassified failure.

Independent readback at 17:55:51 UTC confirmed 8,495 documents / 8,505 identities,
unchanged inventory/channel 0, no failure/publication/reviews, and the durable
Mongo token still present with epoch freshness. Health: two active queries,
zero lock waiters/old idle transactions, all 44 scoped triggers enabled.
No invoice population, Protractor calls, deployment or migration occurred.
Readers and the shared builder switch remained disabled.

Receipts: feed-diagnostic-only-pilot-20261022.json,
feed-only-confirmation-20261022.json, and population-stopped-20261022.json in
the ignored reporting snapshot directory. Next work should test a bounded
feed timeout/retry policy locally, preserving total deadlines, exact replay
and immediate stops for history-gap/authorization failures; do not simply
restart population or remove freshness gates.

## Local bounded timeout/retry verification

The subsequent local-only change increases the feed operation timeout to 3,000 ms
and the per-poll event-loop budget to 3,500 ms. Feed catch-up passes its original
deadline into every poll. Mongo's operation timeout is clipped to that remaining
budget; `maxAwaitTimeMS` remains strictly smaller. No new event read is admitted
unless its operation timeout fits inside the outer deadline. Existing SQL and
cleanup operations remain separately timeout-bounded; this is not a promise of
instantaneous connection closure at the deadline.

Only the explicit `catchUp` entry retries, at most twice per invocation, for
allowlisted timeout/network/server-selection failures. Attempts consume the
same poll/time budget. Backoff of 100/200 ms occurs outside the transaction and
responds to cancellation. Each attempt reopens from the committed cursor.
Authorization, unknown errors, confirmed gaps and database transaction failures
are not retried. Ordinary inventory ticks still stop on feed failures.

Disposable PostgreSQL 16.10 installation/worker tests and TypeScript checking
passed. New tests cover two failures followed by recovery, retry exhaustion,
all retryable classes, authorization/unknown/gap immediate stops, a 1.1-second
successful read, caller deadline clipping (including below the normal await
duration), cancellation during backoff, pre-cancelled/expired admission, and
partial-consumption retry with exact replay and committed-event counts.

No live database access, population, feed polling, deployment, or shared flag
change occurred during this local implementation. A separately approved bounded
feed-only run is still required to establish behavior under production latency.

## Approved production feed-only test with new limits

2026-10-22 18:03:45 UTC: refreshed production target, flags, permissions, indexes,
scoped function and health checks passed. One authorized feed-only invocation
processed 4,000 committed events across 40 polls in 27,906 ms, returning
`draining` with zero retries. It stopped at the poll cap, not the time cap.
This demonstrates progress under the new timeout, not complete catch-up or
proof of long-run reliability.

Independent readback at 18:04:03 UTC confirmed unchanged inventory of 8,495
documents / 8,505 identities, no build failure/publication/reviews, durable
Mongo token present and epoch freshness (still not caught up). Health showed
two active queries, no lock waiters or old idle transactions, and all 44 scoped
triggers enabled. No population, Protractor calls, migration or deployment.
Shared builder and reader flags remained disabled.

The diagnostic-only and confirmation receipts contain this run. The preceding
failed diagnostic receipts were preserved as
feed-diagnostic-original-timeout-20261022.json and
feed-only-original-timeout-20261022.json in the ignored snapshot directory.
