# Partner VHI API

`GET /api/external/vehicles/{vin}/vhi`

Returns the Vehicle Health Indicator (VHI) plan for a VIN. The endpoint is
authenticated with a partner API key tied to a specific shop.

## Mileage resolution (Task #476)

The plan engine is mileage-sensitive — the same VIN with two different
input odometers can produce different overdue ordering. To keep AppFueled
(powered by Detect Dog) in lockstep with the Detect Dog Chrome overlay,
the endpoint resolves current mileage in this order:

1. **Most-recent RO odometer (`mileageInputSource: "open_ro"`)** — pulled
   from the shop's SMS mirror (Tekmetric / Shop-Ware / Protractor) or
   from the unified `normalized_work_orders` table (AutoFlow). Uses the
   most recent row by `updatedAt`, matching the same recency convention
   the Detect Dog overlay reads from.
2. **`vehicles.currentMileage` (`mileageInputSource: "vehicles_collection"`)** —
   the snapshot fed by CARFAX + last-known SMS state. Used when no open
   RO is available, or when its odometer is lower than the snapshot (an
   odometer is monotonic, so the smaller value is by definition stale).
3. **CARFAX-estimated rolling projection (`mileageInputSource: "carfax_estimated"`)** —
   only when neither source above has a usable reading.
4. **Annual fallback (`mileageInputSource: "annual_estimated"`)** —
   `(currentYear - modelYear) * 12,000`, clamped to [12k, 250k].

### Response field: `mileageInputSource`

| Value                  | Meaning                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `"open_ro"`            | Pulled from the most-recent RO on the shop's SMS.                   |
| `"vehicles_collection"`| Pulled from `vehicles.currentMileage` (or a snapshot-derived cache).|
| `"carfax_estimated"`   | Estimated from CARFAX service history projection.                   |
| `"annual_estimated"`   | Fallback model-year × 12,000 mi/yr estimate.                        |

Distinct from `mileageSource` (Task #384), which says whether the value
itself is actual vs. estimated. `mileageInputSource` answers "where did
this actual reading come from?".

Always present on all three response branches (`source: "cached_plan"`,
`"analysis_cache"`, `"on_demand_build"`).

### Cache invalidation

Cached plans are keyed by VIN + shop + mileage tolerance
(`MILEAGE_TOLERANCE` in `lib/plan-cache.ts`, currently 500 mi). When the
open-RO path bumps the effective mileage past tolerance, the cache misses
and a fresh plan is built — so a call that resolves to 111,961 mi from
an open RO does NOT return a previously-cached plan computed at 105,266.

### Observability

Every request emits a single structured log line:

```
[PartnerVHI] mileage_resolved requestId=... partnerId=... shopId=... vin=... mileage=... mileageInputSource=... openRoMiles=... vehiclesDocMiles=...
```

so the next "AppFueled and Detect Dog disagree" report is greppable in
BetterStack within a minute.
