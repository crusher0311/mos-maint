---
name: Tekmetric force-skip blast radius
description: Policy for how the Tekmetric backfill decides to skip/hold/advance so one bad RO can't drop a whole window.
---

# One bad RO must not force-skip a whole backfill window

**Rule:** The backfill cursor-advance decision classifies each failed chunk into
one of three independent axes, and only some of them may skip/hold the window:
- RATE-LIMITED (429 backoff over a threshold) → SHRINK-and-retry, never skip.
- WINDOW error (the repair-orders LIST page itself failed) → bisect the span down
  to a small bad-data floor to isolate the bad slice; only at that floor, after
  the consecutive-error threshold, FORCE_SKIP — and only that minimal slice.
- RECORD error (list read fine, good ROs ingested, individual ROs threw) → NEVER
  holds/force-skips. Advance normally; the bad RO is recorded on a skipped-RO
  list for later review, not dropped as a window.

**Why:** Historically all failures collapsed into one error flag, so a single
corrupt RO that kept 500ing tripped the consecutive-error threshold and
force-skipped the ENTIRE window (up to ~90 days) — a permanent history gap for
one bad record.

**Precedence traps (both cost real data if gotten wrong):**
- WINDOW error must win over a co-occurring RECORD error (if we couldn't read the
  list, we can't trust that "good ROs were ingested").
- PAGE-CAP split must win over a co-occurring RECORD error. A page cap means part
  of the window was never paged; advancing "full" there loses the unpaged
  remainder. Split to the midpoint so the remainder is still covered — the bad RO
  is still recorded separately, so nothing is lost by not surfacing RECORD_SKIP.

**How to apply:** The bad-data narrow floor is a SEPARATE, much smaller floor than
the rate-limit shrink floor. Whether a shop is flagged red keys off the decision
KIND, not the raw error flag: a record-only skip must not turn the shop red — it's
surfaced via the skipped-RO count/list instead. RO skips are recorded at the
per-RO error paths regardless of the final advance decision.
