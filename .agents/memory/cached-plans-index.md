---
name: cached_plans lookup index
description: Plan-cache lookups need a compound index; creating it is operator-gated
---
The plan-cache (`cached_plans`) and fast-VHI (`maintenance_analysis_cache`) lookups are collection scans until their compound indexes exist. Definitions live in `scripts/ensure-indexes.ts` (vin + shopId + createdAt desc for cached_plans).

**Why operator-gated:** dev Mongo IS the prod cluster — running createIndex from any environment hits production live. Apply only as a deliberate off-peak prod operator action.

**How to apply:** operator runs the ensure-indexes script during a quiet window. No data migration needed: the `$in: [String(shopId), Number(shopId)]` legacy-variant match stays index-eligible under the compound index.
