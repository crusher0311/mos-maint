---
name: Triage read-path quirks
description: Field/index gotchas hit when building read-only diagnostics over the ingestion chain.
---

- `job_index` docs carry NO indexedAt/createdAt — insertion recency must come
  from the `_id` ObjectId timestamp (`_id.getTimestamp()`); sorting on a
  nonexistent field silently returns an arbitrary doc. Source system lives at
  `metadata.sourceSystem`, not top-level.
- The Mongo `normalized_work_orders` mirror is effectively unindexed for
  `$or:[{shopId},{shop_id}]` — such a count COLLSCANs and hangs for minutes.
  **How to apply:** diagnostics must bound every count/find with `maxTimeMS`
  and degrade to "timed out" instead of hanging.
- `requirePlatformAdmin()` denies via `redirect()` (throws NEXT_REDIRECT); an
  admin API route with a blanket try/catch converts the redirect into a 500
  JSON — rethrow when `error.digest` starts with `NEXT_REDIRECT`.
