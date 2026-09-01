---
name: Mongo update path conflicts
description: MongoDB rejects updates that target the same path through multiple update operators.
---

Do not include the same field in both `$set` and `$setOnInsert` in one MongoDB update, even when both values are identical. MongoDB rejects the whole operation as a conflicting update path.

**Why:** Lightweight in-memory Mongo fakes often merge the two objects and pass, while the real server rejects the operation at runtime.

**How to apply:** For upserts, put fields needed on every write in `$set` and reserve `$setOnInsert` for insert-only fields such as `createdAt`. Include an integration-realistic check when changing update-operator composition.