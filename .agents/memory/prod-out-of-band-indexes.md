---
name: Prod PG has out-of-band indexes; expression indexes must match exactly
description: normalized_work_orders on prod Supabase carries indexes not in drizzle/; coalesce expression indexes only serve byte-identical expressions.
---
Rule: before adding a PG index for a slow query, list prod's actual indexes (`pg_indexes`) — prod Supabase has hand-created indexes that never made it into drizzle/ (e.g. nwo_shop_wo_date_idx on `(shop_id, COALESCE(closed_date, completed_date, created_at))`). An expression index is only usable when the query's expression matches exactly — the 3-arg coalesce does NOT serve a 2-arg `coalesce(closed_date, completed_date)` predicate.

**Why:** the Missed Opportunities window query ran 3-11s per shop despite a superficially similar prod index; a matching 2-arg expression index `nwo_shop_close_date_idx (shop_id, coalesce(closed_date, completed_date))` cut it to ~2ms (built with CREATE INDEX CONCURRENTLY on prod, plain idempotent CREATE INDEX in the repo migration, same convention as the trgm indexes).

Update 2026-08-25: all live prod-only normalized_* indexes (3× shop_updated composites, nsj_shop_sj_date_idx, nwo_shop_wo_date_idx) are now in a parity migration in drizzle/ + apply-normalized-migration.ts; the five whole-provenance GIN indexes (idx_scan 0, superseded by sourceIds GIN + contentHash btree) were intentionally NOT carried — safe for an operator to drop on prod. Any NEW out-of-band index must get a repo migration in the same change. Note: the isolated dev PG carries a stale 4-column dataone_cache table that makes the fresh-env db:migrate:normalized fail at 0011 (expires_at index); validate index migrations in a scratch schema instead.

**How to apply:** keep any query that expects this index using the byte-identical coalesce expression; don't "simplify" to the 3-arg form — falling back to created_at (import time) wrongly includes date-less ROs in closed-window filters.

## Concurrent builds still need a resource-safety plan

Do not treat `CREATE INDEX CONCURRENTLY` as proof that a fleet-wide index build is safe for shared production capacity.

**Why:** On 2026-10-19, a large identity-expression GIN build coincided with fresh connection timeouts from both the workspace and Render. A retry with session-only maintenance memory reduced from 512 MB to 32 MB initially progressed with healthy probes, then connection availability failed again. Lower memory alone was not sufficient evidence of safety.

**How to apply:** Keep a bounded server-side deadline, an independent cancellation path, and fresh-connection probes. Stop after repeated capacity failures rather than repeatedly rebuilding. Killing a client does not prove the database operation stopped: verify server-side progress and index validity before restarting dependent imports. A heartbeat is not import progress.

For long DDL, retain a native query-cancellation mechanism (for example, psql's SIGINT handler sends a PostgreSQL cancellation request) rather than relying only on a second SQL session calling `pg_cancel_backend`. **Why:** fresh authenticated SQL connections became unavailable during these failures, including the intended safety checks. Native cancellation still needs subsequent server-side confirmation; it is not a substitute for a server-side statement timeout.

Follow-up dashboard evidence from the incident showed committed-memory spikes around 8.4 GB against a roughly 4.66 GB commit limit, swap growth, and CPU below full utilization. This makes memory pressure a stronger lead than CPU saturation; normal-looking headline RAM percentages can hide commit pressure. It does not prove an OOM kill or restart without database logs. Check committed memory and swap, not just cache-inclusive memory totals, before recommending capacity changes or retrying DDL.

After the operator's compute upgrade to the XL-equivalent configuration, the same 32 MB session-limited build completed with healthy fresh connections and a valid index. This supports increasing capacity for maintenance, not removing runtime request, concurrency or deadline safeguards.
