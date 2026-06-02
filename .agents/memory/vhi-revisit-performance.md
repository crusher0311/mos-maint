---
name: VHI/Plan revisit performance model
description: Why the Vehicle Health (VHI/Plan) view wasn't instant on revisit, and the invariants that keep it fast on the extension + dashboard.
---

# VHI/Plan "instant on revisit"

There is NO WebSocket / push. "Fast" = server-side cached plan (Mongo `cached_plans`,
~4h TTL, keyed by VIN+shop+mileage-tolerance) + client-side reuse. A plain cache HIT
was historically NOT milliseconds because each surface still did extra work per view.

## Extension (mos-tools-extension/sidepanel.js)
- The side panel had **no client memory**: every tab switch (Jobs↔Plan) and RO
  re-open re-called `/api/extension/plan` over the network → spinner each time.
  Fix: in-memory stale-while-revalidate cache keyed `shopId::roId` (paint cached
  instantly, refresh in background; refresh button / `PLAN_REFRESH_NEEDED` force-bypass).
- **Snap-back gotcha:** the SMS page re-fires the *same* RO context frequently and
  harmlessly. `updateContext` used to force `switchTab(RO_INDEPENDENT_TABS[0])`
  ('rates') whenever roChanged===false on an RO-dependent tab — yanking the user
  off Plan/Jobs. Rule: only fall back to an RO-independent tab when there is
  genuinely **no** `context.roId`; otherwise stay put.
- **Stale-response guard must key on `roId + shopId`** (not roId alone) — roIds
  collide across shops/providers, so a late response could paint the wrong vehicle.

## Dashboard (app/dashboard/vehicles/[vin]/plan/page.tsx)
- It's a `force-dynamic` Suspense server component: every nav re-runs `PlanContent`
  while `PlanLoading` shows. On a plan-cache HIT it already skips DVI/CARFAX/OEM,
  but it used to still make **two live Protractor round-trips** (vehicle + deferred
  work) on the critical path — the real reason a "hit" took seconds for Protractor shops.
- `protractorVehicleResult` is used ONLY to gate the deferred-work fetch. So on a
  cache hit, skip the live Protractor vehicle call and let deferred work fall back
  to `cachedPlan.plan.deferredWork`.
- **Invariant:** the plan cache must actually store `deferredWork` (write it into
  `planData` in `setCachedPlan`, from the freshly-fetched live data on a cache MISS),
  or Protractor shops lose deferred work on every hit. Tradeoff: deferred work on a
  hit can be as stale as the plan-cache TTL; `?refresh=1` takes the miss path = fresh.

**Why:** these are the non-obvious "a cache hit still does live work" traps; the fix
is to make each surface reuse what it already has instead of re-fetching per view.
