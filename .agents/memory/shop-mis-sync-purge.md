---
name: Purging a shop's mis-synced provider data
description: How a wrong integration connection ingests another business's data, and how to safely disconnect + purge it across PG + Mongo.
---

# Wrong integration connection → mis-synced data

Multiple MOS shops can point at the SAME provider account (e.g. two shops both
configured with `tekmetric.shopId=6886`). A mis-connected shop then syncs another
business's customers/vehicles/ROs under the wrong internal `shopId`. The correct
owner usually already has its own shop with the same data — so the wrong copy is
redundant and safe to delete (verify the real owner's copy first).

**Why:** seen when one shop was pointed at another business's Tekmetric account
while that business already had its own correctly-connected shop. Symptoms:
connected-box shows the wrong shop name + an untrustworthy vehicle count, and the
shop's geo comes from the provider API (wrong state) instead of the real shop.

## Purge procedure (operator-only, prod-live data)

1. **Disconnect FIRST to stop inflow.** The cron sync is still actively writing
   (row counts grow between reads). On the Mongo `shops` doc: `$unset` the
   `tekmetric` subdoc + `tekmetricBackfill*` fields + provider-sourced `geo`, and
   `$set` `integrationProvider` to the shop's real provider (e.g. `autoflow`).
   Delete its `tekmetric_backfill_progress` doc so the sweep won't resume.
   **Why:** if you purge before disconnecting, new rows keep arriving.
   Note: the app's tekmetric DELETE route is shallow — it only `$unset`s the
   `tekmetric` subdoc; it does NOT clear `integrationProvider` or any synced data.

2. **Purge by REFERENCE in FK dependency order, not by child.shop_id.**
   normalized child rows (`normalized_service_jobs`, `normalized_line_items`,
   `normalized_payments`) can be keyed to their parent `work_order_id` while their
   own `shop_id` is 0/unset — so `WHERE shop_id=16` misses them and you hit FK
   violations. Delete children via `... IN (SELECT id FROM normalized_work_orders
   WHERE shop_id=N)` / service_jobs, then parents (work_orders → vehicles →
   customers). FK graph: line_items→(service_jobs, work_orders), payments→work_orders,
   service_jobs→work_orders.

3. **`normalized_line_items` is huge (~12M rows / 28GB).** A single DELETE with an
   `OR` across two IN-subqueries defeats the indexes and seq-scans the whole table
   → statement timeout. Split into separate index-friendly DELETEs (`service_job_id`
   and `work_order_id` are both indexed: `nli_service_job_id_idx`, `nli_work_order_id_idx`).

4. **Mongo per-shop stores to clear:** `job_index`, `cached_plans`,
   `tekmetric_backfill_progress`, `tekmetric_jobs_cache` (shopId can be number OR
   string — use `{$in:[N,"N"]}`); `tekmetric_webhook_subscriptions` keyed by
   `mosShopId` (string).

## Execution notes
normalized tables live in `DATAONE_DATABASE_URL` (not default `DATABASE_URL`).
Big deletes exceed the 120s shell wall — chunk them across separate calls, set a
PG `statement_timeout`, and verify with count-after.
