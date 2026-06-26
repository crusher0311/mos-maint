---
name: Data Status "Checking…" from combined count+min/max aggregate
description: Why big shops' Repair Orders / Service Jobs cards stick on the "Checking…" badge, and the two-part fix
---

# Data Status cards stick on "Checking…" because one query mixes count + min/max + max(updatedAt)

The "Checking…" badge = freshness `unknown` = the entity aggregate returned null because
it exceeded `QUERY_TIMEOUT_MS` (7s) in `lib/data-status.ts`.

**Root cause (the real one):** Postgres only answers `min()/max()` from an index when the
query contains *nothing but* index-eligible min/max aggregates. The old `aggregateEntity`
ran ONE query per entity: `count(*) + min(date) + max(date) + max(updated_at)`. The extra
`count(*)` and `max(updated_at)` DISABLE the min/max index optimization, forcing a full
per-shop heap scan (~35s on a 133k-row service-jobs shop) → timeout → null → "Checking…".
When the work-orders aggregate timed out, `withHistorySpan` couldn't overwrite
customers/vehicles oldest/newest, so they fell back to their own `createdAt` = the MOS
import date (the misleading "Jan 2026").

**Fix = two parts, BOTH required:**
1. Indexes on canonical PG (`DATAONE_DATABASE_URL`): `(shop_id, coalesce(date…))` expression
   indexes on work_orders + service_jobs, and `(shop_id, updated_at)` on the tables.
2. **Split the query** so each part is served by its own index: separate `count(*)`,
   `max(updated_at)`, and (only when a business `recordDate` exists) `min/max(recordDate)`.
   Indexes ALONE do nothing — as long as min/max shares a query with count/max(updatedAt),
   the planner ignores the index and full-scans. The split is the load-bearing change.

**Why customers/vehicles drop their own min/max:** their displayed span is always borrowed
from the work-order span via `withHistorySpan`; computing their `createdAt` min/max only ever
surfaced the import date. Dropping it removes the misleading date AND a wasted scan; their
freshness now correctly keys off `lastUpdated` (sync recency), not newest-created row.

**Pool gotcha:** the drizzle client for this DB is `max:2` (`lib/db/drizzle.ts`). Splitting
into up to 3 queries × 4 entities = many parallel queries contending for 2 connections, so
make every sub-query index-backed/cheap or the contention re-creates the timeout. With the
indexes in place, measured cold ~5.8s (under 7s), warm ~137ms.

**Residual:** `(shop_id, updated_at)` on `normalized_service_jobs` could NOT be built —
`CREATE INDEX CONCURRENTLY` keeps getting canceled by continuous prod writes on that hot
table. Fix works without it (sj `max(updated_at)` is a ~2.5s heap scan, still under timeout);
build it during a low-write window to widen the cold-start margin.

**Building prod indexes from this repl:** `CREATE INDEX CONCURRENTLY` is tied to its session
— if the client dies the build cancels and leaves an `indisvalid=f` partial. Backgrounded
psql (nohup/setsid) gets reaped by the sandbox after a few minutes (≈ one index per launch),
and the notebook can't see `DATAONE_DATABASE_URL`. Reliable path: foreground `psql` per index
within the bash-tool 120s cap (works for small tables). Big tables (sj 133k) exceed 120s
because CONCURRENTLY waits on concurrent transactions. To drop a stuck invalid partial, plain
`DROP INDEX` blocks behind writes — use `DROP INDEX CONCURRENTLY`.
