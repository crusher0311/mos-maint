# Reporting index package

## Production installation record — 2026-11-01

All six listed indexes were installed sequentially and verified. The final
service-job index completed at 16:41:36 UTC after approximately eleven minutes.
PostgreSQL indexes were checked valid and ready; Mongo definitions were read back.
Production queue/refresh queryPlanner checks used indexes without COLLSCAN.
The final health probe returned healthy in 133ms, with 43 PostgreSQL connections,
zero PostgreSQL lock waiters, zero Mongo queued operations and no remaining
PostgreSQL index build. Disk/CPU/I/O health was operator-confirmed before starting.

No worker activation, report population, projection activation, or deployment
was performed. Future installation attempts must still inspect fresh catalogs
and skip equivalent valid indexes; this record is not current health evidence.

Generate reviewed statements with `node scripts/reporting-index-package.cjs`.
This command is print-only and has no database imports, credentials or writes.
Do not pipe its mixed SQL/mongosh output into a database client.

## Exact scope

Mongo `mos-maintenance-mvp.report_runs`:
- `report_queue_claim`: status, queuedAt, attempts.
- `report_queue_recovery`: status, heartbeatAt, queuedAt, attempts.
- `report_active_refresh`: status, refreshEnabled, lastViewedAt descending, generatedAt.

PostgreSQL public schema:
- normalized_payments(shop_id, work_order_id).
- normalized_service_jobs(shop_id, work_order_id).
- viewed_vins(shop_id, last_viewed_at).

These match existing queue and reporting predicates. No query, cache, access,
data population, projection review or feature-flag changes are included.
Recommendation events already has an equivalent index under another name.
Do not run the whole older reporting migration and create that duplicate.

## Approval and fresh preflight

Production installation requires separate approval. Before each build:
verify target database, fresh catalog definitions (not only names), PostgreSQL
valid/ready flags, available disk, replication lag, connection pressure, active
queries/index builds and foreground response latency. If health metrics are
unavailable, stop rather than presume health.

Skip an equivalent valid index, even under another name. A same-name invalid or
different index is a stop condition: do not automatically drop or overwrite it.
The package intentionally omits IF NOT EXISTS to avoid hiding invalid indexes.

## Sequential installation and stop conditions

Execute one statement at a time; never parallelize Mongo and PostgreSQL builds.
PG uses CONCURRENTLY outside transactions, 2-second lock timeout and 20-minute
statement timeout. Mongo uses a 20-minute command maxTimeMS. These are ceilings,
not promises that cancellation leaves no partial index or running operation.

Monitor the exact build and system health while it runs. Stop starting further
indexes on any timeout, error, replication alert, resource alert or foreground
latency degradation relative to the preflight baseline. Investigate and obtain
approval for cleanup; inspect server-side state after client disconnects.
Never automatically retry an ambiguous or timed-out build.

After each build, verify catalog state and recheck health. Use EXPLAIN without
ANALYZE/queryPlanner first. Any production execution-statistics test needs its
own bounded scope. Do not force hints merely to obtain a favorable plan.

## Evidence and limitations

The tests use new disposable databases with no application credentials:
`node --test tests/reporting-index-package.test.cjs` and
`bash tests/run-reporting-index-postgres.sh`.

Mongo tests compare identical queue/refresh results before and after indexes,
including exhausted retries and stale-running eligibility, and inspect work
examined. PG tests install actual concurrent indexes and inspect planner use.
Synthetic fixture timings are not production latency guarantees.

This package does not finish the unpublished invoice projection, add daily
summaries, remove expensive calculations, or activate the dedicated worker.
