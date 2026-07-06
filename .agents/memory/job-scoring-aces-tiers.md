---
name: Job-search ACES tiers & ranking
description: How ACES ids feed job-search match %, why a live-decode dependency + heuristic-100 caused Great Match to outrank Exact Fit
---

# How ACES ids actually feed the job-search match %

`lib/job-scoring.ts` `scoreJob` uses ACES `vehicle_id` / `engine_id` / `submodelKey`
as **pass/fail short-circuit tiers, NOT as a graded component of the percentage**:
- Tier A: target.acesVehicleId === donor.acesVehicleId → flat 100 "Exact Fit (ACES)".
- Tier B: same engine_id, diff vehicle, powertrain systems → floor ~75 + evidence.
- Tier C: same submodelKey, diff engine, chassis systems → floor ~70 + evidence.
- Else → legacy heuristic (make/model/year/displacement + evidence), which can also reach 100.

**Live-decode dependency (the big surprise):** the tiers only fire when BOTH target
and donor have ACES ids, and those ids are **re-derived live at query time** by
decoding each vehicle's VIN squish through DataOne (`resolveDataOneSpecs` →
`batchDecodeSquishes` in `app/api/extension/jobs/search/route.ts`). The scorer does
**NOT** read the backfilled ACES columns on job records. So "the ACES backfill is
done" does NOT help this scorer — a donor with no VIN, or a DataOne miss/timeout,
silently drops to the heuristic. Making the backfill actually feed the scorer
(recognize exact-vehicle matches without a live donor VIN decode) is a real,
separate change — offered to Brandon as a follow-up option, not yet done.

**Why "Great Match" outranked "Exact Fit" (2026-07 Corolla vs Prius air filter):**
1. Heuristic gave a same-make/different-model donor a flat 100; only its *label*
   was capped to "Great Match" (band demoted when yearDiff!==0) while the *number*
   stayed 100.
2. The route sort ordered by sameVin then matchScore ONLY, so equal 100s weren't
   broken in favor of the true exact/ACES match.

**Fix shipped:** (a) when the heuristic exact band is demoted, also
cap finalScore to SCORE_THRESHOLD_EXACT-1 so a Great Match reads below a real exact
fit; (b) add a qualityRank tie-break in the route sort
(sameVin > exact_aces > heuristic-exact > engine_match > submodel_match > likely).
Same-VIN and ACES short-circuits return BEFORE the cap, so they're unaffected.
**Why:** advisors distrust the tool when a different-model donor ties/outranks the
exact vehicle. Server-side only — no extension republish needed.

**"Exact Fit" heuristic label is gated to a genuine same vehicle.** The heuristic
band label (getBandLabel) is purely a score-band bucket (>=80 "Exact Fit"), so a
same-make/**same-year but different-model** donor (e.g. Camry surfaced for a Corolla)
could tally >=80 and read "Exact Fit". Guard in `scoreJob` (just before return):
`genuineExactVehicle = sameModel && yearDiff === 0 && engineMatchOrUnknown`; if the
exact band is reached but not genuine, demote band→"likely" and cap score to 79.
So a heuristic (non-ACES/non-VIN) row only keeps "Exact Fit" when it's the same
model + exact model year + engine matching-or-irrelevant. This SUPERSEDES the earlier
off-year-only (yearDiff!==0) guard. `engineMatchOrUnknown` = engine irrelevant to the
job category, undecoded, or displacementClose. yearDiff null (missing year) ⇒ not
genuine ⇒ demoted (conservative).
**How to apply:** if asked why a same-year sibling model shows "Great Match" not
"Exact Fit", that's intended; only same-VIN/ACES or same-model+year+engine earn Exact.

**Confidence ladder — the match % now encodes the SOURCE of certainty (2026-07).**
Named consts in `job-scoring.ts` (`SCORE_VIN_MATCH=100`, `SCORE_ACES_EXACT=95`,
`SCORE_HEURISTIC_EXACT_CAP=90`). Non-overlapping bands so the score alone ranks
correctly:
- **100 "VIN Match"** — same physical car (its own history). Same-VIN fast path;
  label is "VIN Match", NOT "Exact Fit" (100 means "this exact car").
- **95 "Exact Fit (ACES)"** — different car, catalog-confirmed identical spec
  (Tier A exact_aces). Flat 95, no evidence bonus.
- **80–90 "Exact Fit"** — genuine heuristic exact (same model+year+engine, not
  VIN/ACES-confirmed), capped at 90.
- **≤79 "Great Match"** — ACES Tier B/C SIBLINGS (engine-only / submodel-only,
  always different vehicle) + all other heuristic likely. **Tier B/C finalAces is
  clamped to SCORE_THRESHOLD_EXACT-1**; without that clamp evidence bonuses
  (recent+5, same-shop+5, corroboration+6) pushed a sibling to ~91 → wrongly
  "exact"/"Exact Fit" AND out-scored a real heuristic exact (blocking bug caught
  in review).
**Why:** advisors must be able to trust that 100% = the same car and that a bigger
number = more certainty about fit. **How to apply:** any new exact-band or ACES
path must respect the ladder — never emit 100 except same-VIN, never let a
different-vehicle match reach the exact band. Route sort is matchScore-first then
qualityRank on ties (keys off sameVinFastPath flag + acesTier, NOT the label
string), so non-overlapping bands keep ordering correct.
