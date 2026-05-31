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
