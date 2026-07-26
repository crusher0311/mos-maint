---
name: RO odometer freshness rule
description: Stale RO odometers (>90d) no longer read as "Current" mileage in VHI; CARFAX estimate reconciled monotonically.
---

# RO odometer freshness (amends "most-recent RO wins")

Rule: when the winning RO odometer's RO date is older than `RO_ODOMETER_FRESHNESS_DAYS` (90, in `lib/plan-build/open-ro-mileage.ts`), the CARFAX rolling estimate is ALSO computed and the LARGER of the two wins. Estimate win → labeled `carfax_estimated`; estimate missing/lower → the stale reading is projected FORWARD from its RO date at the annual fallback rate (12k/yr) and the larger of projection vs. reading wins, labeled `annual_estimated` (never presented as "Current"). Only when there is no RO date to project from is the stale reading served as-is (monotonic floor — a real odometer reading is never undercut).

Gotcha: many `tekmetric_work_orders` mirror docs carry Tekmetric's own field names (`updatedDate`/`completedDate`/`createdDate`), NOT `updatedAt`/`createdAt` — any date-based logic reading that mirror must fall back through both naming families or the RO date silently resolves null (and freshness gates never fire — that's why the HEART Lexus stayed "Current").

Cache-hit echo: the partner GET resolves the anchor BEFORE the cache lookup, and cache-hit / stale-plan-rebuilding responses overlay the freshly resolved mileage+basis onto the response (buckets/plan unchanged) so a pull inside the 4h TTL still reflects today's anchor.

**Why:** a posted RO from months ago was being served as "Current" mileage on the partner VHI (HEART Evanston Lexus case), making overdue items look current.

**How to apply:**
- The rule lives in pure helpers (`isRoOdometerStale`, `pickMileageInput().staleActual`, `reconcileStaleActualWithEstimate`) and MUST be wired identically on all three plan-cache surfaces (partner GET vhi, partner analyze POST, extension plan route) — they share one cache keyed vin+shopId+mileage±500, so a divergent rule causes cache thrash.
- Missing/invalid RO date = FRESH by design (roNumber-specific path and legacy mirrors without timestamps must not be demoted).
- The entered on-screen odometer in the extension stays top-of-waterfall and is never staleness-gated (typed today).
- The `vehicles` snapshot cannot be date-gated — it has no per-record date (frozen one-time import); that gap is separate.
