---
name: Background rate-limit lane starvation is location-dependent
description: Why a Tekmetric backfill can hang on the web process but fly on the worker, and the two levers that fix it.
---

The two-lane rate limiter (`lib/integrations/core/rate-limiter.ts`) drains
`interactive` before `background` (interactive always wins). So a `background`
request only fires when the interactive lane is momentarily empty.

**The trap:** the SAME backfill code starves on the WEB process (constant
webhook / VHI / extension interactive traffic → background lane rarely opens)
but flows freely on the WORKER process (zero interactive traffic). A wedged
"giant" shop and a healthy one can be running identical code — the only
difference is *which process* they landed on.

**Why it's invisible:** the per-request HTTP timeout only covers the fetch, not
the wait for a rate-limit slot. A starved background request never even issues
the fetch — no timeout, no error, no progress persisted, no in-flight-lock
heartbeat. The chunk silently consumes the whole cron tick, its stale lock is
stolen next tick, and it head-of-line-blocks the entire fleet.

**Why:** interactive-first scheduling + an unbounded background wait. Fixed by
bounding the background wait (returns `acquired:false` → caller backs off,
persists progress, frees the lock). Interactive keeps the unbounded wait.

**How to apply — two levers when a Tekmetric/Protractor backfill stalls:**
1. *Operational (fast, no deploy that touches code):* route the giant shops to
   the idle worker via the web service's `BACKFILL_QUEUE_SHOPS` allowlist
   (`lib/queue/feature-flag.ts`). Only the WEB service needs it — that's where
   the cron's `decideQueueFor` enqueue decision runs; the worker just consumes.
   **Verify the BullMQ worker is live and consuming first** (a shop completing
   while it's in the allowlist proves the pipeline) — otherwise Pass-1 pulls the
   shop out of the inline path and it freezes in "waiting" with no consumer.
2. *Structural:* keep the background-lane wait bounded so any future starvation
   fails fast instead of wedging a tick. The cap effectively never fires on the
   idle worker (sub-second waits there).
