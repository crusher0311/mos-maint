---
name: Extension plan route two build branches
description: The extension VHI plan API has two independent plan builders; per-item flags must be wired into BOTH plus the analysis-cache schema bump.
---

The extension plan API (`/api/extension/plan`) serves a plan from TWO independent builders:

1. **Dashboard cached-plan branch** — `getCachedPlan` (Mongo `cached_plans`, built by the dashboard plan-build route via `lib/plan-build/triage.ts`). Items pass through `convertCachedPlanItemForSidePanel`.
2. **On-demand branch** — `runOnDemandAnalysis` inside the extension route itself (own OEM/CARFAX/DVI logic, caches into `maintenance_analysis_cache`). This is the COMMON case for extension-only shops whose vehicles are never opened on the dashboard.

**The rule:** any per-item feature added to triage (declined badges, engine risk, etc.) must be wired into BOTH branches, AND:
- carried through the on-demand response item builder (the big `item = {...}` near the end of `_GET`), and
- `ANALYSIS_CACHE_SCHEMA_VERSION` bumped so stale `maintenance_analysis_cache` rows rebuild.

**Why:** Task #808 added Tekmetric declined jobs only to triage; extension-only shops (e.g. Oneway) never saw them despite correct data — data was in `job_index` (`authorized:false`), extension version was fine, but the on-demand builder never fetched it.

**Also:** the on-demand builder runs under the Task #196 fake-mongo smoke test via `__deps.getDb`. Any repository call added there must accept the route's `db` (dbOverride) — a repo opening its own real Mongo connection makes the smoke test process hang forever, which would hang the Render prebuild.

Second instance of this class (July 2026): standalone "DVI Finding" recs in the on-demand builder were pushed WITHOUT `serviceKey`, so the later declined-jobs merge (which matches by serviceKey) could never group a declined job into its DVI card — duplicate cards (e.g. "Control Arms" DVI + "Remove & Replace Suspension Control Arm" declined). The cached-plan/triage path carried the key and grouped fine. Rule: every rec pushed in the on-demand builder must carry `serviceKey` when a canonical key exists, and any new merge keyed on a rec field needs that field present in BOTH branches. Schema bump required to flush cached analyses.
