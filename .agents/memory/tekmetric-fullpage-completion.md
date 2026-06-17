---
name: Tekmetric full-page reindex completion bottleneck
description: Why shops show incomplete despite data being indexed — completion is gated on an optional second-pass full-page reindex that head-of-line-blocks on giant shops.
---

The Tekmetric `completed=true` flag does NOT mean "data is backfilled." Pass-1 (the
date-window chunker, driven by the standalone drain worker on Render) indexes the real
jobs. `completed` only flips after an OPTIONAL second pass — the **full-page reindex**
(`fullPageMode=true`, run by the in-process cron `fullpage-backfill-tekmetric` →
`/api/cron/tekmetric-fullpage-backfill`) — finishes (`reachedEnd && !lastError`).

So a shop can have tens of thousands of jobs indexed and still read incomplete because
the reindex hasn't finished. That is the usual explanation for "why have so few shops
completed?"

**The bottleneck:** the full-page cron processes flagged shops **sequentially**,
oldest-queued-never-run first, one `runFullPageBackfillChunk` call per shop per tick,
under a ~270s route deadline. A single enormous shop at the head of the line (e.g. a
~6,300-page pre-pass with ~600k staged `tekmetric_jobs_prepass` docs) consumes most/all
of the budget every tick, so the shops behind it rarely or never get a turn — several
can sit untouched for days/weeks even though the cron is healthy (status 200, full
budget used, fresh heartbeat on the head shop).

**Why:** head-of-line blocking, not a hang and not lock contention. The drain-lock
early-return in the full-page route was removed 2026-05-28, and the regular drain worker
explicitly skips `fullPageMode` shops — so the two paths touch disjoint shops; the
reindex starvation is purely the sequential head-of-line ordering on a few giant shops.

**How to apply:** before calling the reindex "stuck," check `cron_runs` in db `mos` for
the job (it fires ~every 6 min because each run ~270s), then check per-shop
`prePassNextPage`/`prePassTotalPages` + `inFlightHeartbeatAt` on the head shop. If the
head shop's pre-pass is advancing, the fix is fairness/parallelism across shops or
splitting giant shops — not "restart the worker." Any change here is a prod action;
operator-gated.

**Current state (post fairness fix):** the route no longer pins one giant to the head
forever — it sorts by the freshest of `lastFullPageRunAt`/`lastPrePassRunAt` (rotates a
shop to the back the moment it gets a slice), bounds each shop to `PER_SHOP_SLICE_MS`
(60s), and caps giants (`prePassTotalPages >= GIANT_PREPASS_PAGES`=1500) to
`MAX_GIANTS_PER_TICK`=1 per tick. So all flagged shops DO get touched (verify: most have
a `lastFullPageRun` within the last hour). BUT giants now crawl: with ~19 giants all
competing for the single giant slot per ~6-min tick, each giant gets ~one 60s slice
every ~2 hours → a 1,300+ page giant can take weeks-to-months. **Also: the nightly drain
worker does NOT accelerate this** — it only runs the date-window chunker (`drain:tekmetric-backfill`),
which skips `fullPageMode`. Full-page reindex runs ONLY on the in-web 6-min cron, same
slow rate 24/7, no night/weekend boost. Levers to speed it (all operator-gated prod
actions): flip the dormant BullMQ/Redis queue lane (`BACKFILL_QUEUE_ENABLED` via
`decideQueueFor`) to parallelize, raise `MAX_GIANTS_PER_TICK` (saturation risk), or split
giants. "Frozen `lastCursorMoveAt`" is a FALSE alarm for these shops — the date-window
cursor is done by design; what moves now is `fullPageNextPage`.
