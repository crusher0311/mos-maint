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
