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

**Spec resolution is now stored-first (2026-07, Task-880 era).** Shared
`lib/job-search-specs.ts` `resolveJobSearchSpecs` (wired into BOTH search routes)
reads stored ACES ids from `job.vehicle.acesVehicleId/acesEngineId/submodelKey`
first and only live-decodes the target VIN + donors lacking stored ids — so a
DataOne miss/timeout no longer silently wipes ACES scoring for backfilled donors.
The PG mapper (`mapServiceJobToCanonicalResult`) passes the stored ids through.
The decode fn is injected (keeps it tsx-testable; dataone-local pulls in postgres).

**Ambiguous-squish gaps closed (same era):**
- Same-squish target/donor VINs → flat 95 "Exact Fit" (`exact_aces`), runs before
  the fuel gate (one shared decode ⇒ fuel disagreement is free-text noise).
- Ambiguous batch decodes attach `candidate_vehicle_ids` (dataone-local merged
  row); scorer's `candidateVehicleIds` intersection (either vid null, sets/id
  overlap) → 90 "Likely Fit" with `acesTier: null` — Exact Fit badge stays
  reserved for confirmed matches (VIN / squish / equal concrete vehicle_ids).
- Tier B no longer requires both vehicle_ids non-null (null = ambiguous is fine);
  but "general" (unclassified) donors no longer qualify for Tier B at all.

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
correctly. Brandon-approved advisor-facing LABEL ladder (both surfaces — extension
via server `matchBandLabel`, web app via `getMatchConfidenceBadge`):
- **100 "VIN Match"** — same physical car (its own history). Same-VIN fast path.
- **95 "Exact Fit"** (tooltip notes ACES/catalog-confirmed) — different car,
  Tier A exact_aces. Flat 95, no evidence bonus. (Label dropped the "(ACES)"
  jargon suffix; the code const/tier is still `exact_aces`.)
- **80–90 "Likely Fit"** — genuine heuristic near-exact (same model+year+engine,
  NOT VIN/ACES-confirmed), capped at 90. It's a strong-but-unconfirmed guess.
- **≤79 "Likely Match"** — ACES Tier B/C SIBLINGS + demoted non-genuine exact +
  all heuristic likely band. **Tier B/C finalAces clamped to
  SCORE_THRESHOLD_EXACT-1**; without that clamp evidence bonuses pushed a sibling
  to ~91 → wrongly exact.
- **35–54 "Good Match"** (possible band), **<35 "Low Confidence"**.
`getBandLabel` maps band→label: exact="Likely Fit", likely="Likely Match",
possible="Good Match", low_confidence="Low Confidence". Tier A code label is the
bare "Exact Fit". Web badge `getMatchConfidenceBadge` (lib/aces-tier-badge.ts) is
score-aware (takes optional `score`) and mirrors this ladder; still returns
"Not a match" when gatePass is false.

**Demoted-exact ordering (2026-07 fix).** A non-genuine match that tallies into the
exact band (≥80) is demoted to the "likely" band, but do NOT flat-clamp its number
to 79 — that collapses a same-model off-year donor and a different-model sibling to
the SAME 79 and destroys their order. Instead subtract a fixed offset
(`SCORE_VIN_MATCH - (SCORE_THRESHOLD_EXACT-1)` = 21, input capped at 100) that
slides the whole exact band [80..100] down to [59..79]. Pure subtraction ⇒
STRICTLY order-preserving (no bucketing/rounding ties), so any positive gap earned
above the threshold survives below it and a same-model donor still outranks a
sibling while both read below a genuine "Likely Fit". (CHANGED displayed numbers
for demoted matches from a flat 79 to an ordered 59–79.)
**Why:** advisors must trust that 100% = the same car, bigger = more certain, and
that same-model beats a different-model sibling. **How to apply:** any new
exact-band/ACES path must respect the ladder — never emit 100 except same-VIN,
never let a different-vehicle match reach the exact band, and preserve relative
order when demoting. Route sort is matchScore-first then qualityRank on ties (keys
off sameVinFastPath flag + acesTier, NOT the label string).
