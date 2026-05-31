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

**Residual race (not yet fixed):** the lookup-then-insert is not atomic. When
the same shop's work order is ingested concurrently (e.g. a Tekmetric webhook on
the web service overlapping backfill, or duplicate webhook delivery), both can
miss the lookup and both insert → one 23505s. This is low-volume, does NOT stall
anything (webhooks don't hold a cursor), and self-heals on the next backfill
sweep (which re-resolves and updates). To eliminate it, the create path needs to
catch 23505 and retry as a natural-key update (or upsert on the natural key).

**How to apply:** when touching work-order ingestion or the dual-writer create
path, preserve the natural-key pre-resolution and keep the lookup key identical
to the persisted `work_order_number` value, or collisions return.
