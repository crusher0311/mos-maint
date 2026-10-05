---
name: Mongo update path conflicts
description: MongoDB rejects updates that target the same path through multiple update operators.
---

Do not include the same field in both `$set` and `$setOnInsert` in one MongoDB update, even when both values are identical. MongoDB rejects the whole operation as a conflicting update path.

**Why:** Lightweight in-memory Mongo fakes often merge the two objects and pass, while the real server rejects the operation at runtime.

**How to apply:** For upserts, put fields needed on every write in `$set` and reserve `$setOnInsert` for insert-only fields such as `createdAt`. Include an integration-realistic check when changing update-operator composition.

Mongo concurrency fakes must also throw duplicate-key errors when an upsert's predicate misses but its `_id` already exists; they must not replace that document.

**Why:** Replacing it in a fake makes valid compare-and-swap receipt ordering appear broken and hides the real lease-contention path. Insert-only operators must likewise run only on inserts.

**How to apply:** Test initial-upsert races and expired-lease takeover with faithful uniqueness/operator semantics before changing the production state machine to satisfy a fake.