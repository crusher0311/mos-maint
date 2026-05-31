---
name: backfill-reconcile re-queues completed Protractor shops (false positive)
description: Why "completed" Protractor backfills keep reopening — reconcile counts the wrong date field
---

The hourly `backfill-reconcile` cron (`/api/cron/backfill-reconcile`, schedule `30 * * * *`) spot-checks only shops already marked complete. For each, it pulls 6 random 30-day windows, compares the integration's upstream RO/invoice count to our stored count, and if any window is off by more than `DELTA_TOLERANCE` (2%) it sets `completed:false` + `currentChunkEnd = worstWindow.end` to re-queue. It does NOT clear the old `completedAt`.

**The bug:** the Protractor branch counts our stored ROs with `job_index.distinct("workOrderId", { ..., closedAt: { $gte, $lte } })`, but Protractor `job_index` documents have **no `closedAt` field** — their date lives in **`performedAt`** (a BSON Date). So our count is always 0, every sampled window reads ~100% short, and every completed Protractor shop is re-queued every hour, forever. The data is actually present (e.g. shop 66 had 12,112 ROs stored). It is a pure false positive, not a real gap.

**Schema divergence to remember:**
- Protractor `job_index` rows: date = `performedAt` (Date). No `closedAt`.
- Tekmetric `job_index` rows: date = `closedAt` (stored as an ISO **string**, e.g. `"2025-12-30T20:25:25Z"`). Tekmetric reconcile happens to work because it compares string bounds against a string field.

**Why:** the reconcile date filter was written for Tekmetric's `closedAt` and never adapted to Protractor's `performedAt`, and the two collections store dates as different types (string vs Date).

**How to apply:** any window/count query over `job_index` must branch on `sourceSystem` — use `performedAt` (Date bounds) for protractor, `closedAt` (string bounds) for tekmetric. A fix to the reopening should make the Protractor reconcile count `performedAt` with `new Date()` bounds. Re-queue side effects: idempotent re-pulls (no bad data after the 23505 dedup fixes) but wasted API calls and a never-stabilizing "completed" count.
