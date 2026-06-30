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

## Icons

The response carries **two independent** icon systems. Do not confuse them.

### Status icons (`iconStatus` / top-level `icons`)

The red/amber/green/blue **status** indicator — i.e. is this item overdue,
due soon, OK, or deferred.

- Each VHI item has `iconStatus` (`"overdue" | "soon" | "ok" | "deferred"`).
- Each VHI item also has `iconSvg`: the inline status SVG for that item's
  `iconStatus`, ready to drop straight into the DOM. This is populated on all
  partner response branches.
- The top-level `icons` map is `iconStatus -> inline SVG`. It is equivalent to
  `iconSvg` (same artwork) — use whichever is more convenient: the per-item
  `iconSvg`, or look the item's `iconStatus` up in the `icons` map.

### Service icons (`serviceIconKey` / top-level `serviceIcons`) — Task #675

The per-service **pictogram** — i.e. the oil drop, differential, cabin air
filter, brake, etc. — the same artwork our customer-facing VHI shows.

- Each VHI item has `serviceIconKey` (e.g. `"oil_change"`,
  `"differential_rear"`, `"cabin_air_filter"`). It is resolved from the
  item's `serviceKey`/`title` using the exact same logic as our UI, and is
  always a real key (unmatched items fall back to `"general_service"`), so it
  never resolves to a missing icon.
- The top-level `serviceIcons` map is `serviceIconKey -> inline SVG markup`,
  emitted once per response (not duplicated on every item). Look up the item's
  `serviceIconKey` there to render the pictogram. The map always includes
  `"general_service"` (the default fallback) and `"dvi_finding"` (the
  inspection-finding warning triangle).
- The SVG is self-contained inline markup (our relative
  `/icons/service/*.svg` paths do **not** resolve on a partner's domain), so
  drop it straight into the DOM or a `data:image/svg+xml` URI.
- Each VHI item also has **`serviceIconUrl`**: an absolute, publicly reachable
  URL to that pictogram's artwork (e.g.
  `https://mos.tools/icons/service/oil_change.svg`). Save this URL in your DB
  and render it with `<img src="…">` instead of storing the inline SVG — it is
  much smaller. Always populated (falls back to the general-service icon), and
  populated on all partner response branches. Prefer `serviceIconUrl` over
  `serviceIcons[serviceIconKey]` when you want to keep your stored payload
  small; the inline `serviceIcons` map remains available for now.

Present on all response branches (`source: "cached_plan"`, `"analysis_cache"`,
`"on_demand_build"`, and the stale-serve path).

### Item description (`detail`) — Task #730

Each VHI item also carries a **`detail`** string: a short, human-readable
description suitable for showing under the item title. Use this for the
"Details" line instead of the raw `bump` status color.

- For a **DVI inspection finding** it is the technician's note when one was
  provided; when the inspection sent only a status color and no note, `detail`
  is a derived phrase built from the finding name plus a plain-language
  condition — `"<finding> — Needs attention"` for a red finding,
  `"<finding> — Monitor"` for a yellow one. It is **never** the bare
  `"red"`/`"yellow"` color.
- For non-DVI items with nothing extra to add, `detail` is `null` — keep your
  existing interval-based copy in that case.

Populated on all response branches (cached snapshots that predate the field are
backfilled on read). The same icon resolver and `detail` logic feed both this
partner API and our customer-facing Vehicle Health Report, so the two stay in
lockstep.
