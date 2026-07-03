---
name: Plan-cache degraded (oemMissing) entries
description: Plans built while the OEM/DataOne lookup timed out must not be cached as long-lived truth; the oemMissing flag pattern and its freshness-window exception.
---

**Rule:** Any plan built while the OEM/VIN-attribute lookup timed out or errored must set `plan.oemMissing = true` before `setCachedPlan`. The cache layer then stores it with a short TTL (10 min vs 4 h) and `getCachedPlan` skips it once it's older than the 30 s just-built freshness window, forcing the next load to retry the OEM fetch and overwrite the row.

**Why:** One slow DataOne moment used to poison a vehicle for 4 hours — the empty-OEM plan was cached as truth and every subsequent load skipped the OEM fetch entirely (customer report: "up to 30 minutes before VIN attributes are decided"). The 30 s exception exists because partner flows await a build then immediately re-read the cache; skipping the just-built row would break `cacheReadAfterBuild`.

**How to apply:** Every plan writer (dashboard plan page, `/api/plan-build`) must compute the flag from `oemData.ok === false && oemData.error` — a legitimately empty schedule (`ok: true, count 0`) is NOT degraded and caches normally. If a new plan-build path is added, it must set the flag the same way or it reintroduces the poisoning. Detection relies on the timeout fallback objects carrying `ok:false, error:'timeout'` — don't strip those markers.

Related gotcha fixed at the same time: `Promise.race` timeout timers in the plan-build/extension OEM and CARFAX races must be cancelled via `.finally(clearTimeout)` on the real promise, or the timeout warn line fires on every build (~146/hr of spurious "[PlanBuild] DataOne timeout") and drowns real stalls.

Slow dashboard plan loads are recorded again via `[PlanSlowLoad]` structured warn + `slow_plan_load_logs` Mongo inserts (no index created from dev — dev Mongo is prod).
