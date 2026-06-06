---
name: Post-deploy cron lock stall
description: Why the in-process cron looks dead for ~10 min after every Render deploy, and why it's not a hang.
---

# Post-deploy cron lock stall (expected, self-healing)

After a Render deploy of the web service, the in-process node-cron jobs can log
`[Cron] Skip <job> (lock held by another instance)` on every tick for up to ~10
minutes, with NO winning run in between. This looks like a dead scheduler but is
normal.

**Why:** The cron uses a Mongo-backed lease in `cron_locks` (db `mos`) with
`DEFAULT_LOCK_TTL_MS = 10 min`. If a tick fires on the OLD instance moments before
the deploy swaps it out, that instance acquires the lease and is then killed
mid-run — it never releases. New instances can only take over once the lease's
`expiresAt` passes (the acquire query matches `expiresAt <= now`). So the job is
blocked until the original 10-min TTL elapses, then the next tick wins and runs.

**How to apply:** When verifying any cron-driven fix right after a push, don't
panic at a run of "lock held by another instance" skips — wait until ~10 min past
the last successful pre-deploy run, then expect a clean acquire + run. Only treat
it as a real failure if skips persist well beyond the 10-min TTL. Do NOT hand-clear
the prod `cron_locks` doc to "speed it up" — it self-expires and a manual delete is
an unnecessary prod write. `*/2` cron means you'll see ~4-5 skips before recovery.
