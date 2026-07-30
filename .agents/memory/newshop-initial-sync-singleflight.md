---
name: New-shop initial sync single-flight
description: Tekmetric initial sync + new-shop history backfill must never run inline/overlapping on the web process
---

Rule: the Tekmetric initial sync (`syncSingleShop`) is single-flight per shop via `tekmetric_initial_sync_locks` (15-min TTL, owner-scoped release); overlapping triggers return `{skipped:true, reason:"in_flight"}` and log a THROTTLED line. Callers must treat `skipped` as "someone else owns it" — never as failure (the settings route leaves `initialSyncState` alone on skip).

The new-shop detector (`checkAndRunBackfillForNewShops`) is HAND-OFF ONLY: it upserts the `tekmetric_backfill_progress` row + best-effort enqueues `drain-tekmetric` with a per-shop allowlist, then stamps `tekmetric.jobIndexBackfillHandedOffAt` (one-shot). The legacy inline `runTekmetricHistoryBackfill` call was removed from that path.

The `?fastpath=newShops` cron tick skips shops whose in-flight lock is live (fresh heartbeat) or whose `lastRunAt` is within `TEKMETRIC_FASTPATH_COOLDOWN_MINUTES` (default 4), logging `fastpath skip shop X: in_flight|recently_attempted`.

**Why:** 2026-07-29 ~1:42pm CT — one new shop connected during business hours started the initial sync 8× in 5 min (no overlap guard), ran 5-year history inline on the busy web process (workers suspended weekday daytime), and the fastpath cron timed out at 480s and re-kicked the same shops every tick → ~20-min fleet-wide slowdown.

**How to apply:** any new trigger of initial sync or new-shop history work must go through the lock/hand-off, never run heavy Tekmetric loops inline in a web route or cron request. Lock semantics covered by `npm run test:initial-sync-lock` (in-memory fake — never touches real Mongo).
