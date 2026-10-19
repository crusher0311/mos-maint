# Permission-free fleet invoice reporting

Local implementation; disabled by default. No production reads, grants, repairs,
provider calls, deployment or activation were performed for this redesign.

## Why a separate path

The managed production role cannot set temp_file_limit. The existing SQL
aggregate still requires its spill guard and remains unchanged. The new
INVOICE_FLEET_STREAM_ENABLED path does not run that aggregate or relax its guard.
It uses a forward-only, non-holdable cursor over a simple location projection:
no sort, distinct, hash aggregate, join, scroll or materialized result. Parallel
query workers are disabled. Per-row alias extraction is bounded by source size.
Only identity, status and hour evidence are returned, never raw invoice payloads.

The same database-wide transaction advisory lock excludes other fleet reports.
One repeatable-read, read-only transaction covers every selected location.
Every query uses the existing cancellation wrapper and absolute report deadline;
starting a new location or page does not renew the deadline. No intermediate
location results are persisted on a failure.

## Budgets and tradeoffs

- 256 records per fetch.
- 100,000 records and 16 MiB serialized metadata per location.
- 500,000 records and 64 MiB serialized metadata for the entire report.
- 32 KiB per record, including a guard on source evidence before transmission.
- Existing absolute report deadline and statement timeout remain active.

The new fleet row allowance is deliberately larger than the old one-shot 100,000
row cap: only one complete location is retained at a time, rather than retaining
the entire fleet. The shared byte and row counters never reset between locations.
These are serialized-input budgets, not exact Node heap/RSS limits. Parsed objects
and identity maps incur overhead. Validate representative process RSS before
production activation. Row limits do not bound scanned database pages; a shared
deadline and single-report admission bound duration/concurrency, not total I/O.

Reading full locations provides complete same-location identity closure, including
out-of-range contradictory peers. It may reject a large individual location that
the old date-selective query could handle. It must never silently fall back to
another scan, combine partial pages, or publish partial fleet averages.

Missing source evidence still produces unavailable averages, not zeros.
Oversized, malformed or ambiguous evidence fails explicitly. No source repair is
performed by a report.

## Local verification

Run `bash tests/run-invoice-fleet-stream.sh`. For the retained private snapshot,
run the same command with `--snapshot`. The disposable server tests the reader
under a non-superuser role without SET permission and with temp_file_limit=0.
Only fixture construction/oracle work has an unrestricted spill setting.

Verified on local PostgreSQL 16:
- 120,000 verified invoices / ten shops: exact sold/presented totals.
- Retained 215,655-record snapshot: exact parity with independent raw-record
  location aggregation. 209,889 unknown identities, no eligible verified invoices,
  and unavailable averages for the tested reporting month.
- Both approximately 3 seconds locally; not a production latency claim.
- Authorization, deadline, oversize and late-failure rejection.
- Conflicting out-of-period invoice copy vetoes the average.

Before release: production PG17 plan/transport validation, end-to-end build,
representative RSS measurement, and one approved bounded live report. Hundreds
of cursor fetches can have materially higher latency across a real network.
Keep disabled until those pass. Existing saved reports are not retroactively
rewritten; request a fresh report after activation. No new database migration is
required. Source evidence preservation/repair is a separate release concern.

## Read-only production compatibility check — October 19, 2026

Verified against the database target used by the deployed web service, using its
actual runtime connection. PostgreSQL 17.6 accepted read-only repeatable-read
admission, 2 MB work_mem, disabled parallel workers and the shared transaction
lock, despite lacking permission to SET temp_file_limit.

EXPLAIN (without ANALYZE) for all ten JWT locations selected the existing
nwo_shop_id_idx plus the per-row function scan; no sort, aggregate,
materialization, parallel or sequential scan appeared. DECLARE / FETCH 0 / CLOSE
also succeeded through the actual connection. No invoice rows were fetched and
no report was executed. Both fleet switches remained disabled; no settings were
persisted and no grants, deployment or repairs were performed.

This establishes plan/permission/protocol compatibility, not live throughput or
coverage. A bounded report run, memory measurements and release validation
remain necessary.
