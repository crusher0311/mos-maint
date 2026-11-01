# Dedicated reporting queue: local implementation, not activated

## What this addresses

General reports previously claim one run per minute through the web cron.
The dedicated process consumes both general and Tire DOT queues sequentially,
alternating first priority each cycle. It yields one second while busy and ten
seconds on idle/failure. Tire reports keep ten-page/15-second between-page bounds.
General reports retain their existing five-minute query deadline, so a slow
query can still delay the other queue. This is not a universal latency guarantee.

No provider collection, migrations, cache-key changes, scope widening or data
repair is part of this release. Existing per-requester cached results, pinned
versions, authorization, coverage exceptions and refresh admission are retained.

## Coordinated rollout (requires approval)

1. Release the code with REPORTING_QUEUE_WORKER_ENABLED absent everywhere.
   Existing processing continues; HEART gains its local batching improvement.
2. Stage one dedicated worker, with the existing application's required database
   configuration, running:
   `node --import tsx scripts/report-queue-worker.ts`
   Use the same server-only preload convention as the existing production worker
   if required by that runtime. Do not run this against shared stores from dev.
3. Enable REPORTING_QUEUE_WORKER_ENABLED=true on that worker and confirm it is
   healthy. Then set the same flag on the web service and HEART collection worker.
   This disables their report execution, but preserves scheduled refresh
   admission and source collection. Brief overlap uses existing atomic claims;
   do not scale worker replicas as a substitute for query optimization.
4. Verify queue delay, completion duration, database load and foreground latency
   with one single-shop and one enterprise report. Compare results, including
   exception counts, against pre-release output. Test cached, saved-version,
   pinned delivery and revoked-access paths.
5. Keep a graceful termination allowance for the existing five-minute general
   query bound; shutdown stops new claims, not in-flight database writes.

Rollback: suspend the dedicated worker and unset the flag on the web and HEART
services. Persisted queue state remains available to the existing processors.

## Remaining work

This release removes scheduling gaps; it does not make every query fast.
Measure each report family with realistic volumes before promising SLAs.
Projection-backed invoice summaries already exist but require their separately
reviewed production installation/activation. Do not enable them as part of this
worker rollout. Detailed DOT extraction still reads the pinned evidence;
incremental summaries must preserve repeated DOT occurrences and exceptions.

## Local verification

Queue/Tire DOT focused tests: 17 passed. Existing report-run cache smoke and
subset/revocation checks passed. Disposable PostgreSQL execution/persistence/
retry/reopen and the 120,000-row date-range fixture passed.

The combined execution script later failed in the unrelated Protractor history
fixture: it expects `invoice_preview.disposable=yes`, which the script does not
set. The full TypeScript check exceeded the 120-second local limit without
diagnostics. Neither is recorded as a passing release gate. No live latency or
signed-in UI verification has been performed for this change.
