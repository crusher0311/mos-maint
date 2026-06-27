---
name: VHI score model (proportional)
description: How the Vehicle Health score is computed and the invariants that keep every surface in agreement.
---

The VHI numeric score is a **proportional, severity-weighted ratio**, NOT a fixed
100-minus-points subtraction. It lives in `computeScore` (canonical: `lib/vhi-score.ts`)
and is mirrored client-side in `components/vehicle-health-report/VehicleHealthReport.tsx`.

**Model:** denominator = every applicable item (overdue + due-soon + upcoming,
excluding complimentary), each weighted by `categoryMultiplier`. Each item adds a
state factor (overdue heaviest, due-soon ~0.4, healthy 0; +bonuses for red bump /
declined). `ratio = penalty / maxPenalty` where maxPenalty assumes every applicable
item at its worst. `score = 100 - (100 - SOFT_FLOOR) * ratio^CURVE_EXP`.

**Why:** the old model bottomed out at exactly 0 for neglected vehicles, which read
like a broken tool rather than "this car is in rough shape" (Task #678).

**Invariants (break any → surfaces disagree or score reads wrong):**
- The two copies (server + VHR mirror) MUST stay in lockstep — same constants. The
  VHR mirror additionally excludes customer-`approvedServiceKeys` items.
- Pass the `upcoming` bucket. Omitting it shrinks the denominator → pessimistically
  low score. All real callers pass `separateComplimentary(...)` output which includes it.
- Soft floor (12) means the worst realistic vehicle ≈ teens, NEVER 0 for a scoreable
  vehicle. Zero-applicable / only-upcoming → 100.
- "Insufficient Service History" (gray "?") is a SEPARATE concern via `dataQuality` /
  `buildApiScore` — do not conflate it with a low score. Untouched by the score math.
- Tier thresholds (`getScoreTier`, 90/80/70/60) + gauge are unchanged; all bands stay
  reachable under the new distribution.
- Pinned in `tests/vhi-score-snapshot.smoke.ts` (`npm run test:vhi-score-snapshot`).
