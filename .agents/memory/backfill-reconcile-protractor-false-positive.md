---
name: backfill-reconcile re-queues completed shops (false positives)
description: Why "completed" shop backfills keep reopening — reconcile date-field and direction pitfalls
---

The hourly `backfill-reconcile` cron spot-checks only already-completed shops: it samples random 30-day windows, compares the integration's upstream RO/invoice count to our stored count, and if a window is off beyond `DELTA_TOLERANCE` it flips the shop back to incomplete and re-pulls. Two distinct false-positive traps bit it:

**1. Date-field semantics must match the upstream filter.** Each provider stores its `job_index` date differently, and the reconcile count MUST query the same field/type the upstream count filters on:
- Protractor: our `performedAt` = `workOrder.Header.LastModifiedTime` (a Date). Upstream `/Invoice?startDate&endDate` filters by **invoice date** (different field). There is NO `closedAt` on Protractor rows.
- Tekmetric: `closedAt`, stored as an ISO **string** (string-range compare).
- Shopware: `updatedAt` (Date) on `shopware_repair_orders`.
Counting Protractor by `closedAt` returned 0 every time → false ~100% gap → every completed shop re-queued hourly forever. Even after switching to `performedAt`, counts still drift because last-modified-date ≠ invoice-date, so the same RO falls in different windows on each side.

**2. The gap test must be directional + tolerant.** A re-queue is a pull-only remedy: it can recover MISSING records but cannot remove an overcount or reconcile a date-semantics mismatch. So the delta is `max(0, upstream - ours)/upstream` (overcount → 0, never re-queues), the tolerance is wide (~10%) to absorb benign date drift, and a zero-count guard refuses to re-queue when every sampled window matched zero stored rows (that signature means a broken count query, not real total data loss).

**Why:** date-field divergence across collections + a symmetric/too-tight gap metric turned a safety net into a runaway loop.

**How to apply:** any window/count query over `job_index` (or a provider RO collection) must branch on `sourceSystem` and match the upstream filter's date semantics; re-queue/backfill triggers should only fire on a genuine, material shortfall.
