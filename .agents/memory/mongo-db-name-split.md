---
name: Mongo database-name split (mos vs mos-maintenance-mvp)
description: Cron bookkeeping lives in db "mos"; all app data lives in db "mos-maintenance-mvp" on the SAME cluster — querying the wrong one silently returns empty.
---

On the shared Mongo Atlas cluster there are TWO databases and code uses them inconsistently:

- `lib/cron/scheduler.cjs` hardcodes `client.db("mos")` — so the cron bookkeeping
  collections (`cron_status`, `cron_runs`, `cron_locks`) live in db **`mos`**.
- `lib/mongo` `getDb()` returns db **`mos-maintenance-mvp`** — so ALL app data
  (`tekmetric_backfill_progress`, `tekmetric_drain_lock`, `shops`, prepass, etc.)
  lives there.

**Why this bites:** a diagnostic script that imports `lib/mongo` and reads
`cron_status`/`cron_runs` gets an EMPTY result (those collections don't exist in
`mos-maintenance-mvp`) and you wrongly conclude "the scheduler never runs / the job
never fires." It runs fine — you're just reading the wrong database.

**How to apply:** to inspect cron health (lastRuns, cron_runs history, cron_locks),
connect explicitly with `client.db("mos")` (same URI the scheduler builds from
`MONGODB_USERNAME`/`MONGODB_PASSWORD` against `mos-maintenance-mvp.tiixipi.mongodb.net`).
For everything else (backfill progress, locks, shops) use `lib/mongo` → `mos-maintenance-mvp`.
Confirm with `db.databaseName` at the top of any throwaway diagnostic.
