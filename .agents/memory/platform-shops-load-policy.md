---
name: Platform All Shops load policy
description: Bound optional fleet admin work without narrowing fleet-wide actions.
---
All Shops must not automatically load detailed statistics for the whole fleet.
Keep search/filter and bulk-action membership fleet-wide even when rendering only a page.

**Why:** The user requested faster admin loading without competing with customer operations during a shared-database slowdown. Pagination must not silently change who receives a bulk operation.

**How to apply:** Keep billing/edit authority fresh, tolerate explicitly labeled cached informational statistics, limit optional query concurrency and wait queues, and fail unavailable rather than showing false zeroes or executing stale bulk selections. Process-local limits multiply with deployed replicas; they are not a cluster-wide workload guarantee.
