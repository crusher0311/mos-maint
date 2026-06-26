---
name: VHI entered-odometer anchor
description: How the extension plan endpoint prioritizes the on-screen RO odometer for VHI mileage.
---

# VHI mileage anchor: entered on-screen odometer is top of the waterfall

The Detect Dog overlay / plan endpoint mileage waterfall order is:
entered on-screen RO odometer → cached/live WO odometer → CARFAX estimate →
stale `vehicles` snapshot → annual fallback.

The extension scrapes the on-screen odometer and forwards it to
`/api/extension/plan` as the `odometer=` query param. The content script keeps
it under a dedicated `scrapedOdometer` field because the side panel overwrites
`context.mileage` with the server-resolved value after a plan response (which
may be a CARFAX estimate) — so `scrapedOdometer` is the only field guaranteed
to still hold the real on-screen reading on a refresh.

**Why:** the entered odometer is the most dependable source (it's literally on
screen) and previously the server ignored it, falling to the CARFAX estimate
when the value hadn't reached the cache (no webhook / not subscribed / live
fetch skipped). That made the overlay disagree with the RO "In:" reading.

**How to apply:**
- Monotonicity guard: an odometer only moves forward, so an entered value
  clearly LOWER than a higher already-known reading is ignored (mis-scrape /
  typo must not regress real mileage).
- When the entered value is used, mileage is tagged `actual` (not estimated)
  and the CARFAX block is short-circuited (it only fills empty mileage).
- Cache consistency: the partner VHI endpoint + dashboard resolve their anchor
  from the Tekmetric WO mirror via `lib/plan-build/open-ro-mileage.ts`
  (`tekmetric_work_orders.odometer`), NOT from the `odometer` param. The plan
  route therefore does a fire-and-forget, monotonic mirror write of the entered
  odometer onto `tekmetric_work_orders` so all three plan-cache consumers
  converge instead of thrashing an entered-vs-estimate cache key.
- Validation bounds mirror the content script: integer, 100 < n < 1,000,000.
- Tekmetric-only so far; Protractor/Shop-Ware/AutoFlow still resolve as before.
