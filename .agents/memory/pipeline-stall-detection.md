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

## Operator history runners

Keep dispatch permission distinct from campaign authorization when monitoring
operator imports. A temporarily closed dispatch grant is normal between requests
and during error cooldowns; it must not silence the campaign's stall alert.
Callback-priority suppression must be freshly renewed and must not classify an
error retry delay as progress.

**Why:** The runner intentionally closes its request grant before sleeping, even
while the authorized campaign and its lease remain active. Treating that closure
as cancellation hides repeated duplicate-check failures.

**How to apply:** Gate on the campaign window, ownership, operator stop and live
leases; use verified outcomes for progress and separate bounded callback waits.
Keep campaign stalls in the existing pipeline alert/dedup path.

Older one-use runners do not share the weekend runner's dispatch-grant or
lease semantics. Keep monitoring bounded by each campaign's unchanged approval;
adding telemetry is not permission to reuse an expired run. Comparison-only
campaigns report completed comparisons, never imported invoices.

**Why:** Afton has only a 15-minute approval, while the fleet stall threshold is
three hours. Both the observation cadence and threshold must fit the authorized
window, without a separate pager or extended grant.

**How to apply:** Check both cron cadence and campaign duration when adding
short-lived campaigns. Do not backfill new authority metadata into expired jobs
just to make them appear active.

Treat lease renewal, cursor advancement to a held/error day, and actual imported
or verified-present receipts as separate signals. Fixed-order retries must not
let an early shop repeatedly trigger a fleet-wide cooldown and starve later shops.

**Why:** A weekend runner kept renewing its lease while PostgreSQL duplicate
checks timed out. Its error counter survived the cooldown, so subsequent early
failures repeatedly paused the entire loop. Moving a failed day into held work
also advanced a cursor without completing that day's import.

**How to apply:** Check actual receipt/page completion times, per-shop waiting
time and held work. Read Render one-off runner logs using the job resource ID,
not only the parent service ID; otherwise the diagnostic stream can appear empty.
Tenant-bounded JSON identity scans are still scans: a materialized per-shop
slice can exceed the deadline repeatedly when an absent invoice requires
checking every row. Verify an identity-indexed plan rather than merely raising
the timeout or bypassing duplicate protection.

An identity GIN index alone does not ensure the planner uses it under LIMIT 1.

**Why:** The local large-tenant fixture still chose a scan after adding the
index. Materializing only the identity-matching candidates, rather than the
entire tenant slice, produced indexed plans for both existing and missing IDs
without forcing planner settings.

**How to apply:** Test hit and miss plans with realistic tenant sizes. Preserve
case-insensitive values and every Protractor source-ID type; legacy IDs are not
limited to the current primary invoice/work-order types. Treat the helper's
meaning as versioned: altering an immutable index function requires an index
rebuild, not just CREATE OR REPLACE FUNCTION.
