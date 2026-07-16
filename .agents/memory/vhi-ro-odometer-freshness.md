---
name: RO odometer freshness rule
description: Stale RO odometers (>90d) no longer read as "Current" mileage in VHI; CARFAX estimate reconciled monotonically.
---

# RO odometer freshness (amends "most-recent RO wins")

Rule: when the winning RO odometer's RO date is older than `RO_ODOMETER_FRESHNESS_DAYS` (90, in `lib/plan-build/open-ro-mileage.ts`), the CARFAX rolling estimate is ALSO computed and the LARGER of the two wins. Estimate win → labeled `carfax_estimated`; estimate missing/lower → stale reading still served (monotonic floor — a real odometer reading is never undercut).

**Why:** a posted RO from months ago was being served as "Current" mileage on the partner VHI (HEART Evanston Lexus case), making overdue items look current.

**How to apply:**
- The rule lives in pure helpers (`isRoOdometerStale`, `pickMileageInput().staleActual`, `reconcileStaleActualWithEstimate`) and MUST be wired identically on all three plan-cache surfaces (partner GET vhi, partner analyze POST, extension plan route) — they share one cache keyed vin+shopId+mileage±500, so a divergent rule causes cache thrash.
- Missing/invalid RO date = FRESH by design (roNumber-specific path and legacy mirrors without timestamps must not be demoted).
- The entered on-screen odometer in the extension stays top-of-waterfall and is never staleness-gated (typed today).
- The `vehicles` snapshot cannot be date-gated — it has no per-record date (frozen one-time import); that gap is separate.
