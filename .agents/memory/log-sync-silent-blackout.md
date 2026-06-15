---
name: Log-sync silent blackout
description: Why the Better Stack → production_logs feed can show a green cron while frozen, and the invariants that keep that from hiding.
---

# Log-sync silent blackout (production_logs freeze)

The in-process cron `log-sync` (every 15 min) self-calls `/api/cron/log-sync`, which runs
`syncLogsFromBetterStack` (Better Stack ClickHouse query over HTTP **Basic auth**, not a
rotating token) and inserts into Supabase `production_logs` with `onConflictDoNothing(dtHash)`.

## Invariant: "cron returned ok" ≠ "data advanced"
A run that re-fetches a batch already in the table is a no-op, yet the run still "succeeds".
`cron-health-alerter` / `cron_status` only track that the run returned — never that `max(dt)`
moved. So a feed freeze can stay green everywhere for hours.

**Rule:** any sync-style job must report *new* rows, not *attempted* rows, AND must be watched
for data progress (freshness), not just run success. (Same spirit as `pipeline-stall-detection`.)

**Why:** the original route did `inserted += chunk.length` under `onConflictDoNothing`, so a
stale re-fetch logged a constant `"<N> inserted"` every run while inserting zero. With nothing
watching `max(dt)`, one upstream hiccup (Better Stack `remote()` pinned to a stale window)
became a ~8h silent blackout (2026-06-15, 04:15→~12:00 UTC). Cleared by a deploy/restart +
a manual wide-window trigger.

## What the fix enforces (applied 2026-06-15)
- **True insert count:** count `.onConflictDoNothing(...).returning({id})` length; route logs
  `"X new (Y fetched)"`, so `0 new (N fetched)` exposes a stale re-fetch.
- **Freshness alarm:** `checkLogFreshness()` compares `max(dt)` to now vs
  `LOG_FRESHNESS_MAX_LAG_MIN` (default 30) and pages `[OPS-ALERT]` (critical), prod-only, with
  module-level repeat de-dup `LOG_FRESHNESS_ALERT_REPEAT_MIN` (default 60). It can never break
  the cron (route wraps it in try/catch).
- **Keyset pagination:** inclusive `dt >= cursor` (dt_hash dedups the boundary row) replaces
  growing OFFSET (O(offset) in ClickHouse). A full page that doesn't advance the cursor = a
  >1-page tie group at one `dt`; page past it with a *bounded* OFFSET that resets once the
  cursor advances — never truncate tied rows, never loop.

## Operator playbook (confirm / unstick)
- Rule out the "stale token" red herring FIRST: replay the exact query from a shell using
  `BETTERSTACK_QUERY_{HOST,USERNAME,PASSWORD,SOURCE}` (all env vars; only PASSWORD is a secret).
  HTTP 200 + recent `dt` = creds/data fine.
- Manual trigger: `GET https://mos.tools/api/cron/log-sync?minutes=60` with
  `Authorization: Bearer $CRON_SECRET`. Window is capped at `MAX_SYNC_MINUTES=120` and is
  **relative to now()** — you CANNOT backfill a gap older than 120 min via the route (older
  logs still live in Better Stack for 30 days).
- Trust `[LogSync]` lines in Better Stack + `SELECT max(dt) FROM production_logs`, NOT per-run
  cron docs (`cron_runs` in db `mos` was empty in practice).
