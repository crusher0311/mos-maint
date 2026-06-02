---
name: Partner/AppFueled VHI latency vs extension
description: Why the partner (AppFueled) VHI endpoint is slow (1-2 min) while the Detect Dog extension is fast for the same shop.
---

# Partner (AppFueled) VHI latency

For the SAME vin/shop, the Detect Dog extension returns ~1s but the AppFueled partner
endpoint can take 18s–2min. Three compounding causes (observed shop 83 Schindler's, 2026-06-02):

1. **Partner endpoint has NO upstream-timeout/fallback.** `app/api/extension/plan/route.ts`
   wraps slow upstreams in `withUpstreamTimeout` and returns a fast cached/partial fallback
   (`FALLBACK_RETURN total=1106ms`). The partner route `app/api/external/vehicles/[vin]/vhi/route.ts`
   does NOT — it `await rebuildVhi(...)` synchronously and blocks the whole request
   (responseTimeMS=19437 on a single trace). Same gap as the dashboard plan page
   (see vhi-dashboard-hang-observability.md).

2. **`vehicles=0` shops → mileage-anchor cache thrash.** Some Tekmetric shops have ZERO docs
   in the `vehicles` collection, so mileage is re-derived per request from disagreeing sources
   (open-RO odometer vs CARFAX estimate vs annual estimate). `getCachedPlan` only reuses a plan
   within `MILEAGE_TOLERANCE=500` mi (lib/plan-cache.ts); when sources differ by thousands
   (e.g. 93,980 vs 97,495) every load MISSES and rebuilds. Same VIN rebuilt twice in 10s at two
   mileages, 18s and 26s. This is the Task #476/open-RO-mileage area.

3. **Each rebuild is genuinely slow (~18-26s).** `[PlanBuild] DataOne timeout ... continuing
   without OEM data` fires repeatedly (DataOne OEM decode timing out), plus CARFAX + Tekmetric
   calls, and busy shops compete for the shared Tekmetric 10 RPS key (see
   backfill-completion-tracking.md).

**Highest-leverage fix:** give the partner endpoint the same `withUpstreamTimeout` fast-fallback
the extension has (serve cached/partial immediately, rebuild async) — biggest perceived-speed win.
Then stabilize the mileage anchor (consistent source / wider tolerance) to stop the rebuild thrash.
Both are prod, partner-facing — ask before changing.

**How to trace:** Better Stack, filter host `mos-maintenance-mvp-main`, grep the VIN — look for
`[Extension Plan] TIMING`, `[VHI Rebuild] TIMING`, `[PlanBuild] ... in NNNNms`, and the
`responseTimeMS` on `/api/external/vehicles/.../vhi` vs `/api/extension/plan`.
