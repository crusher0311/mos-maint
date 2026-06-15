---
name: Log-sync silent blackout
description: Why the Better Stack → production_logs feed can freeze for hours while the cron shows green, and what actually unsticks it.
---

# Log-sync silent blackout (production_logs freeze)

The in-process cron `log-sync` (every 15 min) self-calls `/api/cron/log-sync`, which
runs `syncLogsFromBetterStack` (Better Stack ClickHouse query via HTTP **Basic auth**,
not a rotating token) and upserts into Supabase `production_logs` with
`onConflictDoNothing(dtHash)`.

## The trap: "green but frozen"
- The route logs `"<N> inserted"` where N is **attempted** rows (`inserted += chunk.length`),
  NOT actually-new rows. With `onConflictDoNothing`, a run that pulls a batch already in
  the table reports e.g. `"6704 inserted, 0 skipped, 0 errors"` while inserting **zero** new rows.
- `cron-health-alerter` / `cron_status.lastSuccessByJob` only track that the run **returned ok**,
  not that DATA advanced. So an hours-long feed freeze shows fully green everywhere.
- Diagnostic signature of the blackout: the **same constant** "<N> inserted" repeated across
  consecutive runs (look at `[LogSync] Synced:` lines in Better Stack), while
  `SELECT max(dt) FROM production_logs` is stuck. Identical N = same stale batch re-fetched.

**Why:** a transient upstream condition (Better Stack `remote()` returning a stale/pinned
window) made the 20-min query keep returning the same old rows; the misleading counter +
absence of a freshness check turned a hiccup into a ~8h silent blackout (observed 2026-06-15,
froze 04:15→~12:00 UTC). Cleared after the web service restarted (a deploy) and/or a manual
wider-window trigger.

## How to confirm / unstick (operator)
- Confirm creds/data are fine FIRST (rules out the "stale token" red herring): replay the
  exact query from a shell using `BETTERSTACK_QUERY_{HOST,USERNAME,PASSWORD,SOURCE}`
  (all four are env vars; only PASSWORD is a Replit secret). HTTP 200 + recent `dt` = creds fine.
- Manually trigger: `GET https://mos.tools/api/cron/log-sync?minutes=60` with
  `Authorization: Bearer $CRON_SECRET`. Window is capped at `MAX_SYNC_MINUTES=120` and is
  **relative to now()** — you CANNOT backfill a gap older than 120 min via the route
  (older logs still live in Better Stack for 30 days).
- `cron_runs` collection (db `mos`) was empty in practice; rely on `[LogSync]` lines in
  Better Stack + `max(dt)` on Supabase `production_logs`, not on per-run cron docs.

## Durable fixes worth making (not yet applied as of 2026-06-15)
- Report **actual** new inserts (drizzle `rowCount`) so "0 new for N runs" is truthful.
- Add a **data-freshness** alert: page when `max(dt)` of `production_logs` is > ~30 min behind
  `now()` (same spirit as `pipeline-stall-detection` — watch progress, not just run success).
- Pagination uses `ORDER BY dt ASC` + growing `OFFSET` (O(offset) per page in ClickHouse);
  keyset (`dt > lastSeen`) would be cheaper under heavy volume. Render runs a long-lived
  server so `maxDuration=60` is not hard-enforced (many pages can complete).
