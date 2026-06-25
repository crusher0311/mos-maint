---
name: Data Status "Checking…" from filtered min/max
description: Why big shops' Repair Orders / Service Jobs cards stick on the "Checking…" badge
---

# Data Status cards stick on "Checking…" because per-shop date min/max is pathologically slow

The "Checking…" badge = freshness `unknown` = the entity aggregate returned null because
it exceeded `QUERY_TIMEOUT_MS` (7s) in `lib/data-status.ts`. Count and dates share ONE
query, so a slow date computation also kills the count.

**Root cause:** `count(*) WHERE shop_id=?` is fast (sub-second; `shop_id` indexes exist on
`normalized_service_jobs`/`normalized_work_orders`). The killer is `min/max` over date
columns WITH a `shop_id` filter — the planner falls into the filtered-min/max anti-pattern
(scans a global single-column date index hunting for the shop's rows). For a big shop
(HEART ~133k service jobs) Service Jobs min/max ≈ 33s even on plain `created_at`; the
COALESCE(date…) expression can't use any single-column index at all. Work Orders min/max on
plain `created_at` is fast (~90ms) but the COALESCE version is ~4.6s — under 7s solo, but
tips over the timeout under prod concurrency → RO card also shows "Checking…".

**Durable fix = composite indexes** on the canonical PG (`DATAONE_DATABASE_URL`):
`(shop_id, completed_at)` / `(shop_id, created_at)` on service jobs and
`(shop_id, closed_date)` / `(shop_id, created_at)` on work orders make the per-shop min/max
index-only. This is operator-gated prod DDL — propose to Brandon, don't run unilaterally.

**Why:** Adding indexes to the canonical normalized tables is a production DB change; Brandon
wants sign-off on prod/DB structural changes.

**How to apply:** If a future date-range/freshness query over a per-shop slice is slow,
suspect a missing `(shop_id, <date>)` composite before adding app-side timeouts or fallbacks.
Code-only stopgaps: decouple count from the date aggregate so the count always renders, or
borrow the work-order history span for service jobs (as customers/vehicles already do via
`withHistorySpan`) to skip the expensive service-jobs min/max entirely.
