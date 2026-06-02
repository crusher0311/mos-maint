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

2. **Surfaces disagree on mileage → mileage-anchor cache thrash.** `getCachedPlan` only reuses a
   plan within `MILEAGE_TOLERANCE=500` mi (lib/plan-cache.ts). The extension and partner resolve
   DIFFERENT mileage for the same VIN (observed 93,980 vs 97,495, 3,515 apart), so each builds and
   caches its own plan and misses the other's — same VIN rebuilt twice in 10s at 18s and 26s. Root
   inputs: partner anchors on `vehicles.mileage`; extension on a live CARFAX rolling estimate.
   NOTE: the `vehicles` collection is keyed inconsistently (int / string / shop-ObjectId — count
   by ALL forms incl. ObjectId or you'll falsely read 0). Schindler's (shop 83) DOES have ~3,939
   vehicle docs, but mileage is FROZEN at the one-time import (all updatedAt 2026-03-17/18, zero
   refreshes since) and stored in field `mileage` (no `currentMileage`). So the partner anchors on
   a months-stale odometer while the open RO often has no odometer entered yet. This is the
   Task #476/open-RO-mileage area. Fix = unify the mileage source across both surfaces (and/or
   refresh the Tekmetric vehicles sync), not "populate missing vehicles."

   **WHY the vehicles.mileage is frozen (structural):** there is NO recurring Tekmetric vehicle
   sync. The `vehicles` collection is written for Tekmetric shops ONLY by the on-demand endpoint
   `app/api/tekmetric/sync/route.ts` (NOT in `lib/cron/jobs.cjs`'s CRON_JOBS). It ran once at
   onboarding (March) and never again. The recurring crons `tekmetric-incremental-sync` (*/30) and
   `tekmetric-backfill` (+boosts) write ONLY `tekmetric_work_orders`, never `vehicles`. So
   vehicles.mileage was never going to refresh — it's a one-time snapshot, not a stalled job.
   (Also: that writer's update path matches `{ vin }` with NO shopId → cross-shop VIN collision risk,
   and inserts key shopId = shop._id ObjectId, which is why these docs are ObjectId-keyed.)

   **The FRESH source is the work orders, not vehicles.** Odometers flow continuously into
   `tekmetric_work_orders` (shop 83: 12,069 / 15,974 WOs have odometer>0). So the durable anchor is
   "most-recent WO with odometer>0", which is always current — NOT vehicles.mileage. BUT
   `resolveOpenRoMileage` (lib/plan-build/open-ro-mileage.ts) only inspects the SINGLE most-recent
   WO and returns null if it lacks an odometer, instead of scanning back for the latest WO that has
   odometer>0. When the newest RO is an in-progress one with no miles entered yet (common), it
   needlessly discards a good earlier reading and falls back to stale vehicles.mileage.

   **Conclusion for a wholistic fix:** anchor mileage on the continuously-synced WO odometer
   (latest WO with odometer>0) consistently across extension + partner; fall back to CARFAX est,
   then stale vehicles.mileage last — same order on both surfaces. Don't try to resurrect a
   "vehicles sync"; vehicles.mileage being stale stops mattering once nobody anchors on it.

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
