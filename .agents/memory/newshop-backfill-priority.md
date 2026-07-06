---
name: New-shop backfill prioritization already exists
description: Recently-connected shops are already bumped to the front of the Tekmetric backfill; "empty/thin" new shops are usually genuinely empty at the source, not queue-starved.
---

# New-shop backfill prioritization

The Tekmetric backfill already prioritizes recently-connected shops two ways, so there is
NO need to add a "bump new shops to front" mechanism — it exists:

- **newShops fastpath**: cron runs `?fastpath=newShops` on a tighter cadence (~5 min) filtering to shops
  whose `createdAt` is within the last `NEW_SHOP_FASTPATH_DAYS` (14 days).
- **never-started bucket**: every normal run reserves the top slots (≈6) for shops with no `lastRunAt`,
  ahead of the stalled tail (see `getShopsNeedingBackfill` ordering: never-run first, then oldest `lastRunAt`).

**Why this matters:** when a newly-connected shop shows 0 / very few indexed jobs, the reflex is to
"bump it to the front." That's almost always wrong — the shop was already processed. Verify the SOURCE
first before touching the queue.

**How to apply — before bumping any shop, check the source RO count:**
`getRepairOrders(tekmetricShopId, { page: 0, size: 1 })` → `totalElements`. A brand-new shop legitimately
has a handful of ROs (some `Deleted`), so `totalJobsIndexed: 0` + `complete: true` is CORRECT, not a bug.
Also note `job_index` count is normally GREATER than source RO count (one RO → many job line items), so
"indexed >= sourceROs" means fully caught up. Live ROs flow in via webhooks once the shop starts writing.

**Confirmed 2026-07-05:** all Protractor shops (29/29) and all Tekmetric shops with real source history were
fully indexed; the lone "empty" Tekmetric shop had only 4 source ROs (1 deleted) and the 7 "thin" shops all
had indexed >= source — i.e. genuinely small/new shops, not queue starvation.
