---
name: Whole-pipeline backfill stall detection
description: How the fleet-level backfill stall safety net decides to page, and why it gates on loop liveness.
---

# Fleet-level backfill stall alerter

`/api/cron/pipeline-stall-alerter` is the fleet-level safety net that the
per-shop alerters (`tekmetric-backfill-health`, `backfill-chunk-speed-health`)
and `cron-health-alerter` all miss.

**The gap it fills:** the backfill cron can keep returning 200 (so
cron-health stays green) while making ZERO real data progress across the
whole fleet — a wedged global drain lease, or a tick that no-ops every time.
That exact failure went unnoticed for ~2 days.

**Progress signature must EXCLUDE `lastRunAt`.** The chunkers bump `lastRunAt`
every tick even on a no-op, so any signature including it would always look
like progress and mask the stall. The signature is built only from fields
that move on *real* progress: `completed` count, `lastCursorMoveAt`,
`currentChunkEnd`, and monotonic counters (`totalRosProcessed`,
`totalJobsIndexed`, `fullPageNextPage`, `prePassNextPage`, …).

**Liveness gate (key design decision).** Page "no fleet progress" ONLY when
the provider's backfill cron has succeeded within the window (loop alive but
frozen = wedged). If the loop is NOT running (no recent success), that's plain
loop-death — leave it to `cron-health-alerter`, don't double-page.
**Why:** Protractor/Shop-Ware have long *legitimate* quiet gaps (boosts only
run certain hours/days; daily tick + new-shop fastpath otherwise). A pure
wall-clock "no progress for N hours" rule false-pages during those gaps. The
liveness gate makes the alert fire only when the cron is actively running yet
accomplishing nothing.
**How to apply:** tune via `PIPELINE_STALL_WINDOW_MS` (default 3h);
`PIPELINE_DRAIN_WEDGE_MS` (default 30m) for the drain-lease hold;
`PIPELINE_QUEUE_FAILED_THRESHOLD` (default 50) once REDIS_URL is set.

**Escalation beyond email.** `lib/alerts/notify.ts#sendOpsAlert` always emits
a one-line `[OPS-ALERT]` stderr JSON (Render → Better Stack, host
`mos-maintenance-mvp-main`, always-on) and optionally POSTs Slack if
`OPS_ALERT_SLACK_WEBHOOK_URL` (or `SLACK_WEBHOOK_URL` /
`ALERT_SLACK_WEBHOOK_URL`) is set — gracefully skipped when unset. Build
Better Stack alert rules on the `[OPS-ALERT]` marker.
