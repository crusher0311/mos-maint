# Production source-index prerequisite check

Read-only observation: October 22, 2026, 13:28:48 UTC. Live Render configuration
was matched to the external PostgreSQL endpoint without logging credentials.
Both shared reporting switches were off. No deployment, population, source scan
or index installation occurred. Plans used EXPLAIN, **not ANALYZE**.

## Catalog and plans

| Source | Estimated rows | Table + TOAST GiB | Existing indexes GiB |
|---|---:|---:|---:|
| normalized_work_orders | 6,034,275 | 46.68 | 6.11 |
| normalized_service_jobs | 18,674,688 | 41.22 | 17.20 |
| normalized_line_items | 38,325,384 | 81.77 | 15.33 |
| normalized_payments | 833,270 | 1.30 | 0.24 |
| protractor_work_orders | 0 | <0.01 | <0.01 |
| protractor_invoices | 0 | <0.01 | <0.01 |
| protractor_invoice_cache | 0 | <0.01 | <0.01 |

Rows are catalog estimates, not counted populations. The three provider caches
have minimal physical storage; their sequential scans are not themselves a
performance concern at this size. This says nothing about retained Mongo copies.

All shop/key columns are NOT NULL and protected by global-ID or composite
shop/key unique indexes. No source has the matching C-collated cursor index.
Existing ordinary ID indexes are not interchangeable with the expression's
collation. First and next plans on each populated source sort shop-filtered rows;
exact lookup and the payload join also lack the desired composite access path.
The proposed query alone is therefore not safe to advertise as fast in production.

Database size reported by PostgreSQL: 460.82 GiB (includes other application data).
No index build was reported by pg_stat_progress_create_index at observation time.
This is not an assurance of idle workload or disk headroom.

## Proposed staged approach — not authorized for execution

1. Verify current Supabase volume capacity/free space and live memory, I/O and
   connection health. PostgreSQL database size alone cannot establish free disk.
   Include final indexes, temporary build space and WAL in the headroom review.
2. Review equivalent/invalid indexes again immediately before each operation.
   Do not execute the seven-statement candidate wholesale.
3. Build one approved matching index at a time, with a separately agreed
   statement deadline and maintenance window, bounded maintenance memory,
   independent health probes and native cancellation. Start with work orders
   to unblock the first channel; larger jobs/line-items builds follow only
   after validating impact. Do not guess a duration from local fixture timings.
4. Verify index validity and first/next/exact plans after each build. Do not drop
   unrelated indexes or disable invalidation triggers.
5. Resume only a separately approved bounded population with customer reads
   still disabled. Mongo source performance, evidence reviews and verification
   remain independent gates; indexes alone cannot produce a verified report.

The candidate SQL is `scripts/reporting-projection/source-indexes.sql`.
Detailed sanitized catalog/plan evidence is retained locally under
`generated-artifacts/reporting-snapshots/source-index-preflight-20261022.json`.

## Approved first build completed

On October 22, 2026 at 13:51:55 UTC, the separately approved work-order index
build completed with exit code zero and without cancellation.
`reporting_src_nwo_cursor` is valid and ready, occupies 305,184,768 bytes
(about 291 MiB), and no build remains active for that table.

Before starting, the target was reverified, both shared switches were off, and
three fresh-connection probes passed. Supabase's public incident at that time
concerned EU management/project lifecycle operations, not the Oregon database.
The user-provided infrastructure screenshot showed 463.17 GB used of 606 GB.

The build used CREATE INDEX CONCURRENTLY, 32 MB maintenance memory, no parallel
maintenance workers, an eight-minute statement timeout and two-second lock
timeout. Independent fresh-connection probes ran every five seconds, with
native psql SIGINT cancellation configured on failure or unhealthy thresholds.
Across 25 baseline/monitor probes, maximum connection-plus-probe time was 839 ms,
maximum active queries was five and lock waiters remained zero. These probes
measure database responsiveness, not direct CPU or filesystem telemetry.

Post-build EXPLAIN (without ANALYZE) confirmed first/next/exact source plans
use the new index for both candidate selection and row lookup, with no Sort or
Seq Scan. This confirms the intended access path, not end-to-end report latency.

Only this index was installed. Other source indexes remain unapproved/unbuilt;
no population was resumed, no reviews added, no code deployed and neither shared
reporting switch enabled. Repo parity is retained in the operator-only
`drizzle/0041_reporting_work_order_cursor.sql`, deliberately not auto-executed by
startup or deployment.

## Approved remaining sequence stopped at service jobs

The subsequent approved sequential run stopped on its first index,
`reporting_src_jobs_cursor`, at 14:07:04 UTC. It had reached the table-validation
phase (roughly 2.0 million of 4.95 million blocks scanned in that phase).
psql exited with code 3 around the eight-minute statement deadline. The health
monitor did not request cancellation. The original wrapper discarded stderr,
so the exact server SQLSTATE was not retained; a statement timeout is strongly
consistent with the timing but is not proven by a captured error message.

83 preflight/monitor probes stayed within thresholds: maximum 1,747 ms, maximum
six active queries and zero lock waiters. At 14:07:36 UTC, a fresh read-only
catalog inspection confirmed no index build was active. The work-order index
remains valid. The service-job index is ready but **invalid**, occupies
989,175,808 bytes, and cannot serve the intended query plans. It can still add
write maintenance overhead; cleanup/rebuild requires an explicit operator step.

No later index was attempted. Both shared reporting switches remain off.
Do not silently rerun CREATE INDEX IF NOT EXISTS over the invalid object.
Any retry needs approved invalid-index cleanup and a revised build deadline,
with the same independent health probes and cancellation safeguards.

## Service-job retry independently verified

The user approved cleanup of only the invalid service-job index and a retry
with a 20-minute statement limit. Cleanup succeeded; the retry used unchanged
32 MB memory and five-second health checks, with sanitized SQLSTATE capture.
At 14:30:03 UTC, an independent read-only check confirmed both work-order and
service-job indexes valid/ready, and first/next/exact service-job query plans
all used reporting_src_jobs_cursor without Sort or Seq Scan.

The psql client remained open after completion: its backend was idle on
ClientRead, with no active index build. The idle client was terminated locally
after that independent verification. A nonzero wrapper exit from this cleanup
must not be interpreted as a failed database build or authorize another retry.
Independent evidence is retained in jobs-independent-verification.json under
the reporting snapshot directory. The client-lifecycle cause is not established.

No later indexes, population, deployment or reader activation were started.
The service-job index has operator-only repo parity in
drizzle/0042_reporting_service_job_cursor.sql.
