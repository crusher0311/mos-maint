---
name: Declined-add thin job_index lines
description: Why "Add All Declined" pushed $0/no-labor jobs and how the server re-hydrates lines
---

**Rule:** job_index rows indexed before the May-2026 job-detail fix (commit "Fix Tekmetric job retrieval to include shop ID in requests", 2026-05-05) can have correct `totals` but degraded `lines` — no labor line at all and/or parts with $0 unitPrice. Closed ROs never re-index, so these stale rows persist fleet-wide. The raw `tekmetric_work_orders` cache (`data.jobs[]`) DOES have full labor (rate/hours, cents) and parts (retail/cost, cents).

**Why:** the pre-fix getJobs call had swapped args (400s), so that era indexed from thinner data. "totals right, lines empty" is impossible under current indexer code — it always means a stale-era row.

**How to apply:**
- Any consumer pushing job_index `lines` back to an SMS must treat empty/no-labor/$0-part lines as suspect and re-hydrate from the RO cache (see `lib/declined-work-lines.ts` — pure, tsx-testable; used by the add-declined-work route, matched by `(workOrderNumber, servicePackageId)`).
- The deferred-work repository must pass labor `hours` through its line mapping — the extension sidepanel reads `item.hours` and silently defaults to 1 hour if absent.
- A fleet-wide `reindexFromStoredData(shopId)` would also fix rows at rest, but it's operator-gated (dev Mongo IS prod) and runs ACES/DataOne lookups per WO — off-peak only.
