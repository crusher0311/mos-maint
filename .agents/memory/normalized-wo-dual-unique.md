---
name: normalized_work_orders has two unique keys; PG upsert only guards one
description: Why work-order ingestion 23505s — the create path must resolve by natural key first, and concurrent same-shop ingestion still races.
---

# normalized_work_orders: PK id + natural key (shop_id, work_order_number)

`normalized_work_orders` has TWO unique constraints: the primary key `id`, and
`nwo_shop_id_wo_num_idx (shop_id, work_order_number)`. The dual-writer's create
statement is `insert ... on conflict ("id") do update` — it only reconciles
conflicts on `id`. A row already present under the SAME `(shop_id,
work_order_number)` but a DIFFERENT `id` is NOT caught and throws pgCode `23505`.

**Rule:** any path that may create a work order MUST first resolve the existing
row by the natural key `(shop_id, work_order_number)` and take the update path.
Resolving only by `provenance.sourceIds` is insufficient — re-runs whose stored
provenance lacks this run's sourceId fall through to create and collide.

**Why:** this exact gap wedged the Tekmetric backfill — every re-run of an
already-ingested shop 23505'd, the dual-write rethrew, `ingestWorkOrder` returned
an error result, and the backfill chunk held its cursor, so the shop never
completed. Fixing the natural-key lookup let the backfill walk pages with
error=0 again.

**Residual race (FIXED):** the lookup-then-insert is not atomic. When the same
shop's work order is ingested concurrently (e.g. a Tekmetric webhook on the web
service overlapping backfill, or duplicate webhook delivery), both can miss the
lookup and both insert → one 23505s. Now handled inside `upsertWorkOrder`: the
insert is wrapped in try/catch; on 23505 it re-resolves the existing row by
`(shopId, workOrderNumber)` and UPDATEs by its id (single retry, no loop). If the
re-resolve finds no row it re-throws (a real 23505 with no natural-key row is a
genuine error, not a race). Verified in prod: zero work_order 23505 in a clean
post-deploy window.

**Known edge case (not currently a problem):** the natural-key value uses a
truthy fallback (`doc.workOrderNumber || String(doc._id)`), so a literal numeric
`0` work-order number would be treated as missing and substituted with `_id`.
Harmless for Tekmetric (RO numbers are never 0), but if a future source emits
falsy/`0` identifiers, switch to explicit null/empty checks + `String(...)` so the
retry select key matches the persisted value.

**Vehicle path guarded too:** `normalized_vehicles` has the SAME shape of
secondary unique index — `nv_shop_id_vin_idx (shop_id, vin)` — and `upsertVehicle`
originally only reconciled on `id`, so it had the identical 23505 race. It now
carries the same catch/retry (on 23505, re-resolve by `(shopId, vin)` and UPDATE
by id; a null VIN can't collide since PG treats NULLs as distinct, so it
re-throws). These are the ONLY two normalized tables with a secondary unique
index — customers/service_jobs/line_items/payments have just the `id` PK, so no
natural-key collision risk there.

**Protractor shares this exact path (and had the same bug):** Protractor backfill
is NOT on the Tekmetric drain-worker — it runs as an in-process node-cron on the
WEB service (new-shop fastpath re-kicking recent shops every 5 min + a stale-resume
sweep), but it ingests through the same `NormalizedIngestionService` /
`SupabaseDualWriter`, so the work_order+vehicle 23505 fixes cover it automatically.
Most of the web-service 23505s seen during the stall were actually Protractor
fastpath collisions (sourceSystem:"protractor"), not Tekmetric webhooks.

**How to apply:** when touching work-order OR vehicle ingestion or the dual-writer
create path, preserve the natural-key pre-resolution AND the 23505 catch/retry, and
keep the lookup key identical to the persisted value, or collisions return.
