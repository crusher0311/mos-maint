---
name: Plan-cache family PG cutover
description: Durable rules for the Mongo→PG cutover of plan/analysis/recommendation caches.
---

- TTL caches in this family flip with **zero backfill**: write PG-first, fall back to Mongo on a PG miss while the shadow write is on, and let old entries age out. Only durable append-only stores need a backfill, made idempotent by keying PG rows on the Mongo `_id`.
- **Why:** copying short-lived cache rows wastes an operator window and risks Mongo saturation; a cold PG cache is acceptable because every entry is rebuildable.
- Environments can have some PG mirror tables and not others: the dev PG had the wave-3 tables but none of the wave-2 ones, because the wave-2 DDL is not mirrored in the normalized-migration apply script. Verify each target table exists in the target environment before flipping anything — schema-in-repo ≠ table-in-database.
- **How to apply:** cache invalidations/deletes must hit BOTH stores regardless of the canonical flag, or a rollback serves stale plans. Keep cache-validity rules in one shared pure function so both arms agree. Aggregation consumers must be fed pre-flattened rows (never Mongo `_id`-grouped docs) so PG and Mongo arms are interchangeable. Event inserts whose callers depend on the Mongo ObjectId return must keep awaiting the Mongo write even when PG is canonical.
