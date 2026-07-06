---
name: Recovered history vs stale plan cache ("still shows CARFAX")
description: Why a re-filed/recovered shop visit keeps showing CARFAX as "Last done" after recovery, and why it self-heals.
---

After a history recovery/re-file, a vehicle's VHI/plan "Last done" badge can keep
showing **CARFAX** instead of the shop even though the shop now has the same visit.

**Root cause: stale `cached_plans` (4h TTL), NOT a logic bug.**
- The plan/VHI view (dashboard `/dashboard/vehicles/[vin]/plan` and the Detect Dog
  extension VHI overlay) is computed server-side by `triage()` and cached ~4h.
- A **server deploy does NOT clear `cached_plans`** — the CARFAX label persists
  until the entry expires (≤4h) or is busted for that VIN.

**Why the logic itself is correct (credits the shop):**
- Recovered `job_index` rows carry the visit date under **`performedAt`** only —
  NOT `closedDate`/`completedAt`/`indexedAt` (those are absent on re-filed rows).
- Both readers include `performedAt` in their date fallback chain
  (`closedDate||closedAt||performedAt||completedAt||indexedAt`):
  `lib/last-performed.ts` (job-search "last performed" line) and the plan-build
  job_index fallback in `app/api/plan-build/route.ts`. So the shop record gets a
  real date + miles.
- In `triage()` shop history is loaded FIRST as `source:"shop"`; each CARFAX
  record that matches an existing shop record via `isMatchingHistory` (miles within
  tolerance AND date within a few days) is skipped → shop wins. On a same-day tie
  the shop (loaded first) is kept. So once the plan rebuilds with the recovered
  rows, "Last done" flips to the shop automatically.

**How to apply:** If someone reports "still shows CARFAX after we recovered the
history," first confirm the recovered `job_index` rows exist for that shopId+VIN
with `performedAt` + `mileage` (safe: exact-uppercase VIN + shopId, never a VIN
`$regex` — that COLLSCANs shared prod Mongo). If they do, it's just the 4h plan
cache; it self-heals or can be busted per-VIN. Don't "fix" the source-labeling.
