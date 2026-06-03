---
name: Full-page cron queue hand-off ordering
description: Why the Tekmetric full-page backfill cron must enqueue queue-routed shops in a separate up-front pass before any deadline-bounded inline work.
---

# Full-page cron: queue hand-off must precede inline drain

**Rule:** In the Tekmetric full-page backfill cron's GET drain, the BullMQ queue
hand-off for queue-enabled (allowlisted) shops must run as its own pass FIRST,
before any of the time-bounded in-process chunk work. Enqueue is O(1), deduped by
the per-shop jobId, and fails open to the inline path; it must never sit behind
inline work in the same deadline-bounded loop.

**Why:** When the hand-off was interleaved inside the single fairness-ordered
loop, a giant in-process shop ahead of an allowlisted shop in the order would
overrun its per-shop time slice, consume the whole ~270s tick budget, and trip
the loop's deadline `break` BEFORE the loop ever reached the allowlisted shop.
Net effect during the canary: the canary shop (rank ~9 behind ~6 giant shops)
was never enqueued, the BullMQ worker sat idle, and the queue dashboard showed
zeros — the whole pipeline looked broken when the worker/Redis were actually
fine. The bottleneck was purely producer-side ordering.

**How to apply:** Any future edit to the drain loop must keep enqueue separate
from and ahead of the inline drain. The same principle governs the fleet
rollout — turning the queue on for the giants is exactly what relieves the
in-process head-of-line blocking, so the up-front enqueue pass is load-bearing,
not cosmetic. Related: the manual platform-admin "Full-page reindex" cron-kick
must use a real prod base URL (RENDER_EXTERNAL_URL / PRODUCTION_URL), not
`localhost`, or the instant trigger silently ECONNREFUSEDs in prod.
