# Feed failure diagnostics and recovery — local verification

Production population remains paused. These changes were not deployed, and
no production database queries, feed polls, migrations, or Protractor calls
were run during this local work.

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
