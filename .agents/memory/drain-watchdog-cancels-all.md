---
name: Drain progress watchdog cancels ALL chunks on a giant-shop finalization stall
description: Why the Tekmetric drain worker sits at touched~0/complete=0 for hours on giant shops despite pages flowing — the post-last-page finalization has no heartbeat and trips the 10-min watchdog, which aborts every in-flight chunk.
---

The standalone Tekmetric drain worker (`scripts/drain-tekmetric-backfill.ts`) runs
`conc=4` chunks in parallel and guards against wedges with a single global
progress watchdog: `lastProgressAt` is bumped (a) at shop start, (b) on every
page turn via the `onPage` callback passed into `backfillShopChunk`, and (c) when
a chunk RETURNS. If nothing bumps it for `DRAIN_PROGRESS_STALL_MS` (default
**10 min / 600s**) the watchdog logs `WATCHDOG no progress for Ns`, stops
refreshing the lease (so cron can take over), and `triggerHardCancel` calls
`abort()` on **every** in-flight AbortController — i.e. it kills all 4 chunks,
not just the stuck one.

**The trap:** the per-page heartbeat only fires while *turning pages*. A giant
shop's chunk fetches all its pages (heartbeating fine, ~75s/page on a dense
shop), then does heavy **post-last-page finalization** (normalize of the final
batch + job_index writes / completion) with NO heartbeat. On a giant shop
(e.g. HEART shop 32, ~8k jobs in one 90-day chunk) that finalization runs
>10 min → watchdog fires → HARD-CANCEL aborts the giant AND the 3 healthy
sibling chunks that were making progress → worker exits 130 → restarts →
re-selects the same giants → repeats. Net effect: `touched=1/23 complete=0`
for an hour+, looks like a total fleet stall but pages are actually flowing.

**Signature:** last log before the silence is the shop's FINAL page
(`page N/N`), then a ~600s gap, then `WATCHDOG no progress for ~6xx s` +
`HARD-CANCEL ... aborting 4 in-flight chunk(s)` + `FORCE-EXIT` + child
`code=130`. The `CHUNK shop=... complete=...` return line never prints for the
hung shop. Confirm with the Render logs API on `backfill-drain-worker`.

**Distinct from `tekmetric-fullpage-completion`:** that note is the in-process
*reindex cron* head-of-line-blocking sequentially. THIS is the drain worker's
*pass-1 date-window chunk* finalization tripping the watchdog. Different path,
different process.

**Likely fixes (all prod/operator-gated — propose, don't ship unilaterally):**
1. Heartbeat during finalization (bump progress as the post-last-page
   normalize/job_index write advances) so giants aren't falsely flagged stuck.
2. Cancel only the stalled worker's controller, not all 4 (per-worker
   lastProgressAt), so one giant can't kill 3 healthy chunks.
3. Shrink chunk size / `BACKFILL_HORIZON_YEARS` (PROD=5) so a chunk finishes
   inside the 10-min window — the cheapest reversible env-only lever.
4. Raise `DRAIN_PROGRESS_STALL_MS` (risk: masks real wedges).
Also contends with the cron inline backfill for the same shops
(`WAITING shop=N cron-holds-lock`), which compounds the starvation.
