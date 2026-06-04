---
name: CARFAX location id is a shop-level plan input
description: Why changing a shop's CARFAX Location ID must invalidate that shop's entire plan cache, and how all writers must funnel through one helper.
---

A shop's CARFAX Location ID is an input to **every** maintenance plan the shop
builds: plans built while CARFAX was disconnected have no service-history
anchors. So any transition of that id is a shop-wide cache event, not a per-VIN
one.

**Rule:** entering CARFAX for the first time, changing it, OR removing it must
clear the whole shop's plan cache (`cached_plans` + `maintenance_analysis_cache`)
so plans rebuild correctly on next view. Rebuild is **lazy** (clear-and-rebuild-
on-view), never an eager fanout — a shop can have hundreds of vehicles.

**Why:** Brandon added a CARFAX id to an already-running shop and its cached
plans were stale (built without CARFAX). The fix had to become standard, not a
one-off manual cache wipe.

**How to apply:**
- All CARFAX-id writers must go through `setShopCarfaxLocationId(db, shopId, loc)`
  (lib/integrations/carfax.ts), which clears on the empty->set / changed
  transition only (re-saving the same id is a no-op). Removal is handled in the
  DELETE path of the settings API route (clears when a prior id existed).
- The shared clearer is `invalidateShopPlanCache(db, shopId)` (lib/plan-cache.ts).
  It must match `shopId` as BOTH String and Number — legacy cache rows stored
  either type.
- Generalize: any future shop-level input that feeds all plans (not per-VIN)
  should funnel through one invalidating helper, never hand-rolled `updateOne`s,
  or the cache silently goes stale across the fleet.
