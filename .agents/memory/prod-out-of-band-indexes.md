---
name: Prod PG has out-of-band indexes; expression indexes must match exactly
description: normalized_work_orders on prod Supabase carries indexes not in drizzle/; coalesce expression indexes only serve byte-identical expressions.
---
Rule: before adding a PG index for a slow query, list prod's actual indexes (`pg_indexes`) — prod Supabase has hand-created indexes that never made it into drizzle/ (e.g. nwo_shop_wo_date_idx on `(shop_id, COALESCE(closed_date, completed_date, created_at))`). An expression index is only usable when the query's expression matches exactly — the 3-arg coalesce does NOT serve a 2-arg `coalesce(closed_date, completed_date)` predicate.

**Why:** the Missed Opportunities window query ran 3-11s per shop despite a superficially similar prod index; a matching 2-arg expression index `nwo_shop_close_date_idx (shop_id, coalesce(closed_date, completed_date))` cut it to ~2ms (built with CREATE INDEX CONCURRENTLY on prod, plain idempotent CREATE INDEX in the repo migration, same convention as the trgm indexes).

Update 2026-08-25: all live prod-only normalized_* indexes (3× shop_updated composites, nsj_shop_sj_date_idx, nwo_shop_wo_date_idx) are now in a parity migration in drizzle/ + apply-normalized-migration.ts; the five whole-provenance GIN indexes (idx_scan 0, superseded by sourceIds GIN + contentHash btree) were intentionally NOT carried — safe for an operator to drop on prod. Any NEW out-of-band index must get a repo migration in the same change. Note: the isolated dev PG carries a stale 4-column dataone_cache table that makes the fresh-env db:migrate:normalized fail at 0011 (expires_at index); validate index migrations in a scratch schema instead.

**How to apply:** keep any query that expects this index using the byte-identical coalesce expression; don't "simplify" to the 3-arg form — falling back to created_at (import time) wrongly includes date-less ROs in closed-window filters.
