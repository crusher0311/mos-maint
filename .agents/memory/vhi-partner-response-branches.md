---
name: VHI partner route has 4 response branches
description: Any per-item field added to the external/partner VHI response must be applied on ALL branches, not just the formatVhiItem call sites.
---

The external partner VHI route returns buckets from FOUR distinct branches, and only two build items via in-route `formatVhiItem(...)` calls:

- `cached_plan` — in-route `formatVhiItem` (and `buildPlanResponse`).
- `stale_plan_rebuilding` — `buildPlanResponse` (same in-route calls).
- `analysis_cache` — spreads a stored snapshot from `getVhiFromAnalysisCache`; its `buckets` are produced elsewhere, so the spread carries whatever was persisted.
- `on_demand_build` — returns `rebuildVhi(...).buckets`; `rebuildVhi`'s own `formatVhiItem` calls don't pass partner-only options.

**Why:** A partner (AppFueled) reads the per-item `iconSvg`. Adding `includeIconSvg: true` only at the in-route `formatVhiItem` call sites fixed `cached_plan`/stale but left `analysis_cache` and `on_demand_build` still emitting `null` — which were the branches the partner actually hit. The "fix" looked done but the partner still saw nulls.

**How to apply:** When adding/altering a per-item partner-facing field, normalize it at the response boundary for EVERY branch (e.g. a small idempotent helper applied to each branch's `buckets`), or thread the option through the shared producers (`getVhiFromAnalysisCache`, `rebuildVhi`) — but note those producers also feed the INTERNAL route, so prefer in-route normalization to keep scope to partners. Keep `formatVhiItem`'s default off so internal/tests are unaffected.
